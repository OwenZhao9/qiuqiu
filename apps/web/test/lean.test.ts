/** 拖动时的滞后与回弹。物理是纯函数，直接推时间就能测。 */

import { describe, expect, it } from 'vitest';
import { createLean, LEAN_DEFAULTS } from '../src/lean.js';

/** 推进若干帧，返回轨迹。 */
function run(lean: ReturnType<typeof createLean>, frames: number, dt = 1 / 60): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i += 1) out.push(lean.step(dt).x);
  return out;
}

describe('createLean', () => {
  it('一开始是站直的', () => {
    const l = createLean();
    expect(l.pose()).toEqual({ x: 0, y: 0, rotate: 0 });
    expect(l.atRest()).toBe(true);
  });

  it('往右拽，球落在左边（负偏移）', () => {
    const l = createLean();
    l.push(20, 0);
    const xs = run(l, 20);
    expect(xs.at(-1)!, '被往右拽时球该落在后面').toBeLessThan(-1);
  });

  it('往左拽就反过来', () => {
    const l = createLean();
    l.push(-20, 0);
    expect(run(l, 20).at(-1)!).toBeGreaterThan(1);
  });

  it('拽得再快也不超过上限——超了投影会被窗口裁掉', () => {
    const l = createLean();
    l.push(9999, 9999);
    for (let i = 0; i < 200; i += 1) l.step(1 / 60);
    const p = l.pose();
    expect(Math.abs(p.x)).toBeLessThanOrEqual(LEAN_DEFAULTS.max + 0.01);
    expect(Math.abs(p.y)).toBeLessThanOrEqual(LEAN_DEFAULTS.max + 0.01);
  });

  it('倾角跟横向偏移同号同比', () => {
    const l = createLean();
    l.push(20, 0);
    const p = l.step(1 / 60);
    expect(p.rotate).toBeCloseTo(p.x * LEAN_DEFAULTS.tilt, 6);
  });

  it('松手会越过原位再回来——那一下过冲就是「弹一下」', () => {
    const l = createLean();
    l.push(25, 0);
    for (let i = 0; i < 30; i += 1) l.step(1 / 60); // 先歪住
    const before = l.pose().x;
    expect(before).toBeLessThan(-1);
    l.release();
    const xs = run(l, 90);
    expect(Math.max(...xs), '要冲过 0 到另一侧去').toBeGreaterThan(0.2);
  });

  it('松手之后一定停得下来', () => {
    const l = createLean();
    l.push(25, 25);
    run(l, 30);
    l.release();
    run(l, 240);
    expect(l.atRest()).toBe(true);
    expect(Math.abs(l.pose().x)).toBeLessThan(0.1);
  });

  it('掉一大帧不会把弹簧炸掉', () => {
    const l = createLean();
    l.push(25, 25);
    l.step(5); // 切走再切回来
    const p = l.pose();
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    expect(Math.abs(p.x)).toBeLessThanOrEqual(LEAN_DEFAULTS.max + 0.01);
  });
});
