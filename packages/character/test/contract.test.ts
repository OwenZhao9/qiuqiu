/**
 * 契约测试：对着 `docs/CONTRACTS.md` § 6 的表情映射表**逐行**断言。
 *
 * 这里不抄表，直接读契约文件、解析出表格、逐行跟代码对。
 * 契约改一个字这个测试就红，不会出现「文档改了代码没跟上」。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  decideEventEmotion,
  decideReplyEmotion,
  ERROR_DECISION,
  EVENT_EMOTION_TABLE
} from '../src/event-map.js';
import { STATE_EMOTION } from '../src/state-machine.js';
import { createQiuqiu } from '../src/engine.js';
import { ALL_EMOTION_IDS, type EmotionId, type MemoryEvent } from '../src/types.js';
import { fromRepo } from './helpers/paths.js';
import { makeStubEmotionBall } from './helpers/stub-engine.js';

const CONTRACTS = readFileSync(fromRepo('docs', 'CONTRACTS.md'), 'utf8');

/** 取 `## 6 · 表情映射` 到下一个 `## ` 之间的原文。 */
function section6(): string {
  const start = CONTRACTS.indexOf('## 6 · 表情映射');
  expect(start, 'docs/CONTRACTS.md 里找不到「## 6 · 表情映射」').toBeGreaterThan(-1);
  const rest = CONTRACTS.slice(start + 3);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

interface ContractRow {
  trigger: string;
  emotionId: string;
  name: string;
}

/** 解析 § 6 的三列表格。 */
function parseRows(): ContractRow[] {
  const rows: ContractRow[] = [];
  for (const line of section6().split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    const cells = t
      .slice(1, t.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => c.trim());
    if (cells.length !== 3) continue;
    const [trigger, emotionId, name] = cells as [string, string, string];
    if (trigger === '触发' || /^-+$/.test(trigger.replace(/[\s:]/g, ''))) continue;
    rows.push({ trigger, emotionId: emotionId.replace(/`/g, ''), name });
  }
  return rows;
}

const NO_SWITCH = '不切换';

const filterEvent = (decision: 'accept' | 'reject' | 'uncertain'): MemoryEvent => ({
  type: 'filter',
  payload: { decision }
});

/** 每一行「触发」对应的代码求值方式。`null` 表示代码判定为不切换。 */
const RESOLVERS: Record<string, () => string | null> = {
  '状态 idle': () => STATE_EMOTION.idle,
  '状态 listening': () => STATE_EMOTION.listening,
  '状态 thinking': () => STATE_EMOTION.thinking,
  '状态 speaking': () => STATE_EMOTION.speaking,
  '事件 filter.reject': () => decideEventEmotion(filterEvent('reject'))?.emotionId ?? null,
  '事件 filter.uncertain': () => decideEventEmotion(filterEvent('uncertain'))?.emotionId ?? null,
  '事件 write': () =>
    decideEventEmotion({
      type: 'write',
      payload: { facts: [{ id: 'f1', text: '用户喜欢喝美式' }] }
    })?.emotionId ?? null,
  '事件 merge': () =>
    decideEventEmotion({ type: 'merge', payload: { result_id: 'm1' } })?.emotionId ?? null,
  '事件 recall（命中）': () =>
    decideEventEmotion({
      type: 'recall',
      payload: { hits: [{ id: 'h1', text: '上周的会议纪要' }], cold_promoted: [] }
    })?.emotionId ?? null,
  '事件 recall（下探冷存储）': () =>
    decideEventEmotion({
      type: 'recall',
      payload: { hits: [{ id: 'h1', text: '去年的旅行' }], cold_promoted: ['c1'] }
    })?.emotionId ?? null,
  回复含拒绝: () =>
    decideReplyEmotion('这类问题我不便回答，建议你咨询专业医生。')?.emotionId ?? null,
  请求出错: () => ERROR_DECISION.emotionId
};

describe('CONTRACTS § 6 表情映射（契约测试）', () => {
  const rows = parseRows();

  it('表格能解析出 12 行', () => {
    expect(rows.map((r) => r.trigger)).toEqual([
      '状态 idle',
      '状态 listening',
      '状态 thinking',
      '状态 speaking',
      '事件 filter.reject',
      '事件 filter.uncertain',
      '事件 write',
      '事件 merge',
      '事件 recall（命中）',
      '事件 recall（下探冷存储）',
      '回复含拒绝',
      '请求出错'
    ]);
  });

  for (const row of parseRows()) {
    it(`「${row.trigger}」→ ${row.emotionId}${row.name === '—' ? '' : ' ' + row.name}`, () => {
      const resolve = RESOLVERS[row.trigger];
      expect(resolve, `契约里出现了代码没实现的触发：${row.trigger}`).toBeTypeOf('function');
      const actual = resolve!();
      if (row.emotionId.replace(/\*/g, '') === NO_SWITCH) {
        expect(actual).toBeNull();
      } else {
        expect(actual).toBe(row.emotionId);
      }
    });
  }

  it('EVENT_EMOTION_TABLE 覆盖契约表里的每一行且只用 32 个合法 ID', () => {
    for (const entry of EVENT_EMOTION_TABLE) {
      if (entry.emotionId !== null) {
        expect(ALL_EMOTION_IDS).toContain(entry.emotionId);
      }
    }
    const ids = EVENT_EMOTION_TABLE.filter((e) => e.emotionId).map((e) => e.emotionId);
    expect(ids).toEqual(['34', '38', '40', '37', '19', '10', '11']);
  });

  it('四态的 emotionId 全部落在 32 个合法 ID 里', () => {
    for (const id of Object.values(STATE_EMOTION)) {
      expect(ALL_EMOTION_IDS).toContain(id as EmotionId);
    }
  });
});

describe('CONTRACTS v0.1.5 的两条硬约束', () => {
  it('契约文件声明的当前版本是 v0.1.5', () => {
    expect(CONTRACTS).toMatch(/当前：\*\*v0\.1\.5\*\*/);
  });

  it('§ 6 写明 feedEnvelope 是容器脉动不是嘴巴', () => {
    const s6 = section6();
    expect(s6).toContain('容器级「发声脉动」');
    expect(s6).toContain('不是嘴巴张合');
  });

  it('§ 6 写明主题色不能走 opts.color', () => {
    const s6 = section6();
    expect(s6).toContain('主题色不能走 `opts.color`');
    expect(s6).toContain('EmotionBall.config.register()');
  });

  it('createQiuqiu 不给引擎传 color / eyeColor', () => {
    const eb = makeStubEmotionBall();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const qq = createQiuqiu(host, { engine: eb });
    const opts = eb.lastCreateOptions!;
    expect(opts).toBeTruthy();
    expect('color' in opts).toBe(false);
    expect('eyeColor' in opts).toBe(false);
    expect(opts.shape).toBe('blob');
    // 主题走的是 config.register 的数据补丁，32 个都打过
    expect(eb.registered.size).toBe(32);
    qq.destroy();
    host.remove();
  });
});
