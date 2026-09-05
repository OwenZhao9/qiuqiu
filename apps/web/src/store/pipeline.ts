/**
 * 把事件流折成「记忆管线」的当前状态，供流程图渲染。
 *
 * 纯派生，不发请求、不存东西——输入是 `EventsState.events`（AD-14：事件是可见性的
 * 唯一数据源），输出是每一段的活动情况。
 *
 * 管线是两条线共用中间的存储：
 *
 *     进来的话 → 筛选 → 压缩 → 合成 → 热存储
 *     问的话   → 检索规划 → 三路并行 → 命中 ↘ 冷存储回热
 *
 * 一条 trace 串起同一轮的事件（契约 § 7）。图上永远只画**最近一条 trace**：
 * 同时画几轮会糊成一团，而这张图要回答的是「我刚说的那句话去哪了」。
 */

import type { MemoryEventEnvelope } from '../api.js';

/** 管线上的一段。`idle` 没走到，`active` 正在走，`done` 走完，`skip` 这轮跳过。 */
export type StageStatus = 'idle' | 'active' | 'done' | 'skip';

export type StageId = 'filter' | 'compress' | 'synthesize' | 'store' | 'plan' | 'search' | 'recall';

export interface Stage {
  id: StageId;
  status: StageStatus;
  /** 段上显示的一行字，取自事件字段，不自己编。 */
  detail: string;
}

/** 检索的三路，对应契约 § 1 `recall.plan.paths`。 */
export type SearchPath = 'semantic' | 'lexical' | 'symbolic';

export const PATH_LABEL: Record<SearchPath, string> = {
  semantic: '按意思',
  lexical: '按字面',
  symbolic: '按标签'
};

export interface PipelineState {
  /** 这一轮的 trace，没有事件时为 null。 */
  traceId: string | null;
  /** 这一轮是写入还是召回。两者都有就按最后一条事件算。 */
  lane: 'ingest' | 'recall' | null;
  stages: Record<StageId, Stage>;
  /** 进管线的原话，来自 `write.raw` 或 `filter.input_preview`。 */
  input: string;
  /** 压缩拆出来的事实。 */
  facts: { id: string; text: string }[];
  /** 被压缩丢掉的片段，图上从管线掉出去。 */
  dropped: string[];
  /** 合成吸收掉的旧事实。 */
  absorbed: { id: string; text: string }[];
  /** 合成作废掉的旧事实。 */
  invalidated: { id: string; text: string }[];
  /** 检索走了哪几路、跳过哪几路。 */
  paths: SearchPath[];
  skipped: SearchPath[];
  /** 召回命中，带走的是哪一路。 */
  hits: { id: string; text: string; path: string; score: number }[];
  /** 从冷存储回热的事实 id。 */
  promoted: string[];
  /** 筛选判定，只有被动采集才有。 */
  decision: 'accept' | 'reject' | 'uncertain' | null;
  reason: string;
}

function blank(): PipelineState {
  const stage = (id: StageId): Stage => ({ id, status: 'idle', detail: '' });
  return {
    traceId: null,
    lane: null,
    stages: {
      filter: stage('filter'),
      compress: stage('compress'),
      synthesize: stage('synthesize'),
      store: stage('store'),
      plan: stage('plan'),
      search: stage('search'),
      recall: stage('recall')
    },
    input: '',
    facts: [],
    dropped: [],
    absorbed: [],
    invalidated: [],
    paths: [],
    skipped: [],
    hits: [],
    promoted: [],
    decision: null,
    reason: ''
  };
}

export const EMPTY_PIPELINE = blank();

/**
 * 取最近一条 trace 的事件，折成管线状态。
 *
 * 信封是可辨识联合，按 `ev.type` 收窄之后 payload 就是精确类型——字段名写错编译期
 * 就会拦住，不用运行时才发现。别退回 `Record<string, unknown>`。
 *
 * 没有 trace 的事件（中间件自己生成的）各算一轮，不与别人混。
 */
export function derivePipeline(events: readonly MemoryEventEnvelope[]): PipelineState {
  if (events.length === 0) return EMPTY_PIPELINE;

  const last = events[events.length - 1];
  const trace = last.trace_id || null;
  // 同一条 trace 的都算这一轮；没有 trace 就只取最后一条
  const round = trace ? events.filter((e) => e.trace_id === trace) : [last];

  const s = blank();
  s.traceId = trace;

  for (const ev of round) {
    if (ev.type === 'filter') {
      const p = ev.payload;
      s.lane = 'ingest';
      s.decision = p.decision;
      s.reason = p.reason ?? '';
      if (!s.input) s.input = p.input_preview ?? '';
      s.stages.filter = {
        id: 'filter',
        status: 'done',
        detail: p.decision === 'reject' ? '丢掉' : p.decision === 'uncertain' ? '拿不准' : '留下'
      };
      if (p.decision === 'reject') {
        // 丢掉就到此为止，后面三段这轮不会走
        for (const id of ['compress', 'synthesize', 'store'] as StageId[]) {
          s.stages[id] = { id, status: 'skip', detail: '' };
        }
      }
    }

    if (ev.type === 'write') {
      const p = ev.payload;
      s.lane = 'ingest';
      s.input = p.raw || s.input;
      s.facts = (p.facts ?? []).map((f) => ({ id: f.id, text: f.text }));
      s.dropped = (p.dropped_spans ?? []).filter(Boolean);
      // 主动输入跳过筛选（AD-3），图上标成跳过而不是没走到
      if (s.stages.filter.status === 'idle') {
        s.stages.filter = { id: 'filter', status: 'skip', detail: '主动输入不筛' };
      }
      s.stages.compress = { id: 'compress', status: 'done', detail: `拆出 ${s.facts.length} 条` };
      s.stages.store = { id: 'store', status: 'done', detail: `写入 ${s.facts.length} 条` };
    }

    if (ev.type === 'merge') {
      const p = ev.payload;
      s.lane = 'ingest';
      s.absorbed = (p.absorbed ?? []).map((a) => ({ id: a.id, text: a.text }));
      s.invalidated = (p.invalidated ?? []).map((a) => ({ id: a.id, text: a.text }));
      const merged = s.absorbed.length + s.invalidated.length;
      s.stages.synthesize = {
        id: 'synthesize',
        status: 'done',
        detail: merged > 0 ? `并掉 ${merged} 条` : '无可并'
      };
    }

    if (ev.type === 'recall') {
      const p = ev.payload;
      s.lane = 'recall';
      s.input = p.query || s.input;
      s.paths = p.plan?.paths ?? [];
      s.skipped = p.skipped_paths ?? [];
      s.hits = (p.hits ?? []).map((h) => ({
        id: h.id,
        text: h.text,
        path: h.path,
        score: h.score
      }));
      s.promoted = (p.cold_promoted ?? []).filter(Boolean);
      s.stages.plan = {
        id: 'plan',
        status: 'done',
        detail: s.paths.length > 0 ? `走 ${s.paths.length} 路` : '不检索'
      };
      s.stages.search = {
        id: 'search',
        status: s.paths.length > 0 ? 'done' : 'skip',
        detail: s.paths.map((x) => PATH_LABEL[x] ?? x).join(' · ')
      };
      s.stages.recall = {
        id: 'recall',
        status: 'done',
        detail:
          s.hits.length > 0
            ? `想起 ${s.hits.length} 条${s.promoted.length > 0 ? `，回热 ${s.promoted.length}` : ''}`
            : '没想起来'
      };
    }
  }

  // 写入这条线上，合成没发事件就是「没有可并的」，不是没走到
  if (s.lane === 'ingest' && s.stages.compress.status === 'done') {
    if (s.stages.synthesize.status === 'idle') {
      s.stages.synthesize = { id: 'synthesize', status: 'done', detail: '无可并' };
    }
  }
  return s;
}

/** 写入那条线的四段，按顺序。 */
export const INGEST_STAGES: StageId[] = ['filter', 'compress', 'synthesize', 'store'];
/** 召回那条线的三段。 */
export const RECALL_STAGES: StageId[] = ['plan', 'search', 'recall'];

export const STAGE_LABEL: Record<StageId, string> = {
  filter: '筛选',
  compress: '压缩',
  synthesize: '合成',
  store: '热存储',
  plan: '检索规划',
  search: '三路并行',
  recall: '召回'
};
