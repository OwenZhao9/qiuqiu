/**
 * 形象切换：配色补丁来回切、装扮层挂载与摘除。
 *
 * 这里守的是一个**踩过的坑**：补丁读的是注册表里的 `raw`，也就是上一次补丁的
 * 产物，不是上游原文。所以任何「原来没有才补上」的写法在第二次换形象时都会
 * 把上一套颜色留下来。warm → anime → warm 必须一个字节都不差地回到 warm。
 */

import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountCostume, findBodyGroup, parseEyeTransform, EYE_HALF } from '../src/costume.js';
import { applyQiuqiuTheme, currentLook, PALETTES, resetThemeFlag } from '../src/theme.js';
import { ALL_EMOTION_IDS, type EmotionId, type EmotionRaw } from '../src/types.js';
import { fromRepo } from './helpers/paths.js';
import { makeStubEmotionBall } from './helpers/stub-engine.js';

const DESIGN = readFileSync(fromRepo('design', 'character.md'), 'utf8');

/** 把注册表拍平成 `{ id: { body, eye, seqBodies } }`，方便整体比对。 */
function snapshot(eb: ReturnType<typeof makeStubEmotionBall>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of ALL_EMOTION_IDS) {
    const raw = eb.config.get(id)!.raw as EmotionRaw;
    out[id] = {
      body: (raw.body as Record<string, unknown> | undefined)?.color,
      eye: ((raw.eyes as Record<string, unknown> | undefined)?.both as Record<string, unknown>)
        ?.color,
      seq: (raw.sequence?.frames ?? []).map(
        (f) => (f.body as Record<string, unknown> | undefined)?.color
      )
    };
  }
  return out;
}

describe('配色', () => {
  it('二次元的补丁表与 design/character.md 逐行一致', () => {
    // 文档里那张表是给人看的，代码里那张是给机器跑的。两张表分开写就一定会分叉，
    // 所以这里把文档当断言源，改了一边不改另一边就红
    const start = DESIGN.indexOf('二次元的那一套');
    expect(start, 'design/character.md 里找不到二次元的体色补丁表').toBeGreaterThan(-1);
    const block = DESIGN.slice(start, DESIGN.indexOf('语义红两条刻意', start));
    const rows = new Map<string, string>();
    for (const line of block.split('\n')) {
      const m = /^\|\s*`(\d{2})`[^|]*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|/.exec(line.trim());
      if (m) rows.set(m[1]!, m[2]!);
    }
    expect(rows.size, '文档表应该有 11 行').toBe(11);
    expect(Object.fromEntries(rows)).toEqual(PALETTES.anime.bodyByEmotion);
  });

  it('anime 把 32 个表情的眼色全换成堇紫，语义红不动', () => {
    const eb = makeStubEmotionBall();
    applyQiuqiuTheme(eb, { look: 'anime' });
    for (const id of ALL_EMOTION_IDS) {
      const raw = eb.config.get(id)!.raw as EmotionRaw;
      const both = (raw.eyes as Record<string, unknown>).both as Record<string, unknown>;
      expect(both.color, `${id} 的眼色`).toBe(PALETTES.anime.eye);
    }
    const red = (id: EmotionId): unknown =>
      (eb.config.get(id)!.raw.body as Record<string, unknown>).color;
    expect(red('21'), '生气的语义红').toBe('#E4574A');
    expect(red('34'), '出错的语义红').toBe('#E25B5B');
  });

  it('warm → anime → warm 完全回到 warm，一处颜色都不残留', () => {
    const eb = makeStubEmotionBall();
    applyQiuqiuTheme(eb, { look: 'warm' });
    const warm = snapshot(eb);

    applyQiuqiuTheme(eb, { look: 'anime' });
    const anime = snapshot(eb);
    expect(anime, 'anime 应该跟 warm 不一样，不然这个测试什么也没测').not.toEqual(warm);

    applyQiuqiuTheme(eb, { look: 'warm' });
    expect(snapshot(eb)).toEqual(warm);
  });

  it('来回切三轮还是稳的（补丁不会一层层叠起来）', () => {
    const eb = makeStubEmotionBall();
    applyQiuqiuTheme(eb, { look: 'warm' });
    const warm = snapshot(eb);
    for (let i = 0; i < 3; i++) {
      applyQiuqiuTheme(eb, { look: 'anime' });
      applyQiuqiuTheme(eb, { look: 'warm' });
    }
    expect(snapshot(eb)).toEqual(warm);
  });

  it('同一套配色重复调直接跳过，换了才真的重打', () => {
    const eb = makeStubEmotionBall();
    expect(applyQiuqiuTheme(eb, { look: 'warm' }).ran).toBe(true);
    expect(applyQiuqiuTheme(eb, { look: 'warm' }).ran).toBe(false);
    expect(currentLook(eb)).toBe('warm');
    const second = applyQiuqiuTheme(eb, { look: 'anime' });
    expect(second.ran).toBe(true);
    expect(second.patched).toBe(ALL_EMOTION_IDS.length);
    expect(currentLook(eb)).toBe('anime');
    resetThemeFlag(eb);
    expect(currentLook(eb)).toBeNull();
  });

  it('未知配色直接抛，不悄悄退回默认', () => {
    const eb = makeStubEmotionBall();
    expect(() => applyQiuqiuTheme(eb, { look: 'kawaii' as unknown as 'warm' })).toThrow(/未知配色/);
  });
});

/* ------------------------------------------------------------------ *
 * 装扮层
 * ------------------------------------------------------------------ */

const SVGNS = 'http://www.w3.org/2000/svg';

/**
 * 照 `vendor/emotion-ball/js/ball.js` 的骨架搭一个假 SVG：
 * `defs` + `fxBack(g, pointer-events=none)` + `bodyG(g)` + `fxFront(g, none)`，
 * `bodyG` 里是身体与两只眼三个 `<path>`。
 * 结构照抄是有意的——装扮层就是靠这个结构定位的，结构变了就该测出来。
 */
function makeBallDom(): { mount: HTMLElement; eyeL: SVGElement; eyeR: SVGElement } {
  const mount = document.createElement('div');
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('viewBox', '-15 -15 259 259');
  svg.appendChild(document.createElementNS(SVGNS, 'defs'));

  const fxBack = document.createElementNS(SVGNS, 'g');
  fxBack.setAttribute('pointer-events', 'none');
  svg.appendChild(fxBack);

  const bodyG = document.createElementNS(SVGNS, 'g');
  for (const [i, fill] of ['url(#eb0g)', '#2A2621', '#2A2621'].entries()) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('fill', fill);
    p.setAttribute('d', `M ${i} 0 L 10 10 Z`);
    bodyG.appendChild(p);
  }
  svg.appendChild(bodyG);

  const fxFront = document.createElementNS(SVGNS, 'g');
  fxFront.setAttribute('pointer-events', 'none');
  svg.appendChild(fxFront);

  mount.appendChild(svg);
  const paths = bodyG.querySelectorAll('path');
  return {
    mount,
    eyeL: paths[1] as unknown as SVGElement,
    eyeR: paths[2] as unknown as SVGElement
  };
}

/** rAF 替身：只记回调，不自己跑，免得测试里无限循环。 */
function manualRaf(): {
  raf: (cb: () => void) => number;
  cancel: (h: number) => void;
  count: number;
} {
  const state = { count: 0, raf: (_cb: () => void) => 0, cancel: (_h: number) => {} };
  state.raf = () => ++state.count;
  state.cancel = () => {};
  return state as never;
}

describe('parseEyeTransform', () => {
  it('取得出落点与基准点', () => {
    const t = 'translate(135.21 68.15) scale(1.17 1.18) translate(-136.56 -66.76)';
    expect(parseEyeTransform(t)).toEqual({ at: [135.21, 68.15], base: [136.56, 66.76] });
  });

  it('带 rotate 的也认', () => {
    const t = 'translate(10 20) rotate(-8) scale(1 1) translate(-3 -4)';
    expect(parseEyeTransform(t)).toEqual({ at: [10, 20], base: [3, 4] });
  });

  it('形状不对就返回 null，不瞎猜', () => {
    expect(parseEyeTransform(null)).toBeNull();
    expect(parseEyeTransform('')).toBeNull();
    expect(parseEyeTransform('scale(2)')).toBeNull();
    expect(parseEyeTransform('translate(1 2)')).toBeNull(); // 只有一个 translate
  });
});

describe('装扮层', () => {
  let raf: ReturnType<typeof manualRaf>;
  beforeEach(() => {
    raf = manualRaf();
  });

  it('warm 不挂任何东西', () => {
    const { mount } = makeBallDom();
    expect(mountCostume(mount, 'warm', raf)).toBeNull();
    expect(mount.querySelectorAll('.qq-costume')).toHaveLength(0);
  });

  it('引擎还没画 SVG 时返回 null，不假装挂上了', () => {
    expect(mountCostume(document.createElement('div'), 'anime', raf)).toBeNull();
  });

  it('anime 按 back / mid / front 三层插进 bodyG，顺序决定遮挡', () => {
    const { mount } = makeBallDom();
    const c = mountCostume(mount, 'anime', { ...raf, animate: false });
    expect(c).not.toBeNull();

    const body = findBodyGroup(mount.querySelector('svg') as unknown as SVGElement)!;
    const order = Array.from(body.children).map((n) =>
      n.tagName.toLowerCase() === 'path' ? 'path' : (n.getAttribute('class') ?? '')
    );
    expect(order).toEqual([
      'qq-costume qq-costume--back', // 呆毛在身体之前
      'path', // 身体
      'qq-costume qq-costume--mid', // 蝴蝶结腮红在身体之后、眼睛之前
      'path', // 左眼
      'path', // 右眼
      'qq-costume qq-costume--front' // 眼高光在最后
    ]);
  });

  it('零件齐全：呆毛 · 蝴蝶结 · 两片腮红 · 两只眼的高光 · 三颗闪光', () => {
    const { mount } = makeBallDom();
    mountCostume(mount, 'anime', { ...raf, animate: false });
    expect(mount.querySelectorAll('.qq-costume__ahoge')).toHaveLength(1);
    expect(mount.querySelectorAll('.qq-costume__bow')).toHaveLength(1);
    expect(mount.querySelectorAll('.qq-costume__blush')).toHaveLength(2);
    expect(mount.querySelectorAll('.qq-costume__shine')).toHaveLength(2);
    expect(mount.querySelectorAll('.qq-costume__spark')).toHaveLength(3);
  });

  it('高光照抄眼睛的变换，腮红只跟平移', () => {
    const { mount, eyeL } = makeBallDom();
    const t = 'translate(100 60) scale(1.2 0.5) translate(-136.56 -66.76)';
    eyeL.setAttribute('transform', t);
    const c = mountCostume(mount, 'anime', { ...raf, animate: false })!;
    c.sync();

    const shine = mount.querySelector('.qq-costume__shine') as SVGElement;
    expect(shine.getAttribute('transform'), '高光要整条照抄，才能跟着眨眼一起压扁').toBe(t);

    const blush = mount.querySelector('.qq-costume__blush') as SVGElement;
    expect(
      blush.getAttribute('transform'),
      '腮红只跟平移。跟了 scale 的话眨眼那一瞬会被压成一条线'
    ).toBe('translate(94 90)');
  });

  it('高光的圆心按基准点摆，裁剪路径跟着眼睛换形', () => {
    const { mount, eyeL } = makeBallDom();
    eyeL.setAttribute('transform', 'translate(0 0) scale(1 1) translate(-50 -40)');
    eyeL.setAttribute('d', 'M 1 2 L 3 4 Z');
    const c = mountCostume(mount, 'anime', { ...raf, animate: false })!;
    c.sync();

    const big = mount.querySelector('.qq-costume__shine circle') as SVGElement;
    expect(Number(big.getAttribute('cx'))).toBeCloseTo(50 - EYE_HALF * 0.3, 5);
    expect(Number(big.getAttribute('cy'))).toBeCloseTo(40 - EYE_HALF * 0.34, 5);

    const clip = mount.querySelector('clipPath path') as SVGElement;
    expect(clip.getAttribute('d'), '裁剪形状要跟眼睛同形，不然窄眼睛上高光会探出去').toBe(
      'M 1 2 L 3 4 Z'
    );
  });

  it('眼睛转到背面被 display:none 时，高光和腮红一起收起来', () => {
    const { mount, eyeL } = makeBallDom();
    eyeL.setAttribute('transform', 'translate(10 10) scale(1 1) translate(-5 -5)');
    const c = mountCostume(mount, 'anime', { ...raf, animate: false })!;
    (eyeL as unknown as HTMLElement).style.display = 'none';
    c.sync();
    expect(mount.querySelector('.qq-costume__shine')!.getAttribute('opacity')).toBe('0');
    expect(mount.querySelector('.qq-costume__blush')!.getAttribute('opacity')).toBe('0');
  });

  it('减少动效时闪光不加 animate，直接常亮', () => {
    const { mount } = makeBallDom();
    mountCostume(mount, 'anime', { ...raf, animate: false });
    expect(mount.querySelectorAll('animate')).toHaveLength(0);
    expect(mount.querySelector('.qq-costume__spark')!.getAttribute('opacity')).toBe('0.85');

    const b = makeBallDom();
    mountCostume(b.mount, 'anime', { ...raf, animate: true });
    expect(b.mount.querySelectorAll('animate')).toHaveLength(3);
  });

  it('destroy 之后 SVG 回到原样，rAF 也停了', () => {
    const { mount } = makeBallDom();
    const before = (mount.querySelector('svg') as SVGElement).outerHTML;
    const cancel = vi.fn();
    const c = mountCostume(mount, 'anime', { raf: raf.raf, cancel, animate: false })!;
    expect((mount.querySelector('svg') as SVGElement).outerHTML).not.toBe(before);
    c.destroy();
    expect(cancel).toHaveBeenCalled();
    expect((mount.querySelector('svg') as SVGElement).outerHTML).toBe(before);
    c.destroy(); // 幂等
  });
});
