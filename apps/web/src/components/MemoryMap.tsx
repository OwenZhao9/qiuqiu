/**
 * 记忆框图。**照论文原图搬过来的**，不是另画一张。
 *
 * 底图逐块对应 arXiv 2604.01007 的 `assets/framework.png`，坐标与形状取自
 * `docs/omni-framework-cn.html`（那份是对着原图重绘并翻译的，没改环节）：
 * 四模态各自的廉价判据 → 漏斗形的新颖度过滤器 → 生成记忆原子单元 →
 * 热冷两层存储与知识图谱 → 三路检索 → 并集合并 → token 预算金字塔 → 答案。
 *
 * 在原图上加的只有两件事，一件都不改结构：
 *
 * 1. **亮起来**——这一轮真的走到哪一块，哪一块亮，连线上跑一段流动的虚线
 * 2. **标出丘丘跟论文不一样的地方**——没做的块画成灰的并注明，做法不同的
 *    块在原名下面写丘丘的做法。图上不能只有论文没有实现，那是在骗人
 *
 * 线型沿用原图的约定，不是自己定的：
 *
 * - **实线** = 数据往前走一步
 * - **虚线** = 不是往前走的那种连接：热→冷的指针 `p`、被判冗余漏出去的那一路、
 *   检索时从存储回读
 *
 * 数据只来自事件（AD-14）。
 */

import { useMemo } from 'react';
import type { MemoryEventEnvelope } from '../api.js';
import { derivePipeline, type SearchPath } from '../store/pipeline.js';

const W = 1160;
const H = 620;

/** 一块的状态。`off` 没走到，`on` 这一轮走到了，`none` 是丘丘根本没做这一块。 */
type Lit = 'off' | 'on' | 'none';

function cls(base: string, lit: Lit): string {
  return base + (lit === 'on' ? ' qq-map--on' : lit === 'none' ? ' qq-map--none' : '');
}

/** 论文原图里的一个方块。`note` 写丘丘跟论文哪里不一样。 */
function Box({
  x,
  y,
  w,
  h,
  tone,
  title,
  en,
  sub,
  note,
  lit,
  rx = 7
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  tone: 1 | 2 | 3 | 4;
  title: string;
  en?: string;
  sub?: string;
  note?: string;
  lit: Lit;
  rx?: number;
}): React.JSX.Element {
  const cx = x + w / 2;
  const lines = [en, sub, note].filter(Boolean) as string[];
  // 标题在竖直方向居中，副行往下排
  const top = y + h / 2 - (lines.length * 12) / 2 + 4;
  return (
    <g className={cls('qq-map__box', lit)} data-tone={tone} aria-label={title}>
      <rect x={x} y={y} width={w} height={h} rx={rx} />
      <text className="qq-map__t" x={cx} y={top}>
        {title}
      </text>
      {lines.map((t, i) => (
        <text
          key={t}
          className={t === note ? 'qq-map__note-in' : 'qq-map__s'}
          x={cx}
          y={top + 13 + i * 12}
        >
          {t}
        </text>
      ))}
    </g>
  );
}

function Arrow({
  d,
  lit,
  dashed,
  tone = 1,
  tip = true
}: {
  d: string;
  lit: boolean;
  dashed?: boolean;
  tone?: 1 | 2 | 3 | 4;
  tip?: boolean;
}): React.JSX.Element {
  return (
    <g data-tone={tone}>
      <path
        className={'qq-map__arrow' + (lit ? ' qq-map--on' : '')}
        strokeDasharray={dashed ? '5 4' : undefined}
        d={d}
        markerEnd={tip ? (lit ? 'url(#qq-tip-on)' : 'url(#qq-tip)') : undefined}
      />
      {/* 亮起来时在同一条线上叠一段跑动的虚线：看得出数据往哪个方向流 */}
      {lit ? <path className="qq-map__flow" d={d} /> : null}
    </g>
  );
}

/** 存储区里的一张「记忆原子单元」卡。命中过的那张会亮。 */
function Mau({
  x,
  y,
  cold,
  lit,
  text
}: {
  x: number;
  y: number;
  cold?: boolean;
  lit: boolean;
  text?: string;
}): React.JSX.Element {
  return (
    <g className={'qq-map__mau' + (cold ? ' qq-map__mau--cold' : '') + (lit ? ' qq-map--on' : '')}>
      <rect x={x} y={y} width={106} height={62} rx={6} />
      <text className="qq-map__mau-h" x={x + 9} y={y + 15}>
        记忆原子单元
      </text>
      <text className="qq-map__mau-l" x={x + 9} y={y + 29}>
        {text ? clip(text, 13) : '摘要：…'}
      </text>
      <text className="qq-map__mau-l" x={x + 9} y={y + 41}>
        向量：[…]
      </text>
      <text className="qq-map__mau-l" x={x + 9} y={y + 53}>
        时间 · 模态
      </text>
    </g>
  );
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
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
  const filtered = p.stages.filter.status === 'done';
  const rejected = p.decision === 'reject';
  const passed = ingest && (p.stages.filter.status === 'skip' || (filtered && !rejected));
  const made = ingest && p.stages.compress.status === 'done';
  const wrote = ingest && p.stages.store.status === 'done';
  const on = (b: boolean): Lit => (b ? 'on' : 'off');

  const written = [...p.facts, ...p.replyFacts];

  return (
    <div className={'qq-map' + (compact ? ' qq-map--compact' : '')}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="记忆系统框图">
        <defs>
          {(['qq-tip', 'qq-tip-on'] as const).map((id) => (
            <marker
              key={id}
              id={id}
              viewBox="0 0 7 4.4"
              markerWidth="7"
              markerHeight="7"
              refX="6"
              refY="2.2"
              orient="auto"
            >
              <path
                className={'qq-map__tip' + (id.endsWith('on') ? ' qq-map--on' : '')}
                d="M0,0 L0,4.4 L6,2.2 z"
              />
            </marker>
          ))}
        </defs>

        {/* ============ ① 选择性摄入 ============ */}
        <rect
          className="qq-map__zone"
          data-tone={1}
          x={12}
          y={16}
          width={330}
          height={580}
          rx={12}
        />
        <text className="qq-map__zone-t" data-tone={1} x={177} y={42}>
          ① 选择性摄入
        </text>
        <text className="qq-map__zone-en" x={177} y={60}>
          Selective Ingestion
        </text>

        {/* 四种模态各有各的廉价判据。丘丘做了前三种，视频没做 */}
        {(
          [
            ['文字', '词汇重合度去重', 'Jaccard', null, ingest],
            ['图片', '画面相似度比对', 'CLIP', '丘丘走 Vision 转描述', false],
            ['音频', '语音活动检测', 'VAD', null, ingest && filtered],
            ['视频', '抽帧', 'Frame sampling', '丘丘没做', null]
          ] as const
        ).map(([mode, how, en, note, live], i) => {
          const y = 76 + i * 48;
          const lit: Lit = live === null ? 'none' : on(Boolean(live));
          return (
            <g key={mode}>
              <Box x={30} y={y} w={128} h={38} tone={1} title={mode} lit={lit} />
              <Box
                x={182}
                y={y}
                w={140}
                h={38}
                tone={1}
                title={how}
                en={en}
                note={note ?? undefined}
                lit={lit}
              />
              <Arrow d={`M158,${y + 19} L178,${y + 19}`} lit={lit === 'on'} />
            </g>
          );
        })}

        {/* 四路汇成一路进漏斗 */}
        <Arrow d="M322,95 L332,95 L332,278 L177,278 L177,296" lit={ingest} />
        {[143, 191, 239].map((y) => (
          <Arrow key={y} d={`M322,${y} L332,${y}`} lit={false} tip={false} />
        ))}

        {/* 判为冗余的从漏斗旁边漏出去 —— 虚线，因为它不往前走 */}
        <Arrow d="M246,316 L268,334" lit={rejected} dashed tip={false} />
        <text className={cls('qq-map__x', on(rejected))} x={274} y={342}>
          ✕
        </text>
        <text className="qq-map__s" x={240} y={364} textAnchor="start">
          {rejected ? clip(p.reason, 12) : '判为冗余，丢掉'}
        </text>

        {/* 漏斗本体 */}
        <g className={cls('qq-map__funnel', on(ingest && (filtered || passed)))}>
          <path d="M96,302 L258,302 L192,376 L192,412 L162,412 L162,376 z" />
          <path className="qq-map__funnel-l" d="M120,318 L234,318" />
          <path className="qq-map__funnel-l" d="M134,332 L220,332" />
          <path className="qq-map__funnel-l" d="M148,346 L206,346" />
        </g>
        <text className={cls('qq-map__t qq-map__lg', on(filtered))} x={177} y={440}>
          新颖度过滤器
        </text>
        <text className="qq-map__s" x={177} y={456}>
          {filtered ? p.stages.filter.detail || 'Novelty Filter' : 'Novelty Filter'}
        </text>

        <Arrow d="M177,462 L177,486" lit={passed} />

        <Box
          x={34}
          y={492}
          w={286}
          h={76}
          tone={1}
          title="生成记忆原子单元"
          en="MAU Creation"
          sub={made ? p.stages.compress.detail : '大模型产出摘要 + 向量'}
          note="留下来的才进这一步，省的就是这里的钱"
          lit={on(made)}
          rx={8}
        />

        {/* ============ ② 存储与知识图谱 ============ */}
        <rect
          className="qq-map__zone"
          data-tone={2}
          x={358}
          y={16}
          width={440}
          height={580}
          rx={12}
        />
        <text className="qq-map__zone-t" data-tone={2} x={578} y={42}>
          ② 存储与知识图谱
        </text>
        <text className="qq-map__zone-en" x={578} y={60}>
          MAU Storage + Knowledge Graph
        </text>

        {/* 热存储 */}
        <g className={cls('qq-map__shelf', on(wrote || p.hits.length > 0))}>
          <rect x={374} y={76} width={408} height={104} rx={9} />
        </g>
        <text className="qq-map__t qq-map__l" x={392} y={97}>
          热存储
        </text>
        <text className="qq-map__s qq-map__r" x={766} y={97}>
          常驻，随时可取
        </text>
        {[0, 1, 2].map((i) => (
          <Mau
            key={i}
            x={392 + i * 116}
            y={106}
            lit={Boolean(written[i]) && wrote}
            text={written[i]?.text ?? p.hits[i]?.text}
          />
        ))}
        <text className="qq-map__s" x={748} y={142}>
          ⋯
        </text>

        {/* 热 → 冷的指针：虚线，它是引用不是流动 */}
        <Arrow d="M578,182 L578,208" lit={false} dashed tone={2} />
        <text className="qq-map__s qq-map__l" x={590} y={200}>
          指针 p
        </text>

        {/* 冷存储 */}
        <rect
          className="qq-map__shelf qq-map__shelf--cold"
          x={374}
          y={214}
          width={408}
          height={104}
          rx={9}
        />
        <text className="qq-map__s qq-map__l qq-map__t" x={392} y={235}>
          冷存储
        </text>
        <text className="qq-map__s qq-map__r" x={766} y={235}>
          {p.promoted.length > 0 ? `回热 ${p.promoted.length} 条` : '归档，按需加载'}
        </text>
        {[0, 1, 2].map((i) => (
          <Mau key={i} x={392 + i * 116} y={244} cold lit={i < p.promoted.length} />
        ))}
        <text className="qq-map__s" x={748} y={280}>
          ⋯
        </text>

        {/* 冷存储 → 实体抽取 */}
        <Arrow d="M470,320 L470,346 L556,346 L556,358" lit={false} tone={2} />
        <Arrow d="M578,320 L578,358" lit={false} tone={2} tip={false} />
        <Arrow d="M686,320 L686,346 L600,346" lit={false} tone={2} tip={false} />

        <Box
          x={450}
          y={362}
          w={256}
          h={42}
          tone={2}
          title="实体抽取"
          en="Entity Extraction"
          note="丘丘没做"
          lit="none"
          rx={8}
        />
        <Arrow d="M578,406 L578,424" lit={false} tone={2} />

        {/* 知识图谱：丘丘没建图，这一整块是灰的 */}
        <g className="qq-map__graph qq-map--none">
          <rect x={374} y={428} width={408} height={152} rx={9} />
          {(
            [
              [440, 470, '人物', '张三'],
              [604, 470, '事件', '研讨会'],
              [440, 548, '人物', '李四'],
              [640, 548, '地点', '上海']
            ] as const
          ).map(([cx, cy, kind, name]) => (
            <g key={name}>
              <ellipse cx={cx} cy={cy} rx={52} ry={19} />
              <text className="qq-map__s" x={cx} y={cy - 3}>
                {kind}
              </text>
              <text className="qq-map__s" x={cx} y={cy + 9}>
                {name}
              </text>
            </g>
          ))}
          {[
            'M492,470 L550,470',
            'M604,489 L604,516 L692,516 L692,540 L694,540',
            'M440,489 L440,528',
            'M492,548 L586,548'
          ].map((d) => (
            <path key={d} className="qq-map__edge" d={d} markerEnd="url(#qq-tip)" />
          ))}
          <text className="qq-map__s" x={766} y={448} textAnchor="end">
            实体归并 · 丘丘没做
          </text>
          <text className="qq-map__s" x={766} y={462} textAnchor="end">
            第三路走标签，不跳图
          </text>
        </g>

        {/* ============ ③ 检索 ============ */}
        <rect
          className="qq-map__zone"
          data-tone={3}
          x={814}
          y={16}
          width={334}
          height={580}
          rx={12}
        />
        <text className="qq-map__zone-t" data-tone={3} x={981} y={42}>
          ③ 检索
        </text>
        <text className="qq-map__zone-en" x={981} y={60}>
          Retrieval
        </text>

        <Box
          x={890}
          y={74}
          w={180}
          h={32}
          tone={3}
          title={recall && p.input ? clip(p.input, 11) : '用户提问 q'}
          lit={on(recall)}
          rx={16}
        />

        <Arrow d="M980,108 L980,122" lit={recall} tip={false} />
        <Arrow d="M868,122 L1094,122" lit={recall} tip={false} />

        {/* 三路。论文第三路是图检索，丘丘走标签 */}
        {(
          [
            ['semantic', 830, 100, '稠密检索', '按意思', 'FAISS 向量', null],
            ['lexical', 936, 90, '稀疏检索', '按字面', 'BM25 关键词', null],
            ['symbolic', 1032, 100, '图检索', '按关系', 'h 跳邻居', '丘丘按标签']
          ] as const
        ).map(([path, x, w, title, how, en, note]) => {
          const walked = p.paths.includes(path as SearchPath);
          const cx = x + w / 2;
          return (
            <g key={path}>
              <Arrow d={`M${cx},122 L${cx},138`} lit={walked} />
              <Box
                x={x}
                y={142}
                w={w}
                h={58}
                tone={3}
                title={title}
                sub={how}
                en={en}
                note={note ?? undefined}
                lit={on(walked)}
              />
            </g>
          );
        })}

        <Arrow
          d="M880,202 L880,222 L981,222"
          lit={p.paths.includes('semantic')}
          tip={false}
          tone={3}
        />
        <Arrow d="M981,202 L981,222" lit={p.paths.includes('lexical')} tip={false} tone={3} />
        <Arrow
          d="M1082,202 L1082,222 L981,222"
          lit={p.paths.includes('symbolic')}
          tip={false}
          tone={3}
        />
        <Arrow d="M981,222 L981,238" lit={p.hits.length > 0} tone={3} />

        <g className={cls('qq-map__union', on(p.hits.length > 0))}>
          <circle cx={981} cy={262} r={24} />
          <text className="qq-map__t" x={981} y={259}>
            并集
          </text>
          <text className="qq-map__t" x={981} y={271}>
            合并
          </text>
        </g>
        <text className="qq-map__s" x={1018} y={266} textAnchor="start">
          {p.hits.length > 0 ? `去重后 ${p.hits.length} 条` : '去重后得 R(q)'}
        </text>

        <Arrow d="M981,288 L981,310" lit={p.hits.length > 0} tone={3} />

        {/* token 预算金字塔 */}
        <text className="qq-map__t qq-map__l" x={852} y={352}>
          token
        </text>
        <text className="qq-map__t qq-map__l" x={852} y={367}>
          预算 B
        </text>
        {(
          [
            ['M930,318 L1032,318 L1024,348 L938,348 z', 338, '摘要'],
            ['M936,352 L1026,352 L1018,384 L944,384 z', 372, '全文'],
            ['M942,388 L1020,388 L1012,420 L950,420 z', 408, '原始内容']
          ] as const
        ).map(([d, ty, label], i) => (
          <g key={label} className={cls('qq-map__tier', on(recall && p.hits.length > i))}>
            <path d={d} />
            <text className="qq-map__s" x={981} y={ty}>
              {label}
            </text>
          </g>
        ))}
        <text className="qq-map__s" x={1042} y={360} textAnchor="start">
          先给摘要
        </text>
        <text className="qq-map__s" x={1042} y={376} textAnchor="start">
          不够再展开
        </text>
        <text className="qq-map__s" x={1042} y={392} textAnchor="start">
          {recall ? p.stages.recall.detail || '预算内为止' : '预算内为止'}
        </text>

        <Arrow d="M981,424 L981,452" lit={recall && p.hits.length > 0} tone={3} />
        <Box
          x={900}
          y={456}
          w={162}
          h={40}
          tone={3}
          title="答案"
          lit={on(recall && p.hits.length > 0)}
          rx={8}
        />

        {/* 跨区：摄入 → 热存储 */}
        <Arrow d="M320,530 L338,530 L338,128 L356,128" lit={wrote} tone={2} />
        <text className="qq-map__s qq-map__rot" x={348} y={330}>
          写入热存储
        </text>

        {/* 跨区：存储 → 检索，回读。虚线，因为它是读不是写 */}
        <Arrow d="M784,128 L800,128 L800,171 L828,171" lit={p.hits.length > 0} dashed tone={3} />
        <Arrow
          d="M784,266 L796,266 L796,171"
          lit={p.promoted.length > 0}
          dashed
          tone={3}
          tip={false}
        />
        <Arrow d="M784,504 L806,504 L806,171" lit={false} dashed tone={3} tip={false} />
        <text className="qq-map__s" x={806} y={112}>
          读取
        </text>
      </svg>

      {compact ? null : (
        <p className="qq-map__note">
          底图照搬论文 <span className="qq-mono">arXiv 2604.01007</span> 的框图，环节与线型都没改：
          实线是数据往前走一步，虚线是指针、丢弃与回读。亮起来的是这一轮真的走过的路，
          全部来自记忆事件。<b>灰掉的块是丘丘没做的</b>——视频抽帧、实体抽取与知识图谱；
          论文第三路检索是图上跳 h 步，丘丘走的是标签。
        </p>
      )}
    </div>
  );
}
