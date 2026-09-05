/**
 * 情绪推断：规则表逐行对着 `design/emotion-rules.md` 断言，
 * 九种情绪 + 默认回退 `02` 逐个覆盖。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  inferEmotion,
  isRefusal,
  lastSentenceOf,
  normalize,
  REFUSAL,
  RULES,
  FALLBACK_EMOTION,
  type Scope
} from '../src/emotion.js';
import { fromRepo } from './helpers/paths.js';

const DOC = readFileSync(fromRepo('design', 'emotion-rules.md'), 'utf8');

interface DocRule {
  id: string;
  priority: number;
  scope: Scope;
  pattern: string;
  emotionId: string;
}

/** 从 `design/emotion-rules.md` § 5 的可粘贴 `RULES` 数组里解析出 17 条规则。 */
function parseDocRules(): DocRule[] {
  const start = DOC.indexOf('export const RULES: EmotionRule[] = [');
  expect(start, 'design/emotion-rules.md 里找不到 RULES 数组').toBeGreaterThan(-1);
  const block = DOC.slice(start, DOC.indexOf('\n];', start));
  const re =
    /\{\s*id:\s*'(R\d+)',\s*priority:\s*(\d+),\s*scope:\s*'(\w+)',\s*\n?\s*pattern:\s*(\/.*?\/u),\s*emotionId:\s*'(\d+)'\s*\}/g;
  const out: DocRule[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    out.push({
      id: m[1]!,
      priority: Number(m[2]),
      scope: m[3] as Scope,
      pattern: m[4]!,
      emotionId: m[5]!
    });
  }
  return out;
}

describe('规则表与 design/emotion-rules.md 逐行一致', () => {
  const docRules = parseDocRules();

  it('设计文档里解析出 17 条规则', () => {
    expect(docRules.map((r) => r.id)).toEqual([
      'R01',
      'R02',
      'R03',
      'R04',
      'R05',
      'R06',
      'R07',
      'R08',
      'R09',
      'R10',
      'R11',
      'R12',
      'R13',
      'R14',
      'R15',
      'R16',
      'R17'
    ]);
  });

  it('代码里的 RULES 条数与顺序一致', () => {
    expect(RULES.map((r) => r.id)).toEqual(docRules.map((r) => r.id));
  });

  for (const [i, doc] of docRules.entries()) {
    it(`${doc.id}（P${doc.priority} / ${doc.scope} → ${doc.emotionId}）与文档逐字一致`, () => {
      const code = RULES[i]!;
      expect(code.id).toBe(doc.id);
      expect(code.priority).toBe(doc.priority);
      expect(code.scope).toBe(doc.scope);
      expect(code.emotionId).toBe(doc.emotionId);
      expect(code.pattern.toString()).toBe(doc.pattern);
    });
  }

  it('REFUSAL 与文档逐字一致', () => {
    const m = DOC.match(/export const REFUSAL = (\/.*?\/u);/);
    expect(m, 'design/emotion-rules.md 里找不到 REFUSAL').toBeTruthy();
    expect(REFUSAL.toString()).toBe(m![1]);
  });

  it('RULES 已按 priority 降序、同级按 id 升序排好', () => {
    for (let i = 1; i < RULES.length; i++) {
      const prev = RULES[i - 1]!;
      const cur = RULES[i]!;
      expect(prev.priority).toBeGreaterThanOrEqual(cur.priority);
      if (prev.priority === cur.priority) expect(prev.id < cur.id).toBe(true);
    }
  });

  it('没有一条 pattern 带 g 标志（避免 lastIndex 副作用）', () => {
    for (const r of RULES) expect(r.pattern.global).toBe(false);
    expect(REFUSAL.global).toBe(false);
  });

  it('所有 emotionId 都落在 10–21 情绪区间', () => {
    const allowed = new Set(['10', '11', '12', '13', '14', '18', '19', '20', '21']);
    for (const r of RULES) expect(allowed.has(r.emotionId)).toBe(true);
  });
});

describe('inferEmotion 覆盖九种情绪与默认回退', () => {
  const cases: Array<[string, string, string]> = [
    ['21 生气', '这种把用户数据卖掉的做法，实在让人火大。', '21'],
    ['21 生气（R02）', '同样的坑踩第三次，我真的看不下去了。', '21'],
    ['13 惊讶', '你居然三个月前就跟我说过这件事。', '13'],
    ['13 惊讶（R04 末句连叹号）', '这条记录还在！！', '13'],
    ['14 害羞', '你这么说，夸得我有点不好意思了。', '14'],
    ['14 害羞（R05 补的「这么夸」）', '你这么夸我，我有点不好意思。', '14'],
    ['12 失落', '抱歉，这次没能帮你找到那份笔记。', '12'],
    ['12 失落（R07）', '可惜那段录音在写入前就被清掉了。', '12'],
    ['18 无奈', '接口没开放，我也只好先手动记一条。', '18'],
    ['18 无奈（R09）', '两边时间都写死了，这确实有点难办。', '18'],
    ['11 疑惑', '你是说上周提到的那份会议纪要吗', '11'],
    ['11 疑惑（R11 末句问号）', '先从哪一条开始整理？', '11'],
    ['20 困惑', '这段话我没太看懂，先按字面记下了。', '20'],
    ['20 困惑（R13）', '这两条记忆里的日期对不上。', '20'],
    ['19 满意', '三条都已经记下，搞定。', '19'],
    ['19 满意（R15）', '时间线终于对上了。', '19'],
    ['10 开心', '太好了，那这周就照这个节奏来。', '10'],
    ['10 开心（R17 末句波浪号）', '随时喊我～', '10'],
    ['02 回退', '以下是三种可选方案。第一种……', '02']
  ];

  for (const [label, input, expected] of cases) {
    it(`${label}：${JSON.stringify(input)} → ${expected}`, () => {
      expect(inferEmotion(input)).toBe(expected);
    });
  }

  it('九种情绪全部被覆盖到', () => {
    const hit = new Set(cases.map(([, input]) => inferEmotion(input)));
    expect([...hit].sort()).toEqual(['02', '10', '11', '12', '13', '14', '18', '19', '20', '21']);
  });

  it('任务书验收：inferEmotion("太好了！") → 10，"抱歉我做不到" → 12', () => {
    expect(inferEmotion('太好了！')).toBe('10');
    expect(inferEmotion('抱歉我做不到')).toBe('12');
  });
});

describe('design/emotion-rules.md § 3 的三个易判错组合', () => {
  it('「不好意思，我没查到那条记录。」→ 12 失落（不是害羞）', () => {
    expect(inferEmotion('不好意思，我没查到那条记录。')).toBe('12');
  });

  it('「你这么夸我，我有点不好意思。」→ 14 害羞（R05 已补「这么夸」）', () => {
    expect(inferEmotion('你这么夸我，我有点不好意思。')).toBe('14');
  });

  it('「这两条对不上，你是说哪一条？」→ 11 疑惑（R11 P50 先于 R13 P45）', () => {
    expect(inferEmotion('这两条对不上，你是说哪一条？')).toBe('11');
  });

  it('「太好了，我已经记下了！」→ 19 满意（R14 P40 先于 R16 P30）', () => {
    expect(inferEmotion('太好了，我已经记下了！')).toBe('19');
  });
});

describe('预处理与作用域', () => {
  it('围栏代码块被去掉，注释里的「有问题」不误触发', () => {
    const raw = '这是实现：\n```js\n// TODO: 这里有问题，我没看懂\n```\n以上。';
    expect(normalize(raw)).not.toContain('没看懂');
    expect(inferEmotion(raw)).toBe(FALLBACK_EMOTION);
  });

  it('行内代码、markdown 链接与裸 URL 都被去掉', () => {
    const raw = '看 `console.log` 与 [文档](https://example.com) 还有 https://a.b/c 就行。';
    const n = normalize(raw);
    expect(n).not.toContain('console.log');
    expect(n).not.toContain('http');
  });

  it('lastSentenceOf 保留连续标点，不把「！！」切开', () => {
    expect(lastSentenceOf('这条记录还在！！')).toBe('这条记录还在！！');
    expect(lastSentenceOf('这里有三种做法。你想先试哪一种？')).toBe('你想先试哪一种？');
  });

  it('空文本与非字符串都回退 02', () => {
    expect(inferEmotion('')).toBe(FALLBACK_EMOTION);
    expect(inferEmotion('   \n  ')).toBe(FALLBACK_EMOTION);
    expect(inferEmotion(undefined as unknown as string)).toBe(FALLBACK_EMOTION);
  });

  it('是纯函数：同样输入连调 3 次结果相同', () => {
    const t = '这条记录还在！！';
    expect([inferEmotion(t), inferEmotion(t), inferEmotion(t)]).toEqual(['13', '13', '13']);
  });
});

describe('拒绝式（§ 4）', () => {
  const hits = [
    '这个请求我不能完成，换个说法我再试试。',
    '这超出我的能力范围了。',
    '这类问题我不便回答。',
    '建议你咨询专业医生，我给不了医疗意见。',
    '我不是律师，这条只能当参考。',
    '这件事不适合由我来判断。',
    '我们的关系只是助手和用户，别太当真。'
  ];
  for (const t of hits) {
    it(`命中：${JSON.stringify(t)}`, () => {
      expect(isRefusal(t)).toBe(true);
    });
  }

  it('普通道歉不算拒绝', () => {
    expect(isRefusal('抱歉，这次没能帮你找到那份笔记。')).toBe(false);
  });
});
