/**
 * 拖动时丘丘的「跟不上」——一个弹簧。
 *
 * 窗口是刚体，`setPosition` 说到哪就到哪；但一个软乎乎的球被拽着走，应该稍微
 * 落在后面、身子往后倾，松手之后晃一下才停。这一点点滞后与回弹，是「它是个
 * 物体」而不是「一张贴在屏幕上的图」最强的信号——比投影管用。
 *
 * 纯函数模块，不碰 DOM，vitest 直接跑。
 */

export interface LeanPose {
  /** 相对静止位置的偏移，px。 */
  x: number;
  y: number;
  /** 倾角，度。跟横向偏移同号，绕底部转。 */
  rotate: number;
}

export interface LeanOptions {
  /** 每帧拖动增量换算成目标偏移的比例。 */
  gain?: number;
  /** 偏移上限，px。要跟窗口留给投影的余量对得上，否则倾出去会被裁。 */
  max?: number;
  /** 弹簧刚度。大了硬，小了肉。 */
  stiffness?: number;
  /** 阻尼。小于临界值才会有回弹的那一下。 */
  damping?: number;
  /** 每 px 横向偏移对应多少度倾角。 */
  tilt?: number;
}

export const LEAN_DEFAULTS: Required<LeanOptions> = {
  gain: 0.55,
  max: 10,
  stiffness: 170,
  damping: 17,
  tilt: 0.32
};

/** 小于这个数就当停了，免得弹簧永远在抖、rAF 永远不停。 */
const REST_EPSILON = 0.05;

export interface Lean {
  /** 报一帧的拖动增量，px。 */
  push(dx: number, dy: number): void;
  /** 松手：目标回到原位，剩下的交给弹簧。 */
  release(): void;
  /** 推进 `dt` 秒，返回当前姿态。 */
  step(dt: number): LeanPose;
  /** 已经停稳了。调用方据此停 rAF。 */
  atRest(): boolean;
  /** 当前姿态，不推进。 */
  pose(): LeanPose;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function createLean(opts: LeanOptions = {}): Lean {
  const o = { ...LEAN_DEFAULTS, ...opts };
  let x = 0;
  let y = 0;
  let vx = 0;
  let vy = 0;
  let tx = 0;
  let ty = 0;

  const pose = (): LeanPose => ({ x, y, rotate: x * o.tilt });

  return {
    push(dx, dy) {
      // 往右拽，球落在左边——所以取反
      tx = clamp(-dx * o.gain, -o.max, o.max);
      ty = clamp(-dy * o.gain, -o.max, o.max);
    },
    release() {
      tx = 0;
      ty = 0;
    },
    step(dt) {
      // 掉帧或者标签页切回来时 dt 会很大，不夹住弹簧会炸
      const h = clamp(dt, 0, 1 / 30);
      vx += ((tx - x) * o.stiffness - vx * o.damping) * h;
      vy += ((ty - y) * o.stiffness - vy * o.damping) * h;
      x += vx * h;
      y += vy * h;
      return pose();
    },
    atRest() {
      return (
        Math.abs(x - tx) < REST_EPSILON &&
        Math.abs(y - ty) < REST_EPSILON &&
        Math.abs(vx) < REST_EPSILON &&
        Math.abs(vy) < REST_EPSILON
      );
    },
    pose
  };
}
