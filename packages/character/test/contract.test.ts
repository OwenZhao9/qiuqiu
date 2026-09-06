/**
 * 契约测试：对着 `docs/CONTRACTS.md` § 6 的三张表**逐行**断言。
 *
 * 这里不抄表，直接读契约文件、按小节切出表格、逐行跟代码对。
 * 契约改一个字这个测试就红，不会出现「文档改了代码没跟上」。
 *
 * v0.1.6 起 § 6 拆成三张表：
 *   - 状态表情：四态 → emotionId，另有 500 ms 最短停留
 *   - 事件表情：触发 / 判定 / emotionId / 优先级，11 行（含三行「不切换」）
 *   - 引擎自驱：`04` 发呆 / `00` 睡眠 / `01` 唤醒，由闲置策略驱动
 * 再加四段散文约束：情绪推断回退、发声脉动的 `--qq-voice`、主题色不走 `opts.color`、
 * 拒绝式与情绪推断互斥。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { createQiuqiu, IDLE_DEFAULT } from '../src/engine.js';
import { FALLBACK_EMOTION, inferEmotion, RULES } from '../src/emotion.js';
import {
  decideEventEmotion,
  decideReplyEmotion,
  decideSubmitEmotion,
  ERROR_DECISION,
  STOP_DECISION,
  EVENT_EMOTION_TABLE,
  type EventEmotionDecision,
  type EventRuleKey
} from '../src/event-map.js';
import {
  EVENT_EMOTION_MS,
  MIN_DWELL_MS,
  SLEEP_EMOTION,
  STATE_EMOTION,
  WAKE_EMOTION
} from '../src/state-machine.js';
import {
  ALL_EMOTION_IDS,
  ALL_STATES,
  type CharacterState,
  type EmotionId,
  type MemoryEvent
} from '../src/types.js';
import { fromRepo } from './helpers/paths.js';
import { makeStubEmotionBall } from './helpers/stub-engine.js';

const CONTRACTS = readFileSync(fromRepo('docs', 'CONTRACTS.md'), 'utf8');

/**
 * 契约当前版本。**保持精确匹配，不要改成宽松匹配、更不要删。**
 * 这个钉子的作用就是每次契约升版都逼着回去把 § 6 的三张表与四段散文重核一遍，
 * 确认无关才改这一行；核对结论记在下面。
 *
 * v0.1.7（收编 memory 报的十一条缺口）改的是 § 1 / § 3 / § 5，
 * § 6 六个小节与 v0.1.6 逐字一致，本文件的断言无需改动。
 */
const CONTRACT_VERSION = 'v0.1.17';

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/** 取 `## 6 · 表情映射` 到下一个 `## ` 之间的原文。 */
function section6(): string {
  const start = CONTRACTS.indexOf('## 6 · 表情映射');
  expect(start, 'docs/CONTRACTS.md 里找不到「## 6 · 表情映射」').toBeGreaterThan(-1);
  const rest = CONTRACTS.slice(start + 3);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

/** 取 § 6 里某个 `### 小节` 到下一个 `### ` 之间的原文。 */
function subsection(title: string): string {
  const s6 = section6();
  const start = s6.indexOf(`### ${title}`);
  expect(start, `docs/CONTRACTS.md § 6 里找不到小节「${title}」`).toBeGreaterThan(-1);
  const rest = s6.slice(start + 4);
  const end = rest.indexOf('\n### ');
  return end === -1 ? rest : rest.slice(0, end);
}

function isSeparator(cells: readonly string[]): boolean {
  return cells.every((c) => /^:?-+:?$/.test(c));
}

/**
 * 解析一段文本里的**第一张** markdown 表格。
 * 返回表头与数据行，单元格已 trim；不去反引号，反引号本身也是契约的一部分。
 */
function parseTable(block: string): { header: string[]; rows: string[][] } {
  const lines = block.split('\n').filter((l) => l.trim().startsWith('|'));
  expect(lines.length, '这一小节里没有表格').toBeGreaterThan(2);
  const cut = (line: string): string[] => {
    const t = line.trim();
    return t
      .slice(1, t.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((c) => c.trim());
  };
  const all = lines.map(cut);
  const header = all[0]!;
  const rows: string[][] = [];
  for (const cells of all.slice(1)) {
    if (isSeparator(cells)) continue;
    if (cells.length !== header.length) break; // 后面是另一张表了
    rows.push(cells);
  }
  return { header, rows };
}

/** 去掉反引号与加粗星号，用来跟代码里的字符串比。 */
function plain(cell: string): string {
  return cell.replace(/[`*]/g, '').trim();
}

const NO_SWITCH = '不切换';

/* ------------------------------------------------------------------ *
 * 状态表情
 * ------------------------------------------------------------------ */

describe('CONTRACTS § 6 · 状态表情', () => {
  const { header, rows } = parseTable(subsection('状态表情'));

  it('表头是「状态 / emotionId / Emotion Ball 名」', () => {
    expect(header).toEqual(['状态', 'emotionId', 'Emotion Ball 名']);
  });

  it('四行，且与代码里的四态一一对应', () => {
    expect(rows.map((r) => plain(r[0]!))).toEqual([...ALL_STATES]);
  });

  for (const row of rows) {
    const state = plain(row[0]!) as CharacterState;
    const emotionId = plain(row[1]!);
    it(`${state} → ${emotionId} ${plain(row[2]!)}`, () => {
      expect(STATE_EMOTION[state]).toBe(emotionId);
      expect(ALL_EMOTION_IDS).toContain(emotionId as EmotionId);
    });
  }

  it('最短停留 500 ms 与 MIN_DWELL_MS 一致', () => {
    const text = subsection('状态表情');
    const m = text.match(/最短停留\s*\*\*(\d+)\s*ms\*\*/);
    expect(m, '状态表情小节里找不到「最短停留 **N ms**」').not.toBeNull();
    expect(MIN_DWELL_MS).toBe(Number(m![1]));
  });
});

/* ------------------------------------------------------------------ *
 * 事件表情
 * ------------------------------------------------------------------ */

interface EventCase {
  /** `EVENT_EMOTION_TABLE` 里对应的行标识，用来核对代码表的行序。 */
  rule: EventRuleKey;
  /** 契约「判定」列里必须出现的片段。文档改判定条件这里就红。 */
  judge: string[];
  /** 按契约的判定条件构造输入，跑一遍实现。 */
  run(): EventEmotionDecision | null;
  /** 判定条件的反例：不满足时必须**不**落到这一行。 */
  negative?: { run(): EventEmotionDecision | null; expect: EmotionId | null };
}

const filterEvent = (decision: 'accept' | 'reject' | 'uncertain'): MemoryEvent => ({
  type: 'filter',
  payload: { decision }
});

const recallEvent = (hits: number, cold: number): MemoryEvent => ({
  type: 'recall',
  payload: {
    hits: Array.from({ length: hits }, (_, i) => ({ id: `h${i}`, text: '上周的会议纪要' })),
    cold_promoted: Array.from({ length: cold }, (_, i) => `c${i}`)
  }
});

const writeEvent = (facts: number): MemoryEvent => ({
  type: 'write',
  payload: { facts: Array.from({ length: facts }, (_, i) => ({ id: `f${i}`, text: '喝美式' })) }
});

/** 拒绝式与情绪推断都命中的文本：「抱歉」会中 R06，拒绝式优先。 */
const REFUSAL_TEXT = '抱歉，这类问题我不便回答，建议你咨询专业医生。';
/** 只中情绪推断的文本：R16 开心。 */
const HAPPY_TEXT = '太好了，那这周就照这个节奏来。';
/** 17 条规则一条都不中的文本。 */
const NEUTRAL_TEXT = '以下是三种可选方案。第一种是把两份笔记按时间线并列。';

/** 契约「触发」列（去掉反引号后）→ 怎么跑实现。 */
const EVENT_CASES: Record<string, EventCase> = {
  用户点停止: {
    rule: 'stop',
    judge: ['中止本轮'],
    run: () => STOP_DECISION
  },
  请求出错: {
    rule: 'error',
    judge: ['error'],
    run: () => ERROR_DECISION
  },
  回复含拒绝: {
    rule: 'refusal',
    judge: ['done', '拒绝式'],
    run: () => decideReplyEmotion(REFUSAL_TEXT)
  },
  'recall（下探冷存储）': {
    rule: 'recall.cold_promoted',
    judge: ['payload.cold_promoted.length > 0'],
    run: () => decideEventEmotion(recallEvent(1, 1)),
    negative: { run: () => decideEventEmotion(recallEvent(1, 0)), expect: '37' }
  },
  'recall（命中）': {
    rule: 'recall.hit',
    judge: ['payload.hits.length > 0', 'cold_promoted'],
    run: () => decideEventEmotion(recallEvent(1, 0)),
    negative: { run: () => decideEventEmotion(recallEvent(0, 0)), expect: null }
  },
  merge: {
    rule: 'merge',
    judge: ['type === "merge"'],
    run: () => decideEventEmotion({ type: 'merge', payload: { result_id: 'm1' } })
  },
  write: {
    rule: 'write',
    judge: ['payload.facts.length > 0'],
    run: () => decideEventEmotion(writeEvent(1)),
    negative: { run: () => decideEventEmotion(writeEvent(0)), expect: null }
  },
  'filter.uncertain': {
    rule: 'filter.uncertain',
    judge: ['payload.decision === "uncertain"'],
    run: () => decideEventEmotion(filterEvent('uncertain'))
  },
  情绪推断: {
    rule: 'inferred',
    judge: ['done', 'design/emotion-rules.md'],
    run: () => decideReplyEmotion(HAPPY_TEXT),
    negative: { run: () => decideReplyEmotion(NEUTRAL_TEXT), expect: null }
  },
  'filter.reject': {
    rule: 'filter.reject',
    judge: ['payload.decision === "reject"'],
    run: () => decideEventEmotion(filterEvent('reject'))
  },
  'filter.accept': {
    rule: 'filter.accept',
    judge: ['payload.decision === "accept"'],
    run: () => decideEventEmotion(filterEvent('accept'))
  },
  'recall（空命中）': {
    rule: 'recall.empty',
    judge: ['hits', 'cold_promoted', '都为空'],
    run: () => decideEventEmotion(recallEvent(0, 0))
  },
  用户按下发送: {
    rule: 'submit',
    judge: ['无附件'],
    run: () => decideSubmitEmotion(false)
  },
  '用户按下发送（带图片）': {
    rule: 'submit.images',
    judge: ['attachments.length > 0'],
    run: () => decideSubmitEmotion(true)
  }
};

/** `10`–`21` 情绪区间，契约里 `情绪推断` 那行写的是区间不是单个 ID。 */
function isReactionRange(cell: string): boolean {
  return /^10.*21.*之一$/.test(plain(cell).replace(/\s/g, ''));
}

describe('CONTRACTS § 6 · 事件表情', () => {
  const block = subsection('事件表情');
  const { header, rows } = parseTable(block);

  it('表头是「触发 / 判定 / emotionId / Emotion Ball 名 / 优先级」', () => {
    expect(header).toEqual(['触发', '判定', 'emotionId', 'Emotion Ball 名', '优先级']);
  });

  it('14 行，且每一行代码里都认识', () => {
    expect(rows).toHaveLength(14);
    for (const row of rows) {
      const trigger = plain(row[0]!);
      expect(EVENT_CASES[trigger], `契约里出现了代码没实现的触发：${trigger}`).toBeTruthy();
    }
  });

  it('EVENT_EMOTION_TABLE 的行序与契约表逐行一致', () => {
    expect(EVENT_EMOTION_TABLE.map((e) => e.rule)).toEqual(
      rows.map((r) => EVENT_CASES[plain(r[0]!)]!.rule)
    );
  });

  for (const row of rows) {
    const trigger = plain(row[0]!);
    const judgeCell = row[1]!;
    const idCell = row[2]!;
    const priorityCell = plain(row[4]!);
    const c = EVENT_CASES[trigger]!;
    const label = plain(idCell) === NO_SWITCH ? '不切换' : plain(idCell);

    it(`「${trigger}」判定「${plain(judgeCell)}」→ ${label}（优先级 ${priorityCell}）`, () => {
      // 判定列：契约写的条件必须真的是实现在判的那一个
      for (const frag of c.judge) {
        expect(judgeCell, `「${trigger}」的判定列里应当出现「${frag}」`).toContain(frag);
      }

      const actual = c.run();

      if (plain(idCell) === NO_SWITCH) {
        expect(actual, `契约写「不切换」，实现却切了 ${actual?.emotionId}`).toBeNull();
        expect(priorityCell, '「不切换」的行不该有优先级').toBe('—');
        return;
      }

      expect(actual, `契约写要切 ${plain(idCell)}，实现却没切`).not.toBeNull();

      // emotionId 列：单个 ID 就精确比，`10`–`21` 之一就比区间
      if (isReactionRange(idCell)) {
        expect(Number(actual!.emotionId)).toBeGreaterThanOrEqual(10);
        expect(Number(actual!.emotionId)).toBeLessThanOrEqual(21);
      } else {
        expect(actual!.emotionId).toBe(plain(idCell));
        expect(ALL_EMOTION_IDS).toContain(actual!.emotionId);
      }

      // 优先级列
      expect(priorityCell).toMatch(/^\d+$/);
      expect(actual!.priority).toBe(Number(priorityCell));

      // 判定条件的反例
      if (c.negative) {
        const neg = c.negative.run();
        expect(neg?.emotionId ?? null).toBe(c.negative.expect);
      }
    });
  }

  it('三行「不切换」正好是 filter.reject / filter.accept / recall 空命中', () => {
    const noSwitch = rows.filter((r) => plain(r[2]!) === NO_SWITCH).map((r) => plain(r[0]!));
    expect(noSwitch).toEqual(['filter.reject', 'filter.accept', 'recall（空命中）']);
  });

  it('优先级数值在契约里从上到下不递增（同级允许并列）', () => {
    const ps = rows
      .map((r) => plain(r[4]!))
      .filter((p) => /^\d+$/.test(p))
      .map(Number);
    for (let i = 1; i < ps.length; i++) expect(ps[i]!).toBeLessThanOrEqual(ps[i - 1]!);
  });

  it('持续 1600 ms，与 EVENT_EMOTION_MS 一致', () => {
    const m = block.match(/持续\s*\*\*(\d+)\s*ms\*\*/);
    expect(m, '事件表情小节里找不到「持续 **N ms**」').not.toBeNull();
    expect(EVENT_EMOTION_MS).toBe(Number(m![1]));
  });

  it('写明优先于状态表情、回到「当前」状态的表情、不排队', () => {
    expect(block).toContain('优先于状态表情');
    expect(block).toContain('当前');
    expect(block).toContain('不排队');
  });

  it('拒绝式与情绪推断互斥：两条都命中的文本只出 38', () => {
    expect(block).toContain('互斥');
    // 「抱歉」本来会中 R06 → 12 失落，拒绝式命中后不再叠情绪
    expect(inferEmotion(REFUSAL_TEXT)).toBe('12');
    const d = decideReplyEmotion(REFUSAL_TEXT);
    expect(d?.emotionId).toBe('38');
    expect(d?.rule).toBe('refusal');
  });
});

/* ------------------------------------------------------------------ *
 * 引擎自驱
 * ------------------------------------------------------------------ */

describe('CONTRACTS § 6 · 引擎自驱', () => {
  const { header, rows } = parseTable(subsection('引擎自驱'));

  it('表头是「时机 / emotionId / Emotion Ball 名」，三行', () => {
    expect(header).toEqual(['时机', 'emotionId', 'Emotion Ball 名']);
    expect(rows.map((r) => plain(r[1]!))).toEqual(['04', '00', '01']);
  });

  for (const row of rows) {
    const when = plain(row[0]!);
    const emotionId = plain(row[1]!) as EmotionId;
    it(`${when} → ${emotionId} ${plain(row[2]!)}`, () => {
      expect(ALL_EMOTION_IDS).toContain(emotionId);
      const seconds = when.match(/满\s*(\d+)\s*s/);
      switch (emotionId) {
        case '04':
          expect(IDLE_DEFAULT.standbyId).toBe('04');
          expect(IDLE_DEFAULT.standbyAfter).toBe(Number(seconds![1]) * 1000);
          break;
        case '00':
          expect(IDLE_DEFAULT.sleepId).toBe('00');
          expect(IDLE_DEFAULT.sleepAfter).toBe(Number(seconds![1]) * 1000);
          expect(SLEEP_EMOTION).toBe('00');
          break;
        case '01':
          expect(WAKE_EMOTION).toBe('01');
          break;
        default:
          throw new Error(`引擎自驱表里出现了代码没实现的 ID：${emotionId}`);
      }
    });
  }

  it('这三个都不在状态表情与事件表情里', () => {
    const stateIds = Object.values(STATE_EMOTION) as string[];
    const eventIds = EVENT_EMOTION_TABLE.map((e) => e.emotionId).filter(Boolean) as string[];
    for (const id of ['04', '00', '01']) {
      expect(stateIds).not.toContain(id);
      expect(eventIds).not.toContain(id);
    }
  });
});

/* ------------------------------------------------------------------ *
 * 情绪推断 / 发声脉动 / 主题色
 * ------------------------------------------------------------------ */

describe('CONTRACTS § 6 · 情绪推断', () => {
  const block = subsection('情绪推断');

  it('条数与区间跟契约一致，且落在 emotion.ts', () => {
    expect(block).toContain('src/emotion.ts');
    const m = block.match(/(\d+)\s*条规则/);
    expect(m, '情绪推断小节里找不到「N 条规则」').not.toBeNull();
    expect(RULES).toHaveLength(Number(m![1]));
    for (const rule of RULES) {
      expect(Number(rule.emotionId)).toBeGreaterThanOrEqual(10);
      expect(Number(rule.emotionId)).toBeLessThanOrEqual(21);
    }
  });

  it('无规则命中时回退 02', () => {
    const m = block.match(/无规则命中时回退\s*`(\d{2})`/);
    expect(m, '情绪推断小节里找不到「无规则命中时回退 `NN`」').not.toBeNull();
    expect(FALLBACK_EMOTION).toBe(m![1]);
    expect(inferEmotion(NEUTRAL_TEXT)).toBe(m![1]);
    // 回退值等于 idle 的状态表情，所以不作为事件表情切出去
    expect(STATE_EMOTION.idle).toBe(m![1]);
    expect(decideReplyEmotion(NEUTRAL_TEXT)).toBeNull();
  });
});

describe('CONTRACTS § 6 · 发声脉动', () => {
  const block = subsection('发声脉动');

  it('写明是容器脉动不是嘴巴', () => {
    expect(block).toContain('容器级「发声脉动」');
    expect(block).toContain('不是嘴巴张合');
  });

  it('CSS 变量名与小数位跟实现一致', () => {
    const m = block.match(/\*\*`(--[a-z-]+)`\*\*/);
    expect(m, '发声脉动小节里找不到加粗的 CSS 变量名').not.toBeNull();
    const varName = m![1]!;
    expect(varName).toBe('--qq-voice');
    expect(block).toContain('三位小数');

    const eb = makeStubEmotionBall();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const qq = createQiuqiu(host, { engine: eb, gaze: false });
    // stage 自带内联样式，宿主不引任何 CSS 也能跑
    expect(qq.stage.style.getPropertyValue(varName)).toBe('0');
    expect(qq.stage.style.transform).toContain(`var(${varName})`);
    qq.destroy();
    host.remove();
  });
});

describe('CONTRACTS § 6 · 主题色', () => {
  const block = subsection('主题色');

  it('写明不能走 opts.color，要用 config.register', () => {
    expect(block).toContain('主题色不能走 `opts.color`');
    expect(block).toContain('EmotionBall.config.register()');
  });

  it('createQiuqiu 不给引擎传 color / eyeColor，32 个表情全打过补丁', () => {
    const eb = makeStubEmotionBall();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const qq = createQiuqiu(host, { engine: eb });
    const opts = eb.lastCreateOptions!;
    expect(opts).toBeTruthy();
    expect('color' in opts).toBe(false);
    expect('eyeColor' in opts).toBe(false);
    expect(opts.shape).toBe('blob');
    expect(eb.registered.size).toBe(32);
    qq.destroy();
    host.remove();
  });
});

describe('CONTRACTS 版本', () => {
  it(`契约文件声明的当前版本是 ${CONTRACT_VERSION}`, () => {
    const m = CONTRACTS.match(/当前：\*\*(v[\d.]+)\*\*/);
    expect(m, 'docs/CONTRACTS.md § 8 里找不到「当前：**vX.Y.Z**」').not.toBeNull();
    expect(m![1]).toBe(CONTRACT_VERSION);
  });

  it('§ 6 只有这七个小节', () => {
    const titles = [...section6().matchAll(/^### (.+)$/gm)].map((m) => m[1]!.trim());
    expect(titles).toEqual([
      '状态表情',
      '事件表情',
      '引擎自驱',
      '情绪推断',
      '发声脉动',
      '主题色',
      '形象'
    ]);
  });
});
