/**
 * 被动采集：每隔一阵从摄像头取一张，交给后端看一眼。
 *
 * **这条链路原来只有一半。** 后端 `/ingest` 是完整的（读 blob → Vision 转描述 →
 * 进新颖度过滤器 → 够新才写记忆），前端的 `postIngest()` 也写好了，但**没有任何
 * 地方调它**：托盘里那个「暂停被动采集」翻的是一个没人读的标志位。右栏整套筛选
 * 阈值、框图里「拿不准」那条分支，服务的都是这条链路，而它是空的。
 *
 * 只做画面这一路。声音那一路要 VAD 与 ASR，这两个能力在 `packages/models` 里
 * 连实现文件都没有（`/health` 的 `missing` 一直报着），后端收到 `ambient_audio`
 * 会按 AD-16 返回带 hint 的 503——**不静默降级**，所以前端干脆不发。
 *
 * 三条自我约束：
 *   1. **默认关**。开摄像头这件事必须是用户自己按的，托盘和设置页各有一个开关。
 *   2. **不连拍**。默认 45 秒一张，画面缩到 640 宽再传，省带宽也省 Vision 的钱。
 *   3. **一次失败就停**。拿不到摄像头（没授权、被别的程序占着）时立刻关掉并报错，
 *      不做重试循环——后台默默重连摄像头是最容易吓到人的行为。
 */

import { postBlob, postIngest } from './api.js';

/** 两张之间隔多久。太密的话 Vision 的钱与新颖度过滤器都扛不住。 */
export const AMBIENT_INTERVAL_MS = 45_000;

/** 传上去之前把画面缩到这个宽度。描述一张图不需要原图分辨率。 */
export const AMBIENT_WIDTH = 640;

/** JPEG 质量。0.7 在「看得清人和物」与「一张几十 KB」之间。 */
export const AMBIENT_QUALITY = 0.7;

/** 等摄像头出第一帧最多等多久。等不到就这一拍算了，下一拍再说。 */
export const AMBIENT_READY_TIMEOUT_MS = 3000;

/**
 * 等 `getUserMedia()` 最多等多久。
 *
 * 它可以**既不 resolve 也不 reject**——权限没批时 Chromium 就那么挂着。
 * 不设上限的话开关显示「开着」，实际一张图都没传，用户看不出哪儿不对。
 */
export const AMBIENT_OPEN_TIMEOUT_MS = 8000;

export interface AmbientDeps {
  getStream?(): Promise<MediaStream>;
  /** 造 `<video>`。测试里换成假的。 */
  makeVideo?(): HTMLVideoElement;
  upload?: typeof postBlob;
  ingest?: typeof postIngest;
  now?(): Date;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

export interface AmbientHandlers {
  /** 一张交上去了，带回筛选决策。 */
  onSent?(decision: string): void;
  /** 出错了。调用方负责把开关拨回关闭。 */
  onError?(message: string, hint: string): void;
}

export interface AmbientCapture {
  stop(): void;
  /** 立刻抓一张，不等下一个间隔。开机第一张走它。 */
  tick(): Promise<void>;
}

/**
 * 等到真的有一帧可以画。
 *
 * `play()` 返回时 `videoWidth` 往往还是 0——摄像头刚打开，第一帧还没解出来。
 * 不等的话开机那一张会静悄悄地画不出来，用户拨开开关之后要干等 45 秒才有第一次
 * 采集，看起来就像开关没生效。
 */
async function ready(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return;
  await new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', done);
      resolve();
    };
    const timer = setTimeout(done, AMBIENT_READY_TIMEOUT_MS);
    video.addEventListener('loadeddata', done, { once: true });
  });
}

/** 从一帧视频抠一张 JPEG。 */
async function grab(video: HTMLVideoElement): Promise<Blob | null> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, AMBIENT_WIDTH / w);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', AMBIENT_QUALITY)
  );
}

/**
 * 打开摄像头，按间隔往 `/ingest` 送画面。返回的对象 `stop()` 之后**摄像头一定关**。
 *
 * 起不来时抛错，由调用方把开关拨回去——不在这里悄悄重试。
 */
export async function startAmbient(
  handlers: AmbientHandlers = {},
  deps: AmbientDeps = {}
): Promise<AmbientCapture> {
  const getStream =
    deps.getStream ?? (() => navigator.mediaDevices.getUserMedia({ video: true, audio: false }));
  const upload = deps.upload ?? postBlob;
  const ingest = deps.ingest ?? postIngest;
  const now = deps.now ?? (() => new Date());
  const every = deps.setInterval ?? globalThis.setInterval;
  const clear = deps.clearInterval ?? globalThis.clearInterval;

  const stream = await Promise.race([
    getStream(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              '摄像头没有响应（' + AMBIENT_OPEN_TIMEOUT_MS / 1000 + ' 秒无应答），可能是没给权限'
            )
          ),
        AMBIENT_OPEN_TIMEOUT_MS
      )
    )
  ]);
  const video = deps.makeVideo?.() ?? document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  // **不 await**。系统层没放行摄像头时（macOS 上 TCC 还没批），`getUserMedia()`
  // 会给回一条不出帧的流，`play()` 就永远不 settle——await 它的话
  // `startAmbient()` 整个挂住，既不 resolve 也不 reject，界面上开关显示「开着」，
  // 一张图没传过，也没有任何报错。让它自己跑，出没出帧由 `ready()` 判
  void video.play().catch(() => {
    /* 有的实现不 play 也能读到帧，不为这个中断 */
  });

  let stopped = false;
  let busy = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clear(timer);
    timer = null;
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  const tick = async (): Promise<void> => {
    // 上一张还在传就跳过这一拍：网络慢的时候排队只会越积越多
    if (stopped || busy) return;
    busy = true;
    try {
      await ready(video);
      if (stopped) return;
      const shot = await grab(video);
      if (stopped) return;
      if (!shot) {
        // 等满了还是没有画面：摄像头开着但不出帧，多半是系统那一层没放行。
        // 静静跳过这一拍的话，用户要盯着一个「开着」的开关等 45 秒才发现不对
        throw new Error('摄像头打开了但没有画面');
      }
      const { blob_id } = await upload(shot, 'ambient.jpg');
      if (stopped) return;
      const res = await ingest({
        source: 'ambient_image',
        blob_id,
        captured_at: now().toISOString()
      });
      handlers.onSent?.(res.decision);
    } catch (err) {
      const e = err as { message?: string; hint?: string };
      handlers.onError?.(
        e.message ?? String(err),
        e.hint ?? '到「系统设置 › 隐私与安全性 › 摄像头」里把丘丘打开，再回来拨这个开关'
      );
      stop();
    } finally {
      busy = false;
    }
  };

  timer = every(() => void tick(), AMBIENT_INTERVAL_MS);
  return { stop, tick };
}
