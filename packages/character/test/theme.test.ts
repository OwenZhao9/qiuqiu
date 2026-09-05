/**
 * 主题补丁：对着 vendor 里 `emotions.js` 的**真实** 32 套配置跑一遍，
 * 逐条断言 `design/character.md` § 2 的补丁表。
 *
 * 主题只能走 `EmotionBall.config.register()`（CONTRACTS § 6 的硬约束），
 * 所以这里同时守着「不传 opts.color」与「语义色不被冲掉」两件事。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  applyQiuqiuTheme,
  BODY_COLOR_PATCH,
  QIUQIU_BODY_COLOR,
  QIUQIU_EYE_COLOR,
  UPSTREAM_BASE_COLORS
} from '../src/theme.js';
import { ALL_EMOTION_IDS, type EmotionId, type EmotionRaw } from '../src/types.js';
import { fromRepo } from './helpers/paths.js';
import { loadEmotionSeed, makeStubEmotionBall } from './helpers/stub-engine.js';

const DESIGN = readFileSync(fromRepo('design', 'character.md'), 'utf8');

/** 解析 `design/character.md` § 2 的体色补丁表。 */
function parsePatchTable(): Array<{ id: string; upstream: string; qiuqiu: string }> {
  const start = DESIGN.indexOf('体色补丁表');
  expect(start, 'design/character.md 里找不到体色补丁表').toBeGreaterThan(-1);
  const block = DESIGN.slice(start, DESIGN.indexOf('\n`34` 出错序列里', start));
  const out: Array<{ id: string; upstream: string; qiuqiu: string }> = [];
  for (const line of block.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t.slice(1, -1).split('|').map((c) => c.trim());
    if (cells.length !== 4) continue;
    const m = cells[0]!.match(/`(\d{2})`/);
    if (!m) continue;
    out.push({
      id: m[1]!,
      upstream: cells[1]!.replace(/`/g, ''),
      qiuqiu: cells[2]!.replace(/`/g, '')
    });
  }
  return out;
}

describe('主题补丁表与 design/character.md § 2 一致', () => {
  const rows = parsePatchTable();

  it('设计文档里是 11 行', () => {
    expect(rows).toHaveLength(11);
  });

  it('代码里的 BODY_COLOR_PATCH 与文档逐行一致', () => {
    const fromDoc = Object.fromEntries(rows.map((r) => [r.id, r.qiuqiu]));
    expect(BODY_COLOR_PATCH).toEqual(fromDoc);
  });

  it('文档写的「上游原色」与 vendor 里的实际取值一致', () => {
    const seed = loadEmotionSeed();
    for (const row of rows) {
      const raw = seed.find((r) => r.id === row.id)!;
      expect(raw.body?.color, `emotionId ${row.id}`).toBe(row.upstream);
    }
  });

  it('主题色与眼色就是设计文档写的两个值', () => {
    expect(QIUQIU_BODY_COLOR).toBe('#F2E7D3');
    expect(QIUQIU_EYE_COLOR).toBe('#2A2621');
    expect(DESIGN).toContain('#F2E7D3');
    expect(DESIGN).toContain('#2A2621');
  });
});

describe('applyQiuqiuTheme 打在 vendor 真实配置上', () => {
  function patched(): Map<string, EmotionRaw> {
    const eb = makeStubEmotionBall();
    const res = applyQiuqiuTheme(eb);
    expect(res.ran).toBe(true);
    expect(res.patched).toBe(32);
    expect(res.missing).toEqual([]);
    return eb.registered;
  }

  it('32 个全部重新注册，一个不落', () => {
    const reg = patched();
    for (const id of ALL_EMOTION_IDS) expect(reg.has(id)).toBe(true);
  });

  it('补丁表里的 11 个用表里的值，其余 21 个统一 #F2E7D3', () => {
    const reg = patched();
    for (const id of ALL_EMOTION_IDS) {
      const expected = BODY_COLOR_PATCH[id as EmotionId] ?? QIUQIU_BODY_COLOR;
      expect(reg.get(id)!.body?.color, `emotionId ${id}`).toBe(expected);
    }
  });

  it('21 生气与 34 出错的语义红原样保留（这正是不走 opts.color 的理由）', () => {
    const reg = patched();
    expect(reg.get('21')!.body?.color).toBe('#E4574A');
    expect(reg.get('34')!.body?.color).toBe('#E25B5B');
    expect(reg.get('14')!.body?.color).toBe('#F3D2C6'); // 害羞的暖粉
  });

  it('序列里的上游默认色被换掉，34 红闪的 #DE5555 留着', () => {
    const reg = patched();
    const colors = (id: string): string[] =>
      (reg.get(id)!.sequence?.frames ?? [])
        .map((f) => f.body?.color)
        .filter((c): c is string => typeof c === 'string');

    expect(colors('14')).toEqual([QIUQIU_BODY_COLOR, '#F4D3D0']);
    expect(colors('21')).toEqual([QIUQIU_BODY_COLOR, '#E4574A']);
    expect(colors('34')).toEqual([
      '#E25B5B',
      QIUQIU_BODY_COLOR,
      '#E25B5B',
      QIUQIU_BODY_COLOR,
      '#DE5555'
    ]);
    for (const id of ALL_EMOTION_IDS) {
      for (const c of colors(id)) expect(UPSTREAM_BASE_COLORS).not.toContain(c);
    }
  });

  it('32 个表情都拿到眼色，且表情自带的 eyes.both 字段一个不丢', () => {
    const seed = loadEmotionSeed();
    const reg = patched();
    for (const id of ALL_EMOTION_IDS) {
      const both = reg.get(id)!.eyes?.both as Record<string, unknown> | undefined;
      expect(both, `emotionId ${id} 少了 eyes.both`).toBeTruthy();
      expect(both!.color, `emotionId ${id} 的眼色`).toBe(QIUQIU_EYE_COLOR);

      const original = (seed.find((r) => r.id === id)!.eyes?.both ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(original)) {
        expect(both![k], `emotionId ${id} 的 eyes.both.${k} 被补丁冲掉了`).toEqual(v);
      }
    }
    // 具体盯一个：39 输出回复的 eyes.both.y = -2 必须还在
    expect((reg.get('39')!.eyes?.both as Record<string, unknown>).y).toBe(-2);
  });

  it('上游没有任何一个表情自带眼色，补丁不会覆盖谁', () => {
    for (const raw of loadEmotionSeed()) {
      expect(JSON.stringify(raw.eyes ?? {})).not.toContain('color');
    }
  });

  it('左右眼的差异不受影响（applySpec 先 both 后 left/right）', () => {
    const seed = loadEmotionSeed();
    const reg = patched();
    for (const id of ALL_EMOTION_IDS) {
      const before = seed.find((r) => r.id === id)!.eyes as Record<string, unknown> | undefined;
      const after = reg.get(id)!.eyes as Record<string, unknown>;
      expect(after.left).toEqual(before?.left);
      expect(after.right).toEqual(before?.right);
    }
  });

  it('幂等：同一个 EmotionBall 重复调用不再跑', () => {
    const eb = makeStubEmotionBall();
    expect(applyQiuqiuTheme(eb).ran).toBe(true);
    expect(applyQiuqiuTheme(eb).ran).toBe(false);
    expect(applyQiuqiuTheme(eb, { force: true }).ran).toBe(true);
  });

  it('不改 vendor：补丁跑完后重新读 emotions.js，原始配置一字未动', () => {
    patched();
    const seed = loadEmotionSeed();
    expect(seed.find((r) => r.id === '10')!.body?.color).toBe('#F6EFE4');
    expect(seed.find((r) => r.id === '39')!.eyes).toEqual({ both: { y: -2 } });
  });
});
