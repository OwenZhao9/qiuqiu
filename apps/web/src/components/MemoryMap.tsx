/**
 * 记忆框图。按论文（arXiv 2604.01007）的三段骨架横排画，但它是**活的**——
 * 事件到哪一块，哪一块亮。
 *
 *     ① 选择性摄入            ② 存储                ③ 检索
 *     被动采集 → 筛选           热存储  ⇄  冷存储      规划 → 三路 → 命中
 *     主动输入 ─────┐              ↑                       ↓
 *                  压缩 → 合成 ────┘                    进 prompt
 *
 * 侧栏只有 340 宽，横向三段画不下，所以这张图是主区的一页。侧栏留那张竖的
 * 单轮流程图，两者分工：这里看**系统全貌**，侧栏看**这一句走到哪了**。
 *
 * 数据只来自事件（AD-14）。
 */

import { useMemo } from 'react';
import type { MemoryEventEnvelope } from '../api.js';
import { derivePipeline, PATH_LABEL, type SearchPath } from '../store/pipeline.js';

const W = 1160;
const H = 560;

/** 一块的状态：这一轮走没走到。 */
type Lit = 'off' | 'on' | 'skip';

function boxClass(lit: Lit): string {
  return (
    'qq-map__box' + (lit === 'on' ? ' qq-map__box--on' : lit === 'skip' ? ' qq-map__box--skip' : '')
  );
}

function Box({
  x,
  y,
  w,
  h,
  title,
  sub,
  lit,
  tone
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  lit: Lit;
  tone: 1 | 2 | 3;
}): React.JSX.Element {
  return (
    <g className={boxClass(lit)} data-tone={tone} aria-label={`${title}${sub ? '：' + sub : ''}`}>
      <rect x={x} y={y} width={w} height={h} rx={10} />
      <text className="qq-map__title" x={x + w / 2} y={y + (sub ? h / 2 - 4 : h / 2 + 5)}>
        {title}
      </text>
      {sub ? (
        <text className="qq-map__sub" x={x + w / 2} y={y + h / 2 + 14}>
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function Arrow({
  x1,
  y1,
  x2,
  y2,
  lit,
  dashed
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  lit: boolean;
  dashed?: boolean;
}): React.JSX.Element {
  const d = `M ${x1} ${y1} L ${x2} ${y2}`;
  return (
    <g>
      <path
        className={'qq-map__arrow' + (lit ? ' qq-map__arrow--on' : '')}
        strokeDasharray={dashed ? '5 4' : undefined}
        d={d}
        markerEnd={lit ? 'url(#qq-map-tip-on)' : 'url(#qq-map-tip)'}
      />
      {/* 亮起时在同一条线上叠一段跑动的虚线：**看得出往哪个方向流**。
          静态箭头只说明连通，动起来才说明「此刻数据正在这里过」。 */}
      {lit ? <path className="qq-map__flow" d={d} /> : null}
    </g>
  );
}

export interface MemoryMapProps {
  events: readonly MemoryEventEnvelope[];
  /** 主页那一条：矮一些，不抢对话的地方。 */
  compact?: boolean;
}

export function MemoryMap({ events, compact = false }: MemoryMapProps): React.JSX.Element {
  const p = useMemo(() => derivePipeline(events), [events]);
  const ingest = p.lane === 'ingest';
  const recall = p.lane === 'recall';

  const on = (b: boolean): Lit => (b ? 'on' : 'off');
  const wrote = ingest && p.stages.store.status === 'done';
  const merged = ingest && p.stages.synthesize.status === 'done';
  const filtered = p.stages.filter.status === 'done';
  const skipped = p.stages.filter.status === 'skip';

  return (
    <div className={'qq-map' + (compact ? ' qq-map--compact' : '')}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="记忆系统框图">
        <defs>
          <marker
            id="qq-map-tip"
            viewBox="0 0 8 8"
            refX="6"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" className="qq-map__tip" />
          </marker>
          <marker
            id="qq-map-tip-on"
            viewBox="0 0 8 8"
            refX="6"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" className="qq-map__tip qq-map__tip--on" />
          </marker>
        </defs>

        {/* 三段的分区底与标题 */}
        <rect
          className="qq-map__zone"
          data-tone="1"
          x={16}
          y={16}
          width={330}
          height={H - 40}
          rx={14}
        />
        <rect
          className="qq-map__zone"
          data-tone="2"
          x={366}
          y={16}
          width={410}
          height={H - 40}
          rx={14}
        />
        <rect
          className="qq-map__zone"
          data-tone="3"
          x={796}
          y={16}
          width={348}
          height={H - 40}
          rx={14}
        />
        <text className="qq-map__zone-title" data-tone="1" x={181} y={42}>
          ① 选择性摄入
        </text>
        <text className="qq-map__zone-title" data-tone="2" x={571} y={42}>
          ② 结构化存储
        </text>
        <text className="qq-map__zone-title" data-tone="3" x={970} y={42}>
          ③ 意图感知检索
        </text>

        {/* ① 两条输入路径 */}
        <Box
          x={44}
          y={72}
          w={124}
          h={48}
          title="主动输入"
          sub="打字 · 说话"
          lit={on(ingest && skipped)}
          tone={1}
        />
        <Box
          x={196}
          y={72}
          w={124}
          h={48}
          title="被动采集"
          sub="环境音 · 画面"
          lit={on(ingest && filtered)}
          tone={1}
        />

        <Arrow x1={258} y1={120} x2={258} y2={156} lit={ingest && filtered} />
        <Box
          x={196}
          y={158}
          w={124}
          h={48}
          title="筛选"
          sub={filtered ? p.stages.filter.detail : '留 / 丢 / 拿不准'}
          lit={filtered ? 'on' : skipped ? 'skip' : 'off'}
          tone={1}
        />

        {/* 主动输入绕过筛选（AD-3），画成虚线直落压缩 */}
        <Arrow x1={106} y1={120} x2={106} y2={244} lit={ingest && skipped} dashed />
        <Arrow
          x1={258}
          y1={206}
          x2={258}
          y2={244}
          lit={ingest && filtered && p.decision !== 'reject'}
        />

        <Box
          x={44}
          y={246}
          w={276}
          h={52}
          title="压缩"
          sub={ingest ? p.stages.compress.detail : '拆自包含事实 · 代词解析'}
          lit={on(ingest && p.stages.compress.status === 'done')}
          tone={1}
        />
        <Arrow x1={182} y1={298} x2={182} y2={334} lit={merged} />
        <Box
          x={44}
          y={336}
          w={276}
          h={52}
          title="合成"
          sub={merged ? p.stages.synthesize.detail : '同义合并 · 旧的作废'}
          lit={on(merged)}
          tone={1}
        />

        {/* 摄入 → 存储 */}
        <Arrow x1={320} y1={362} x2={412} y2={362} lit={wrote} />

        {/* ② 冷热两层 */}
        <Box
          x={414}
          y={116}
          w={314}
          h={72}
          title="热存储"
          sub="近 30 天 · 三层索引全建"
          lit={on(wrote || p.hits.length > 0)}
          tone={2}
        />
        <Box
          x={414}
          y={396}
          w={314}
          h={72}
          title="冷存储"
          sub="全量历史与作废版本 · 仅摘要索引"
          lit={on(p.promoted.length > 0)}
          tone={2}
        />

        {/* 冷热双向：30 天没命中降冷，命中即整条回热 */}
        <Arrow x1={438} y1={188} x2={438} y2={392} lit={false} dashed />
        <text className="qq-map__edge" x={392} y={300}>
          30 天没命中降冷
        </text>
        <Arrow x1={706} y1={392} x2={706} y2={192} lit={p.promoted.length > 0} />
        <text className="qq-map__edge" x={714} y={300}>
          {p.promoted.length > 0 ? `回热 ${p.promoted.length} 条` : '命中即整条回热'}
        </text>

        {/* 三层索引 */}
        {(['semantic', 'lexical', 'symbolic'] as SearchPath[]).map((path, i) => {
          const hit = p.hits.some((h) => h.path === path);
          const walked = p.paths.includes(path);
          return (
            <Box
              key={path}
              x={420 + i * 102}
              y={206}
              w={94}
              h={44}
              title={PATH_LABEL[path]}
              lit={hit ? 'on' : walked ? 'on' : p.skipped.includes(path) ? 'skip' : 'off'}
              tone={2}
            />
          );
        })}

        {/* ③ 检索 */}
        <Arrow x1={728} y1={228} x2={842} y2={228} lit={recall && p.paths.length > 0} />
        <Box
          x={844}
          y={116}
          w={272}
          h={52}
          title="检索规划"
          sub={recall ? p.stages.plan.detail : '选路径 · 定深度'}
          lit={on(recall && p.stages.plan.status === 'done')}
          tone={3}
        />
        <Arrow x1={980} y1={168} x2={980} y2={226} lit={recall && p.paths.length > 0} />
        <Box
          x={844}
          y={228}
          w={272}
          h={52}
          title="三路并行"
          sub={recall && p.paths.length > 0 ? p.stages.search.detail : '按意思 · 按字面 · 按标签'}
          lit={on(recall && p.paths.length > 0)}
          tone={3}
        />
        <Arrow x1={980} y1={280} x2={980} y2={338} lit={recall && p.hits.length > 0} />
        <Box
          x={844}
          y={340}
          w={272}
          h={52}
          title="召回"
          sub={recall ? p.stages.recall.detail : '按预算截断'}
          lit={on(recall && p.hits.length > 0)}
          tone={3}
        />
        <Arrow x1={980} y1={392} x2={980} y2={444} lit={recall && p.hits.length > 0} />
        <Box
          x={844}
          y={446}
          w={272}
          h={48}
          title="进 prompt"
          sub="与人格、会话历史拼在一起"
          lit={on(recall && p.hits.length > 0)}
          tone={3}
        />
      </svg>

      {compact ? null : (
        <p className="qq-map__note">
          照论文 <span className="qq-mono">arXiv 2604.01007</span> 的三段骨架画。
          亮起来的是这一轮真的走过的路，数据全部来自记忆事件。
        </p>
      )}
    </div>
  );
}
