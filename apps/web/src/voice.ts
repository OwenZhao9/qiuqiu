/**
 * 端到端实时语音会话。契约 § 1 的 `POST /voice/session` + `WS /voice/stream`。
 *
 * 三件事：采麦克风推上去、播回来的音频、听到打断就停播。
 *
 * **采样率两头不一样**：上行固定 16k（模型只认这个），下行 24k。浏览器的
 * `AudioContext` 不保证给你 16k，所以自己降采样，不能指望 `sampleRate` 参数。
 *
 * **打断**是这条链路相对级联的主要优势。服务端听到用户首字就发 `interrupt`，
 * 收到就把已缓冲的音频全部丢掉——不丢的话模型已经停了，用户还在听旧的那句，
 * 比不能打断更糟。
 */

import { doFetch, apiBase } from './api.js';

/** 模型只认 16k 单声道 int16。 */
export const UPLINK_RATE = 16000;
/** 文档建议 20ms 一包，16k int16 下就是 640 字节。 */
const CHUNK_MS = 20;

/** 通话过程中丘丘处在哪一段。 */
export type VoicePhase = 'listening' | 'thinking' | 'speaking';

export interface VoiceHandlers {
  /** 识别中的用户话，会不断刷新。 */
  onPartial?(text: string): void;
  /** 定稿的一句，`role` 分是谁说的。 */
  onFinal?(role: 'user' | 'assistant', text: string): void;
  /** 播放音量，喂给丘丘驱动发声脉动。 */
  onLevel?(rms: number): void;
  /** 模型说完一轮。 */
  onTurnEnd?(): void;
  /** 听 / 想 / 说变了。只在变的时候来一次。 */
  onPhase?(phase: VoicePhase): void;
  onError?(code: string, message: string, hint: string): void;
  onClosed?(): void;
}

/**
 * 一帧引起的段落变化；没变化返回 `null`。
 *
 * 端到端链路的帧里没有「现在轮到谁」这个字段，只能推：用户这句定稿了就是模型在想，
 * 第一帧音频出来就是在说，说完或者被打断就回到听。整通电话如果只报一个 `listening`，
 * 丘丘从头到尾一个表情——它在想、在说，脸上都得看得出来。
 *
 * 中间那一下 `thinking` 不是凑数：状态机里 `listening → speaking` 是挡着的
 * （`design/state-machine.md` § 2），必须经过 thinking，而这也正是实情——
 * 模型在组织第一个字。
 */
export function nextPhase(
  current: VoicePhase,
  frame: { type: string; role?: unknown }
): VoicePhase | null {
  let next: VoicePhase | null = null;
  if (frame.type === 'final' && frame.role !== 'assistant') next = 'thinking';
  else if (frame.type === 'audio') next = 'speaking';
  else if (frame.type === 'turn_end' || frame.type === 'interrupt') next = 'listening';
  return next === null || next === current ? null : next;
}

export interface VoiceSession {
  /** 挂断：停麦克风、停播放、关连接。 */
  stop(): void;
  /** 会话真正结束时 resolve。 */
  finished: Promise<void>;
}

/** 线性插值降采样到 16k。浏览器给的采样率通常是 44.1k 或 48k。 */
export function downsample(input: Float32Array, from: number, to: number): Int16Array {
  if (from === to) return floatToPcm16(input);
  const ratio = from / to;
  const out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const pos = i * ratio;
    const low = Math.floor(pos);
    const high = Math.min(low + 1, input.length - 1);
    const t = pos - low;
    const value = input[low] * (1 - t) + input[high] * t;
    out[i] = clampPcm(value);
  }
  return out;
}

function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) out[i] = clampPcm(input[i]);
  return out;
}

function clampPcm(v: number): number {
  const s = Math.max(-1, Math.min(1, v));
  return s < 0 ? s * 0x8000 : s * 0x7fff;
}

function base64ToPcm16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  // 字节数是奇数时丢掉半个采样，别让整个缓冲错位
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

function wsUrl(voiceSessionId: string): string {
  const base = apiBase();
  const abs = base.startsWith('http')
    ? base
    : (globalThis.location?.origin ?? 'http://127.0.0.1:8000') + base;
  return (
    abs.replace(/^http/, 'ws') +
    '/voice/stream?voice_session_id=' +
    encodeURIComponent(voiceSessionId)
  );
}

/**
 * 开一次语音会话。返回后立刻开始收音。
 *
 * 失败一律走 `onError` 再 `stop()`，不抛——调用方是按钮的事件处理器，
 * 抛出去只会变成未捕获的 Promise 拒绝。
 */
export async function startVoice(handlers: VoiceHandlers = {}): Promise<VoiceSession> {
  let stopped = false;
  let ws: WebSocket | null = null;
  let phase: VoicePhase = 'listening';
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let playCtx: AudioContext | null = null;
  /** 下一段音频该从什么时候开始播。保证连续，不然会有咔哒声。 */
  let playAt = 0;
  const sources = new Set<AudioBufferSourceNode>();
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>((r) => {
    resolveFinished = r;
  });

  function fail(code: string, message: string, hint: string): void {
    handlers.onError?.(code, message, hint);
    stop();
  }

  function stopPlayback(): void {
    for (const src of sources) {
      try {
        src.stop();
      } catch {
        /* 已经停了 */
      }
    }
    sources.clear();
    playAt = 0;
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    stopPlayback();
    stream?.getTracks().forEach((t) => t.stop());
    void ctx?.close().catch(() => {});
    void playCtx?.close().catch(() => {});
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
    handlers.onClosed?.();
    resolveFinished();
  }

  // 1) 拿麦克风。用户拒绝授权是最常见的失败，要给能看懂的话
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    });
  } catch (err) {
    fail(
      'voice.mic_denied',
      '拿不到麦克风：' + (err instanceof Error ? err.message : String(err)),
      '浏览器地址栏左边的图标里允许麦克风，然后再按一次。'
    );
    return { stop, finished };
  }

  // 2) 开会话，后端按 VOICE_MODE 决定走哪条链路
  let voiceSessionId: string;
  let mode: string;
  try {
    const res = await doFetch('/voice/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: 'default' })
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: { code?: string; message?: string; hint?: string };
      };
      fail(
        body.error?.code ?? 'voice.session_failed',
        body.error?.message ?? '开不了语音会话',
        body.error?.hint ?? '看后端日志'
      );
      return { stop, finished };
    }
    const body = (await res.json()) as { voice_session_id: string; mode: string };
    voiceSessionId = body.voice_session_id;
    mode = body.mode;
  } catch (err) {
    fail(
      'voice.session_unreachable',
      '连不上后端：' + (err instanceof Error ? err.message : String(err)),
      '确认后端已经起来'
    );
    return { stop, finished };
  }

  if (mode !== 'realtime') {
    fail(
      'voice.cascade_not_ready',
      '当前是级联模式，本项目只实现了端到端实时语音。',
      '把 .env 的 VOICE_MODE 改成 realtime 再重启后端，就能用端到端语音。'
    );
    return { stop, finished };
  }

  // 3) 连 WS
  ws = new WebSocket(wsUrl(voiceSessionId));
  ws.binaryType = 'arraybuffer';
  handlers.onPhase?.('listening');

  playCtx = new AudioContext();

  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data !== 'string') return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(e.data) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(frame.type ?? '');

    const moved = nextPhase(phase, { type, role: frame.role });
    if (moved) {
      phase = moved;
      handlers.onPhase?.(moved);
    }

    if (type === 'audio' && typeof frame.pcm_b64 === 'string') {
      play(base64ToPcm16(frame.pcm_b64), Number(frame.sample_rate) || 24000);
      if (typeof frame.rms === 'number') handlers.onLevel?.(frame.rms);
      return;
    }
    if (type === 'partial') {
      handlers.onPartial?.(String(frame.text ?? ''));
      return;
    }
    if (type === 'final') {
      const role = frame.role === 'assistant' ? 'assistant' : 'user';
      handlers.onFinal?.(role, String(frame.text ?? ''));
      return;
    }
    if (type === 'interrupt') {
      // 用户开口了：把已缓冲的音频全丢掉。模型那边已经停了，
      // 不丢的话用户还在听上一句，比不能打断更糟
      stopPlayback();
      return;
    }
    if (type === 'turn_end') {
      handlers.onTurnEnd?.();
      return;
    }
    if (type === 'error') {
      fail(
        String(frame.code ?? 'voice.stream_error'),
        String(frame.message ?? '语音链路出错'),
        String(frame.hint ?? '重连一次')
      );
    }
  };

  ws.onerror = () =>
    fail('voice.ws_error', '语音连接断了', '按一次「按住说话」重连；持续失败看后端日志');
  ws.onclose = () => stop();

  function play(pcm: Int16Array, rate: number): void {
    if (!playCtx || stopped || pcm.length === 0) return;
    const buf = playCtx.createBuffer(1, pcm.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) ch[i] = pcm[i] / 0x8000;
    const src = playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(playCtx.destination);
    // 排队播，接在上一段后面，中间不留缝
    playAt = Math.max(playAt, playCtx.currentTime);
    src.start(playAt);
    playAt += buf.duration;
    sources.add(src);
    src.onended = () => sources.delete(src);
  }

  // 4) 采音频推上去
  await new Promise<void>((resolve) => {
    if (!ws) return resolve();
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => resolve(), { once: true });
  });

  ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const frames = Math.round((ctx.sampleRate * CHUNK_MS) / 1000);
  // ScriptProcessor 已废弃但到处都能用；换 AudioWorklet 要单独一个文件，
  // 那是 M6 打包时一起做的事
  const node = ctx.createScriptProcessor(nextPow2(frames), 1, 1);
  source.connect(node);
  node.connect(ctx.destination);
  node.onaudioprocess = (e: AudioProcessingEvent) => {
    if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
    const pcm = downsample(e.inputBuffer.getChannelData(0), ctx!.sampleRate, UPLINK_RATE);
    ws.send(pcm.buffer);
  };

  return { stop, finished };
}

function nextPow2(n: number): number {
  let p = 256;
  while (p < n) p *= 2;
  return Math.min(p, 16384);
}
