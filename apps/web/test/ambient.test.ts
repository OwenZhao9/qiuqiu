/**
 * 被动采集的采集循环。
 *
 * 这条链路原来只有一半：后端 `/ingest` 完整，前端 `postIngest()` 也写好了，
 * 但没有任何地方调它——托盘那个开关翻的是一个没人读的标志位。
 *
 * 这里守三条自我约束：不连拍、一次失败就停、停了摄像头一定关。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AMBIENT_INTERVAL_MS,
  AMBIENT_OPEN_TIMEOUT_MS,
  AMBIENT_WIDTH,
  startAmbient
} from '../src/ambient.js';

function fakeStream() {
  const stopped: number[] = [];
  const track = {
    stop() {
      stopped.push(1);
    }
  };
  return {
    stream: { getTracks: () => [track] } as unknown as MediaStream,
    stoppedCount: () => stopped.length
  };
}

/** jsdom 没有 canvas 与 video 的实现，按用得到的那几个字段搭一个。 */
function stubDom(w = 1280, h = 720) {
  const drawn: [number, number][] = [];
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag === 'video') {
      return {
        srcObject: null,
        muted: false,
        playsInline: false,
        videoWidth: w,
        videoHeight: h,
        readyState: 4,
        addEventListener: () => {},
        removeEventListener: () => {},
        play: async () => {}
      } as unknown as HTMLElement;
    }
    if (tag === 'canvas') {
      const canvas = {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage(_v: unknown, _x: number, _y: number, cw: number, ch: number) {
            drawn.push([cw, ch]);
          }
        }),
        toBlob(cb: (b: Blob | null) => void) {
          cb(new Blob(['x'], { type: 'image/jpeg' }));
        }
      };
      return canvas as unknown as HTMLElement;
    }
    return {} as unknown as HTMLElement;
  }) as typeof document.createElement);
  return { drawn };
}

describe('startAmbient', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('把画面缩到 640 宽再传，不发原图', async () => {
    const { drawn } = stubDom(1280, 720);
    const f = fakeStream();
    const upload = vi.fn(async (_b: Blob, _n?: string) => ({ blob_id: 'b1' }));
    const ingest = vi.fn(async (body: { source: string; blob_id: string; captured_at: string }) => {
      void body;
      return { trace_id: 't', decision: 'accept' as const };
    });
    const c = await startAmbient(
      {},
      { getStream: async () => f.stream, upload, ingest, setInterval: (() => 0) as never }
    );
    await c.tick();
    expect(drawn[0]).toEqual([AMBIENT_WIDTH, 360]);
    expect(upload).toHaveBeenCalledOnce();
    expect(ingest.mock.calls[0]![0]).toMatchObject({ source: 'ambient_image', blob_id: 'b1' });
    c.stop();
  });

  it('只发画面那一路，不发声音——VAD 与 ASR 根本没有实现', async () => {
    stubDom();
    const f = fakeStream();
    const ingest = vi.fn(async (body: { source: string; blob_id: string; captured_at: string }) => {
      void body;
      return { trace_id: 't', decision: 'accept' as const };
    });
    const c = await startAmbient(
      {},
      {
        getStream: async () => f.stream,
        upload: async () => ({ blob_id: 'b' }),
        ingest,
        setInterval: (() => 0) as never
      }
    );
    await c.tick();
    expect(ingest.mock.calls[0]![0].source).toBe('ambient_image');
    c.stop();
  });

  it('上一张还在传就跳过这一拍，不排队堆积', async () => {
    stubDom();
    const f = fakeStream();
    let release: (() => void) | null = null;
    const upload = vi.fn(
      () =>
        new Promise<{ blob_id: string }>((resolve) => {
          release = () => resolve({ blob_id: 'b' });
        })
    );
    const c = await startAmbient(
      {},
      {
        getStream: async () => f.stream,
        upload,
        ingest: async () => ({ trace_id: 't', decision: 'accept' as const }),
        setInterval: (() => 0) as never
      }
    );
    const first = c.tick();
    // 等第一拍走到上传那一步
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(upload).toHaveBeenCalledTimes(1);

    await c.tick(); // 第二拍撞上还没传完的第一张，直接跳过
    expect(upload).toHaveBeenCalledTimes(1);

    release!();
    await first;
    c.stop();
  });

  it('出错就停，并把摄像头关掉——不在后台默默重连', async () => {
    stubDom();
    const f = fakeStream();
    const onError = vi.fn();
    const c = await startAmbient(
      { onError },
      {
        getStream: async () => f.stream,
        upload: async () => {
          throw Object.assign(new Error('上传失败'), { hint: '看后端日志' });
        },
        ingest: async () => ({ trace_id: 't', decision: 'accept' as const }),
        setInterval: (() => 0) as never
      }
    );
    await c.tick();
    expect(onError).toHaveBeenCalledWith('上传失败', '看后端日志');
    expect(f.stoppedCount(), '摄像头必须关').toBe(1);
  });

  it('stop 之后再 tick 什么也不做，摄像头不重开', async () => {
    stubDom();
    const f = fakeStream();
    const upload = vi.fn(async () => ({ blob_id: 'b' }));
    const c = await startAmbient(
      {},
      {
        getStream: async () => f.stream,
        upload,
        ingest: async () => ({ trace_id: 't', decision: 'accept' as const }),
        setInterval: (() => 0) as never
      }
    );
    c.stop();
    await c.tick();
    expect(upload).not.toHaveBeenCalled();
    expect(f.stoppedCount()).toBe(1);
  });

  it('间隔是 45 秒，不连拍', () => {
    expect(AMBIENT_INTERVAL_MS).toBe(45_000);
  });
});

describe('startAmbient · 开机第一张', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('等到摄像头出了第一帧才抓，不空放一张', async () => {
    stubDom(1280, 720);
    const f = fakeStream();
    const upload = vi.fn(async (_b: Blob, _n?: string) => ({ blob_id: 'b1' }));
    const ingest = vi.fn(async () => ({ trace_id: 't', decision: 'accept' as const }));

    // 刚 play() 完的样子：尺寸还是 0，第一帧没解出来
    const listeners: Array<() => void> = [];
    const video = {
      srcObject: null,
      muted: false,
      playsInline: false,
      videoWidth: 0,
      videoHeight: 0,
      readyState: 0,
      addEventListener: (_e: string, cb: () => void) => listeners.push(cb),
      removeEventListener: () => {},
      play: async () => {}
    } as unknown as HTMLVideoElement;

    const c = await startAmbient(
      {},
      {
        getStream: async () => f.stream,
        makeVideo: () => video,
        upload,
        ingest,
        setInterval: (() => 0) as never
      }
    );
    const pending = c.tick();
    expect(upload).not.toHaveBeenCalled(); // 还在等第一帧

    Object.assign(video, { videoWidth: 1280, videoHeight: 720, readyState: 4 });
    for (const cb of listeners) cb();
    await pending;

    // 等到了才抓，抓到的是有尺寸的那一帧
    expect(upload).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledOnce();
    c.stop();
  });
});

describe('startAmbient · 摄像头没反应', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('迟迟不给流就报错，不让开关一直显示「开着」', async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<MediaStream>(() => {});
      const started = startAmbient({}, { getStream: () => never }).then(
        () => 'resolved',
        (e: Error) => e.message
      );
      await vi.advanceTimersByTimeAsync(AMBIENT_OPEN_TIMEOUT_MS + 10);
      expect(await started).toContain('摄像头没有响应');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('startAmbient · 开着却没有画面', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('play() 不 settle 也不卡住启动', async () => {
    stubDom(1280, 720);
    const f = fakeStream();
    const video = {
      srcObject: null,
      muted: false,
      playsInline: false,
      videoWidth: 1280,
      videoHeight: 720,
      readyState: 4,
      addEventListener: () => {},
      removeEventListener: () => {},
      // 系统层没放行时就是这样：流给了，但 play() 永远不 settle
      play: () => new Promise<void>(() => {})
    } as unknown as HTMLVideoElement;

    const c = await startAmbient(
      {},
      {
        getStream: async () => f.stream,
        makeVideo: () => video,
        upload: async () => ({ blob_id: 'b1' }),
        ingest: async () => ({ trace_id: 't', decision: 'accept' as const }),
        setInterval: (() => 0) as never
      }
    );
    expect(c).toBeTruthy(); // 走到这里就说明没被 play() 挂住
    c.stop();
  });

  it('等满了还是没画面就报错并关掉，不静静跳过', async () => {
    stubDom(1280, 720);
    const f = fakeStream();
    const onError = vi.fn();
    const video = {
      srcObject: null,
      muted: false,
      playsInline: false,
      videoWidth: 0, // 摄像头开着，一帧也不出
      videoHeight: 0,
      readyState: 4,
      addEventListener: () => {},
      removeEventListener: () => {},
      play: async () => {}
    } as unknown as HTMLVideoElement;

    const c = await startAmbient(
      { onError },
      {
        getStream: async () => f.stream,
        makeVideo: () => video,
        upload: async () => ({ blob_id: 'b1' }),
        ingest: async () => ({ trace_id: 't', decision: 'accept' as const }),
        setInterval: (() => 0) as never
      }
    );
    await c.tick();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]![0]).toContain('没有画面');
    expect(f.stoppedCount()).toBe(1); // 报错即关摄像头
  });
});
