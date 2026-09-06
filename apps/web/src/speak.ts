/**
 * 把 `/chat` 流里的 TTS 音频帧放出来。
 *
 * 后端每一轮都会调 TTS 合成、按帧推给前端；前端原来在 `onAudio` 里一行注释
 * 「推迟到 M5，收到就丢弃」——合成的钱照花，声音一次没响过。这里把它接上。
 *
 * 与实时通话那条链路（`voice.ts`）**共用同一套播放办法**，但各自一个
 * `AudioContext`：两条链路不会同时出声（通话时用户不打字），各管各的更简单，
 * 也免得一边挂断把另一边的队列清掉。
 *
 * 帧是裸 PCM16，排队播——按 `playAt` 接在上一段后面，中间不留缝，
 * 不然每帧之间会有咔哒声。
 */

/** 一次朗读。`push` 喂帧，`stop` 立刻闭嘴。 */
export interface Speaker {
  push(pcmB64: string, sampleRate: number): void;
  stop(): void;
  /** 现在还有声音在响吗（队列里有、或已排进图里还没播完）。 */
  speaking(): boolean;
  /** 全部播完时叫一声。只留最后一个回调。 */
  onDrained(cb: (() => void) | null): void;
}

/** base64 → Int16 PCM。字节数是奇数时丢掉半个采样，别让整个缓冲错位。 */
export function base64ToPcm16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

export interface SpeakerOptions {
  /** 造 `AudioContext`。测试里换成假的。参数是这一路音频的采样率。 */
  makeContext?: (sampleRate: number) => AudioContext;
}

/** 攒到这么长再排一段。 */
export const BUFFER_MS = 240;

/** 首段往后推这么久再响。 */
export const LEAD_MS = 180;

/** 没有新帧了就把尾巴排掉，别让最后不足一段的音频卡在队列里。 */
const FLUSH_IDLE_MS = 80;

/**
 * 最后一段播完之后再等这么久才认定「说完了」。
 *
 * 比 `FLUSH_IDLE_MS` 长一档：后端两帧之间偶尔会卡一下，队列刚好放空、
 * 下一帧还在路上，那一瞬间不能算说完——不然状态会在「说」和「待机」之间闪。
 */
const DRAIN_GRACE_MS = 200;

export function createSpeaker(opts: SpeakerOptions = {}): Speaker {
  /**
   * **按素材的采样率开 `AudioContext`。**
   *
   * 不指定的话上下文按硬件走（这台机器是 48k），而帧是 16k 的——每个
   * `AudioBuffer` 各自被重采样一次，16k 以上折回来的镜像落在 8–12 kHz，
   * 听上去就是压在人声上的一层电流。指定成 16k 之后图里一次重采样都不做，
   * 由音频设备那一层统一升到 48k（那儿的重采样器是正经的）。
   */
  const make = opts.makeContext ?? ((sampleRate: number) => new AudioContext({ sampleRate }));
  let ctx: AudioContext | null = null;
  /** 下一段该从什么时候开始播。 */
  let playAt = 0;
  /** 还没排出去的采样，以及它们的采样率。 */
  let queue: Int16Array[] = [];
  let queued = 0;
  let rate = 16000;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const sources = new Set<AudioBufferSourceNode>();
  let drained: (() => void) | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;

  /** 排空了就通知一声，但要压过 `DRAIN_GRACE_MS` 的静默期再算数。 */
  const armDrainCheck = (): void => {
    if (drainTimer !== null) clearTimeout(drainTimer);
    drainTimer = setTimeout(() => {
      drainTimer = null;
      if (queued === 0 && sources.size === 0) drained?.();
    }, DRAIN_GRACE_MS);
  };

  /**
   * 把攒着的采样拼成一段排进去。
   *
   * **为什么要攒。** 后端一帧是 20 毫秒（640 字节）。一帧一个 `AudioBuffer` 的话有两个毛病：
   *
   * 1. **重采样接缝**。帧是 16k，`AudioContext` 跑在 48k，每个 buffer 各自重采样一次，
   *    接缝处对不齐——一秒五十个接缝，听上去就是持续的电流声。
   * 2. **抖动**。帧到得比播得慢一点，`playAt` 就落到 `currentTime` 后面，
   *    排出去的那一段中间空一小截，空一次响一下。
   *
   * 攒到 240 毫秒再排，接缝少了十二倍；首段再往后垫 180 毫秒，
   * 之后的到达抖动只要不超过这个垫子就填得平。开头最吵、说着说着就好了，
   * 正是因为队列跑在前面之后抖动被吃掉了——那时候垫子是自然攒出来的。
   */
  const drain = (): void => {
    if (queued === 0 || !ctx) return;
    const merged = new Int16Array(queued);
    let at = 0;
    for (const part of queue) {
      merged.set(part, at);
      at += part.length;
    }
    queue = [];
    queued = 0;

    const buf = ctx.createBuffer(1, merged.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < merged.length; i += 1) ch[i] = merged[i]! / 0x8000;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    // 落在过去就说明欠载了（首段也走这条），重新垫一段再排，别排到已经过去的时刻
    if (playAt <= ctx.currentTime) playAt = ctx.currentTime + LEAD_MS / 1000;
    src.start(playAt);
    playAt += buf.duration;
    sources.add(src);
    src.onended = () => {
      sources.delete(src);
      armDrainCheck();
    };
  };

  return {
    push(pcmB64, sampleRate) {
      const pcm = base64ToPcm16(pcmB64);
      if (pcm.length === 0) return;
      rate = sampleRate > 0 ? sampleRate : 16000;
      if (!ctx) ctx = make(rate);
      if (drainTimer !== null) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
      queue.push(pcm);
      queued += pcm.length;
      if (queued >= (rate * BUFFER_MS) / 1000) drain();
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => {
        idle = null;
        drain();
      }, FLUSH_IDLE_MS);
    },
    speaking() {
      if (queued > 0 || sources.size > 0) return true;
      return ctx !== null && playAt > ctx.currentTime;
    },
    onDrained(cb) {
      drained = cb;
    },
    stop() {
      if (idle !== null) {
        clearTimeout(idle);
        idle = null;
      }
      if (drainTimer !== null) {
        clearTimeout(drainTimer);
        drainTimer = null;
      }
      queue = [];
      queued = 0;
      for (const src of sources) {
        try {
          src.stop();
        } catch {
          /* 已经播完了 */
        }
      }
      sources.clear();
      playAt = 0;
      const dying = ctx;
      ctx = null;
      void dying?.close().catch(() => {});
    }
  };
}
