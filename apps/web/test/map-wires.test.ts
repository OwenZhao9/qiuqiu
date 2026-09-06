/**
 * 框图连接层的路由。
 *
 * 这部分是纯算路径：给两个矩形，算出线该怎么拐。单独拎出来测是因为
 * 「三段并排」与「三段竖着叠」是两套走法，少一套的表现很难看——
 * 叠起来时仍按并排那套算，线会从右边缘一路倒扫回左边缘，横穿整栏。
 */

import { describe, expect, it } from 'vitest';
import { elbow, straight, type Rect } from '../src/components/MapWires.js';

function rect(left: number, top: number, w: number, h: number): Rect {
  return { left, top, right: left + w, bottom: top + h, width: w, height: h };
}

const BASE = rect(0, 0, 600, 500);

/** 路径里出现过的所有 x 坐标。 */
function xs(d: string): number[] {
  const out: number[] = [];
  for (const seg of d.split(/(?=[MHVA])/)) {
    const n = seg.slice(1).trim().split(/[ ,]+/).map(Number);
    if (seg[0] === 'M') out.push(n[0]);
    if (seg[0] === 'H') out.push(n[0]);
    if (seg[0] === 'A') out.push(n[5]);
  }
  return out.filter((v) => Number.isFinite(v));
}

describe('straight · 空档里的直箭头', () => {
  it('竖的从上边中点画到下边中点', () => {
    expect(straight(rect(100, 40, 12, 26), BASE, 'v')).toBe('M106 40 V66');
  });

  it('横的从左边中点画到右边中点', () => {
    expect(straight(rect(100, 40, 24, 12), BASE, 'h')).toBe('M100 46 H124');
  });

  it('坐标是相对容器的，不是相对视口', () => {
    const base = rect(50, 30, 600, 500);
    expect(straight(rect(100, 40, 12, 26), base, 'v')).toBe('M56 10 V36');
  });
});

describe('elbow · 三段并排时横着走', () => {
  const a = rect(0, 100, 200, 40); // 左栏的盒子
  const b = rect(240, 100, 200, 40); // 右栏的盒子，同高

  it('两头一样高就是一条直线，不凑多余的拐弯', () => {
    expect(elbow(a, b, BASE)).toBe('M200 120 H240');
  });

  it('高低不同时竖直那一段走在两列正中间', () => {
    const lower = rect(240, 300, 200, 40);
    const d = elbow(a, lower, BASE);
    // 220 是 200 与 240 的中点，正好落在两列之间的空档里
    expect(d).toContain('A6 6 0 0 1 220 126');
    expect(d).toContain('V314');
    expect(d.endsWith('H240')).toBe(true);
  });

  it('目标在上方也走得通，拐角方向反过来', () => {
    const higher = rect(240, 20, 200, 40);
    const d = elbow(a, higher, BASE);
    expect(d.startsWith('M200 120')).toBe(true);
    expect(d.endsWith('H240')).toBe(true);
    expect(d).toContain('A6 6 0 0 0 220 114');
  });
});

describe('elbow · 回环：目标在左边', () => {
  // ③ 的「答案」回到 ① 的摄入：丘丘自己那句回答也要过一遍摄入
  const a = rect(400, 300, 160, 40);
  const b = rect(0, 100, 200, 300);

  it('从下边出来走底道往左，再从下边进目标', () => {
    const d = elbow(a, b, BASE);
    expect(d.startsWith('M480 340')).toBe(true);
    // 底道落在两端里更低的那个（400）下面 LOOP_DROP，进目标那一段要留得够长，
    // 短了箭头就糊在横线上
    expect(d).toContain('V420');
    expect(d.endsWith('V400')).toBe(true);
  });

  /**
   * 最后一段必须**往上**走，箭头才是「回到摄入」。
   *
   * 原来底道是从容器下沿倒推的（`base.bottom - 5`）。三段等高之后分区底边离
   * 容器下沿只剩三像素，底道落在了两端上面，最后一段变成往下走——箭头戳在地上，
   * 方向正好反了。
   */
  it('回环的最后一段是往上进目标，不是往下', () => {
    const d = elbow(a, b, BASE);
    const vs = [...d.matchAll(/V(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const lane = Math.max(...vs);
    const last = vs[vs.length - 1]!;
    expect(last, '终点要在底道上面').toBeLessThan(lane);
  });

  /** 箭头本身 8 px 高，可见直段短于它的话整个箭头就糊在横线上。 */
  it('进目标那一段留得下箭头还看得出方向', () => {
    const d = elbow(a, b, BASE);
    const vs = [...d.matchAll(/V(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const enterFrom = vs[vs.length - 2]!;
    const enterTo = vs[vs.length - 1]!;
    expect(enterFrom - enterTo).toBeGreaterThanOrEqual(16);
  });

  it('底道压在两端下面，不是上面', () => {
    const d = elbow(a, b, BASE);
    const lane = Math.max(...[...d.matchAll(/V(-?[\d.]+)/g)].map((m) => Number(m[1])));
    expect(lane).toBeGreaterThan(a.bottom - BASE.top);
    expect(lane).toBeGreaterThan(b.bottom - BASE.top);
  });

  /** 分区等高时两端底边一样高，这是实际版面里的情形。 */
  it('两端一样高时照样是下去 → 往左 → 上来', () => {
    const same1 = rect(400, 300, 160, 146); // bottom = 446
    const same2 = rect(0, 100, 200, 346); // bottom = 446
    const d = elbow(same1, same2, BASE);
    const vs = [...d.matchAll(/V(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.max(...vs), '底道在 446 下面').toBeGreaterThan(446);
    expect(vs[vs.length - 1]).toBe(446);
  });
});

describe('elbow · 栏太窄三段叠起来时竖着走', () => {
  // 完整档在 600 px 宽的中栏里就是这样：三段上下叠，x 几乎重合
  const a = rect(13, 500, 550, 100);
  const b = rect(13, 700, 550, 128);

  it('从下边出、从上边进，不再横扫整栏', () => {
    const d = elbow(a, b, BASE);
    expect(d).toBe('M288 600 V700');
  });

  it('回归：叠起来时不能出现从右边缘倒扫回左边缘的那条线', () => {
    const d = elbow(a, b, BASE);
    const all = xs(d);
    expect(Math.min(...all)).toBeGreaterThan(13);
    expect(Math.max(...all)).toBeLessThan(563);
  });

  it('两块横向错开时在中间高度拐一次', () => {
    const shifted = rect(120, 700, 300, 100);
    const d = elbow(a, shifted, BASE);
    expect(d.startsWith('M288 600')).toBe(true);
    expect(d.endsWith('V700')).toBe(true);
    expect(d).toContain('H276'); // 拐到目标中线 270 前留出圆角
  });
});
