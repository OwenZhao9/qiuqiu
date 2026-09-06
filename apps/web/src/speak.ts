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
}

/** base64 → Int16 PCM。字节数是奇数时丢掉半个采样，别让整个缓冲错位。 */
export function base64ToPcm16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
}

export interface SpeakerOptions {
  /** 造 `AudioContext`。测试里换成假的。 */
  makeContext?: () => AudioContext;
}

export function createSpeaker(opts: SpeakerOptions = {}): Speaker {
  const make = opts.makeContext ?? (() => new AudioContext());
  let ctx: AudioContext | null = null;
  /** 下一段该从什么时候开始播。 */
  let playAt = 0;
  const sources = new Set<AudioBufferSourceNode>();

  return {
    push(pcmB64, sampleRate) {
      const pcm = base64ToPcm16(pcmB64);
      if (pcm.length === 0) return;
      if (!ctx) ctx = make();
      const rate = sampleRate > 0 ? sampleRate : 16000;
      const buf = ctx.createBuffer(1, pcm.length, rate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i += 1) ch[i] = pcm[i]! / 0x8000;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      playAt = Math.max(playAt, ctx.currentTime);
      src.start(playAt);
      playAt += buf.duration;
      sources.add(src);
      src.onended = () => void sources.delete(src);
    },
    stop() {
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
