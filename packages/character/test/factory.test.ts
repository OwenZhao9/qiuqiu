/**
 * 出厂默认（`docs/CONTRACTS.md` § 9）。
 *
 * 表在文档里，值在 `src/defaults.ts` 里，这份测试逼两边对上：文档改一个字就红。
 * Python 那边有一条对称的（`packages/memory/tests/test_memory_contracts.py`
 * ::TestFactoryDefaults），两条合起来盖住「三个包对出厂默认的理解一致」。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { FACTORY, FACTORY_STATE_EMOTION } from '../src/defaults.js';
import { SUBMIT_EMOTION_MS } from '../src/event-map.js';
import {
  EVENT_EMOTION_MS,
  MIN_DWELL_MS,
  REPLY_EMOTION_MS,
  STATE_EMOTION
} from '../src/state-machine.js';
import { ALL_EMOTION_IDS, ALL_STATES } from '../src/types.js';
import { fromRepo } from './helpers/paths.js';

const CONTRACTS = readFileSync(fromRepo('docs', 'CONTRACTS.md'), 'utf8');

/** § 9 那张出厂表：项 → 出厂值（反引号剥掉）。 */
function factoryTable(): Map<string, string> {
  const start = CONTRACTS.indexOf('## 9 · 出厂默认');
  expect(start, 'docs/CONTRACTS.md 里找不到「## 9 · 出厂默认」').toBeGreaterThan(-1);
  const rest = CONTRACTS.slice(start + 3);
  const end = rest.indexOf('\n## ');
  const body = end === -1 ? rest : rest.slice(0, end);

  const rows = new Map<string, string>();
  for (const line of body.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
    if (cells.length < 2) continue;
    if (cells[0] === '项' || /^:?-+:?$/.test(cells[0] ?? '')) continue;
    rows.set(cells[0]!, (cells[1] ?? '').replace(/`/g, ''));
  }
  expect(rows.size, '§ 9 里没解析到出厂表').toBeGreaterThan(0);
  return rows;
}

describe('出厂默认 · 契约 § 9', () => {
  it('皮肤与人格预设跟契约的表逐字一致', () => {
    const table = factoryTable();
    expect(FACTORY.skin).toBe(table.get('皮肤'));
    expect(FACTORY.personaPreset).toBe(table.get('人格预设'));
  });

  it('默认是可爱风，不是素净也不是真空', () => {
    // 这一条不是重复上一条：上一条盯的是「代码跟文档一致」，
    // 这一条盯的是「产品决定本身」——把默认改回素净要先改这行，改不动就是提醒
    expect(FACTORY.skin).toBe('kawaii');
    expect(FACTORY.personaPreset).toBe('cute');
  });

  it('表情的调度权在系统，不给模型', () => {
    // 契约 § 9 的硬约束在代码里有个名字，而不是只写在文档里
    expect(FACTORY.emotion.decidedBy).toBe('system');
    const body = CONTRACTS.slice(CONTRACTS.indexOf('## 9 · 出厂默认'));
    expect(body).toContain('不往上送');
    expect(body).toContain('不从下取');
  });

  it('时长常量都从出厂表来，没有第二处字面量', () => {
    expect(MIN_DWELL_MS).toBe(FACTORY.emotion.minDwellMs);
    expect(EVENT_EMOTION_MS).toBe(FACTORY.emotion.eventHoldMs);
    expect(REPLY_EMOTION_MS).toBe(FACTORY.emotion.replyHoldMs);
    expect(SUBMIT_EMOTION_MS).toBe(FACTORY.emotion.submitHoldMs);
  });

  it('回复情绪比事件表情停得久', () => {
    // 事件是一闪而过的提示，「这句话的情绪」是这句话本身的脸
    expect(FACTORY.emotion.replyHoldMs).toBeGreaterThan(FACTORY.emotion.eventHoldMs);
  });

  it('出厂状态表情与状态机里的一致，且都是引擎认的 id', () => {
    for (const state of ALL_STATES) {
      expect(FACTORY_STATE_EMOTION[state]).toBe(STATE_EMOTION[state]);
      expect(ALL_EMOTION_IDS).toContain(STATE_EMOTION[state]);
    }
  });
});
