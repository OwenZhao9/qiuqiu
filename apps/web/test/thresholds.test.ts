/** 阈值面板的纯逻辑，`design/memory-panel.md` § 5 与契约 § 1 的判定。 */

import { describe, expect, it } from 'vitest';
import {
  clampThresholds,
  compactLabel,
  decide,
  DEFAULT_THRESHOLDS,
  MIN_GAP,
  previewDiff,
  trackGradient
} from '../src/store/thresholds.js';
import { makeEvent } from './helpers.js';

describe('decide', () => {
  it('score >= accept 是保留，>= uncertain 是拿不准，其余丢掉', () => {
    const t = DEFAULT_THRESHOLDS;
    expect(decide(0.9, t)).toBe('accept');
    expect(decide(0.72, t)).toBe('accept'); // 边界取等
    expect(decide(0.71, t)).toBe('uncertain');
    expect(decide(0.45, t)).toBe('uncertain');
    expect(decide(0.44, t)).toBe('reject');
  });
});

describe('clampThresholds', () => {
  it('默认值是 0.72 / 0.45', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ accept: 0.72, uncertain: 0.45 });
  });

  it('拖保留线压过来时，丢弃线被顶着走，不弹错误', () => {
    const out = clampThresholds({ accept: 0.4, uncertain: 0.45 }, 'accept');
    expect(out.accept).toBe(0.4);
    expect(out.uncertain).toBe(0.35);
    expect(out.accept - out.uncertain).toBeCloseTo(MIN_GAP, 5);
  });

  it('拖丢弃线顶上去时，保留线被顶着走', () => {
    const out = clampThresholds({ accept: 0.72, uncertain: 0.8 }, 'uncertain');
    expect(out.uncertain).toBe(0.8);
    expect(out.accept).toBe(0.85);
  });

  it('钳到 0–1，且不留浮点尾巴', () => {
    expect(clampThresholds({ accept: 1.4, uncertain: -0.3 }, 'accept')).toEqual({
      accept: 1,
      uncertain: 0
    });
    expect(clampThresholds({ accept: 0.7200000000000001, uncertain: 0.45 }, 'accept').accept).toBe(
      0.72
    );
  });

  it('两条线合法时原样放行', () => {
    expect(clampThresholds({ accept: 0.8, uncertain: 0.3 }, 'accept')).toEqual({
      accept: 0.8,
      uncertain: 0.3
    });
  });
});

describe('previewDiff', () => {
  const events = [
    makeEvent('filter', { decision: 'reject', score: 0.5, input_preview: 'a' }),
    makeEvent('filter', { decision: 'reject', score: 0.55, input_preview: 'b' }),
    makeEvent('filter', { decision: 'accept', score: 0.95, input_preview: 'c' }),
    makeEvent('write', { facts: [] })
  ];

  it('两种方向的改判会一起说出来', () => {
    // accept=0.96 把 0.95 从保留降成拿不准；uncertain=0.5 把 0.5 / 0.55 从丢掉升成拿不准
    const out = previewDiff(events, { accept: 0.96, uncertain: 0.5 });
    expect(out.changed).toBe(3);
    expect(out.text).toContain('2 条会从丢掉变成拿不准');
    expect(out.text).toContain('1 条会从保留变成拿不准');
  });

  it('数出有多少条会改判，只看 filter 事件', () => {
    const out = previewDiff(events, { accept: 0.72, uncertain: 0.45 });
    expect(out.sampled).toBe(3); // write 不参与
    expect(out.changed).toBe(2); // 0.5 与 0.55 从丢掉变成拿不准
    expect(out.text).toContain('2 条会从丢掉变成拿不准');
  });

  it('完全没有差异时换成「与当前一致」', () => {
    const same = [makeEvent('filter', { decision: 'accept', score: 0.9 })];
    expect(previewDiff(same, DEFAULT_THRESHOLDS).text).toBe('与当前一致');
  });
});

describe('轨道与标签', () => {
  it('三段渐变的分界跟着两个值走', () => {
    const css = trackGradient({ accept: 0.72, uncertain: 0.45 });
    expect(css).toContain('var(--qq-color-reject) 45%');
    expect(css).toContain('var(--qq-color-uncertain) 45%');
    expect(css).toContain('var(--qq-color-write) 72%');
  });

  it('折叠时的紧凑形式是 0.72 / 0.45', () => {
    expect(compactLabel(DEFAULT_THRESHOLDS)).toBe('0.72 / 0.45');
  });
});
