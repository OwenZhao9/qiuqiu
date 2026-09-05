/**
 * 情绪推断：助手回复全文 → `10`–`21` 的一个 emotionId，默认回退 `02`。
 *
 * 规则表、优先级、正则、作用域全部逐行翻译自 `design/emotion-rules.md` § 3 / § 5，
 * 不自行增删条目，也不改优先级——优先级顺序是设计文档的契约面。
 *
 * 三条硬要求（`design/emotion-rules.md` § 5）：
 *   1. `pattern` 不带 `g` 标志，避免 `lastIndex` 副作用。
 *   2. `inferEmotion` 是纯函数。
 *   3. 返回值只落在 9 个情绪 ID 加回退 `02` 之内。
 */

import { FALLBACK_EMOTION, type EmotionId } from './types.js';

/** 正则的作用域。 */
export type Scope = 'full' | 'tail80' | 'lastSentence';

export interface EmotionRule {
  /** `R01` … `R17`。 */
  id: string;
  priority: number;
  scope: Scope;
  pattern: RegExp;
  emotionId: EmotionId;
}

export { FALLBACK_EMOTION };

/**
 * 预处理：去掉代码块、行内代码、markdown 图片与链接、裸 URL，再压空白。
 * 不去代码的话，注释里的「// TODO: 这里有问题」会误触发 `20` 困惑。
 */
export function normalize(raw: string): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 取最后一个非空句段。
 * 切分正则里的后行否定不能省：省掉的话「这条记录还在！！」会被切成
 * `["这条记录还在！", "！"]`，R04 的 `{2,}` 就判不到了。
 */
export function lastSentenceOf(full: string): string {
  const parts = full.split(/(?<=[。！？!?…；;])(?![。！？!?…；;])/).filter((s) => s.trim());
  return parts.length ? parts[parts.length - 1]! : full;
}

/**
 * 规则数组，与 `design/emotion-rules.md` § 3 的表逐行一致，
 * 已按 `priority` 降序、同级按 `id` 升序排好。判定时第一条命中即返回，不累计打分。
 */
export const RULES: readonly EmotionRule[] = [
  { id: 'R01', priority: 90, scope: 'full',
    pattern: /(生气|恼火|气死|太过分|不像话|忍无可忍|无法接受|让人火大)/u, emotionId: '21' },
  { id: 'R02', priority: 90, scope: 'full',
    pattern: /(?:我)?(?:很不爽|受够了|真的看不下去)/u, emotionId: '21' },
  { id: 'R03', priority: 85, scope: 'full',
    pattern: /(哇塞|天呐|天哪|我的天|居然|竟然|没想到|不会吧|真的假的|万万没想到)/u, emotionId: '13' },
  { id: 'R04', priority: 85, scope: 'lastSentence',
    pattern: /[！!]{2,}\s*$/u, emotionId: '13' },
  { id: 'R05', priority: 80, scope: 'full',
    pattern: /(害羞|脸红|夸得我|别夸我|(?:你|您)(?:太)?过奖|(?:你|您)这么夸|受宠若惊|有点(?:小)?骄傲|嘿嘿)/u, emotionId: '14' },
  { id: 'R06', priority: 70, scope: 'full',
    pattern: /(抱歉|对不起|很遗憾|帮不上|做不到|没能|辜负|不好意思[，,])/u, emotionId: '12' },
  { id: 'R07', priority: 70, scope: 'full',
    pattern: /(可惜|遗憾的是|难过|沮丧|白忙一场)/u, emotionId: '12' },
  { id: 'R08', priority: 60, scope: 'full',
    pattern: /(没办法|无能为力|只能这样|也只好|无奈|摊手|爱莫能助|无可奈何)/u, emotionId: '18' },
  { id: 'R09', priority: 60, scope: 'full',
    pattern: /(?:确实|的确)?(?:有点|有些)?(?:棘手|难办|无解)/u, emotionId: '18' },
  { id: 'R10', priority: 50, scope: 'tail80',
    pattern: /(你是(?:不是)?(?:想|要|说)|是否需要|要不要|需不需要|请问|想跟你确认|能不能再说说|方便说说)/u, emotionId: '11' },
  { id: 'R11', priority: 50, scope: 'lastSentence',
    pattern: /[？?]\s*$/u, emotionId: '11' },
  { id: 'R12', priority: 45, scope: 'full',
    pattern: /(没(?:太)?(?:看懂|听懂|明白)|不太确定|不太理解|理解不了|(?:有点|有些)(?:困惑|迷糊|懵))/u, emotionId: '20' },
  { id: 'R13', priority: 45, scope: 'full',
    pattern: /(对不上|前后矛盾|互相冲突|说法不一致|信息不一致|自相矛盾)/u, emotionId: '20' },
  { id: 'R14', priority: 40, scope: 'full',
    pattern: /(搞定|完成了|已经(?:记下|记住|保存|更新|整理好)|处理好了|一切正常|没问题了|妥了)/u, emotionId: '19' },
  { id: 'R15', priority: 40, scope: 'full',
    pattern: /(?:总算|终于)(?:是)?(?:弄好|搞定|对上|跑通|理清)/u, emotionId: '19' },
  { id: 'R16', priority: 30, scope: 'full',
    pattern: /(开心|高兴|太好了|真棒|不错(?:呀|哦|啊)?|喜欢|有意思|好玩|期待|哈哈+)/u, emotionId: '10' },
  { id: 'R17', priority: 30, scope: 'lastSentence',
    pattern: /[~～]\s*$|[!！]\s*$/u, emotionId: '10' }
];

/**
 * 拒绝式（`design/emotion-rules.md` § 4）。
 * 不属于 `10`–`21` 的情绪推断，作用域是全文，命中时用 `38` 且跳过情绪推断。
 * 最后两条对应 `docs/ARCHITECTURE.md` § 4 的人格安全边界。
 */
export const REFUSAL = /(我(?:不能|无法|没法)(?:帮你)?(?:提供|回答|完成|做|参与)|超出(?:我的)?(?:能力|权限|范围)|(?:这|该)(?:类|个)(?:问题|请求)我(?:不便|不能)|建议(?:你)?(?:咨询|寻求)(?:专业|医生|律师|心理)|我不是(?:医生|律师|心理咨询师)|不适合由我来(?:判断|决定)|我们的关系(?:是|只是))/u;

/** 回复全文是否命中拒绝式。命中时走事件表情 `38`（优先级 80）。 */
export function isRefusal(replyText: string): boolean {
  return REFUSAL.test(normalize(replyText));
}

/**
 * 情绪推断。只在 SSE `done` 之后对本轮回复全文跑一次，绝不在 `delta` 途中跑。
 *
 * @param replyText 助手回复全文
 * @param _userText 用户输入，签名里保留（`docs/agents/07-character.md`），当前规则不消费
 * @returns `10`–`21` 里的一个，或默认回退 `02`
 */
export function inferEmotion(replyText: string, _userText?: string): EmotionId {
  const full = normalize(replyText);
  if (!full) return FALLBACK_EMOTION;
  const scopes: Record<Scope, string> = {
    full,
    tail80: full.slice(-80),
    lastSentence: lastSentenceOf(full)
  };
  for (const rule of RULES) {
    if (rule.pattern.test(scopes[rule.scope])) return rule.emotionId;
  }
  return FALLBACK_EMOTION;
}
