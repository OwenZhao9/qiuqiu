/**
 * 阈值面板的纯逻辑，按 `design/memory-panel.md` § 5。
 *
 * 判定与 `docs/CONTRACTS.md` § 1 一致：`score >= accept` 为 `accept`，
 * `score >= uncertain` 为 `uncertain`，否则 `reject`。
 */

import type { FilterDecision, MemoryEventEnvelope, Thresholds } from '../api.js';

export const DEFAULT_THRESHOLDS: Thresholds = { accept: 0.72, uncertain: 0.45 };

/** 两条线之间至少留这么宽，`uncertain` 不得大于 `accept - 0.05`。 */
export const MIN_GAP = 0.05;

export const STEP = 0.01;
export const STEP_PAGE = 0.1;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 0.01 步长上取整到两位小数，避免浮点尾巴（0.7200000000000001）。 */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 拖动其中一根线，另一根被顶着走，不弹错误。
 * `which` 是用户正在拖的那根。
 */
export function clampThresholds(next: Thresholds, which: 'accept' | 'uncertain'): Thresholds {
  const accept = round2(clamp01(next.accept));
  const uncertain = round2(clamp01(next.uncertain));
  if (uncertain <= round2(accept - MIN_GAP)) return { accept, uncertain };
  if (which === 'accept') {
    return { accept, uncertain: round2(Math.max(0, accept - MIN_GAP)) };
  }
  return { accept: round2(Math.min(1, uncertain + MIN_GAP)), uncertain };
}

/** 按一组阈值重判一个分数。 */
export function decide(score: number, t: Thresholds): FilterDecision {
  if (score >= t.accept) return 'accept';
  if (score >= t.uncertain) return 'uncertain';
  return 'reject';
}

const DECISION_CN: Record<FilterDecision, string> = {
  accept: '保留',
  uncertain: '拿不准',
  reject: '丢掉'
};

export function decisionLabel(d: FilterDecision): string {
  return DECISION_CN[d];
}

export interface PreviewDiff {
  /** 参与比较的 `filter` 事件条数。 */
  sampled: number;
  /** 判定会变的条数。 */
  changed: number;
  /** 「12 条会从丢掉变成拿不准」这句话，没有差异时是「与当前一致」。 */
  text: string;
}

/**
 * 拖动过程中的本地预演：拿最近 N 条 `filter` 事件，用新阈值重判，数出差异。
 * **不改数据、不改 `payload.decision` 的原值**，只是展示层重算。
 */
export function previewDiff(
  events: readonly MemoryEventEnvelope[],
  next: Thresholds,
  sample = 50
): PreviewDiff {
  const recent = events.filter((e) => e.type === 'filter').slice(-sample);
  const buckets = new Map<string, number>();
  let changed = 0;
  for (const ev of recent) {
    if (ev.type !== 'filter') continue;
    const before = ev.payload.decision;
    const after = decide(ev.payload.score, next);
    if (before === after) continue;
    changed += 1;
    const key = before + '→' + after;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  if (changed === 0) {
    return { sampled: recent.length, changed: 0, text: '与当前一致' };
  }
  const parts = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key, n]) => {
      const [from, to] = key.split('→') as [FilterDecision, FilterDecision];
      return `${n} 条会从${DECISION_CN[from]}变成${DECISION_CN[to]}`;
    });
  return {
    sampled: recent.length,
    changed,
    text: `按这个阈值，最近 ${recent.length} 条里${parts.join('、')}`
  };
}

/** 轨道的三段渐变分界，跟着手柄走。 */
export function trackGradient(t: Thresholds): string {
  const u = Math.round(t.uncertain * 100);
  const a = Math.round(t.accept * 100);
  return (
    'linear-gradient(to right,' +
    ` var(--qq-color-reject) 0%, var(--qq-color-reject) ${u}%,` +
    ` var(--qq-color-uncertain) ${u}%, var(--qq-color-uncertain) ${a}%,` +
    ` var(--qq-color-write) ${a}%, var(--qq-color-write) 100%)`
  );
}

/** 折叠时标题栏显示的紧凑形式，例如 `0.72 / 0.45`。 */
export function compactLabel(t: Thresholds): string {
  return t.accept.toFixed(2) + ' / ' + t.uncertain.toFixed(2);
}
