/**
 * 记忆框图。
 *
 * 结构与坐标取自 arXiv 2604.01007 的 `assets/framework.png`，几何抄自
 * `docs/omni-framework-cn.html`：四模态各自的廉价判据 → 漏斗形的新颖度过滤器 →
 * 生成记忆原子单元 → 热冷两层存储与知识图谱 → 三路检索 → 并集合并 →
 * token 预算金字塔 → 答案。
 *
 * 在此之上加两件事：
 *
 * 1. 走到的块亮起来，连线上跑一段流动的虚线
 * 2. 尚未实现的块画成灰的并注明；做法不同的块在原名下面写实际做法
 *
 * 线型：
 *
 * - 实线 = 数据往前走一步
 * - 虚线 = 热→冷的指针 `p`、被判冗余漏出去的那一路、检索时从存储回读
 *
 * 数据只来自事件（AD-14）。
 */

import { useMemo } from 'react';
import type { MemoryEventEnvelope } from '../api.js';
import { derivePipeline, type SearchPath } from '../store/pipeline.js';

const W = 1160;
const H = 620;

/** 一块的状态。`off` 没走到，`on` 这一轮走到了，`none` 是这一块尚未实现。 */
type Lit = 'off' | 'on' | 'none';

function cls(base: string, lit: Lit): string {
  return base + (lit === 'on' ? ' qq-map--on' : lit === 'none' ? ' qq-map--none' : '');
}

/** 一个方块。`note` 写实际做法与图上不同的地方。 */
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

        {/* 四种模态各有各的廉价判据。前三种已实现，视频未实现 */}
        {(
          [
            ['文字', '词汇重合度去重', 'Jaccard', null, ingest],
            ['图片', '画面相似度比对', 'CLIP', '实为 Vision 转描述', false],
            ['音频', '语音活动检测', 'VAD', null, ingest && filtered],
            ['视频', '抽帧', 'Frame sampling', '未实现', null]
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
        {/* 排在 ✕ 正下方、漏斗右边。原来放 x=240，被漏斗的斜边压掉了半个字 */}
        <text className="qq-map__s qq-map__l" x={266} y={362}>
          {rejected ? clip(p.reason, 7) : '冗余，丢掉'}
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
          note="未实现"
          lit="none"
          rx={8}
        />
        <Arrow d="M578,406 L578,424" lit={false} tone={2} />

        {/* 知识图谱未实现，整块画成灰的 */}
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
          <text className="qq-map__s qq-map__r" x={766} y={448}>
            实体归并 · 未实现
          </text>
          <text className="qq-map__s qq-map__r" x={766} y={462}>
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

        {/* 三路。第三路图检索未实现，走标签 */}
        {(
          [
            ['semantic', 830, 100, '稠密检索', '按意思', 'FAISS 向量', null],
            ['lexical', 936, 90, '稀疏检索', '按字面', 'BM25 关键词', null],
            ['symbolic', 1032, 100, '图检索', '按关系', 'h 跳邻居', '实为按标签']
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

        {/* 圆里只放两个字。原来「并集 / 合并」两行挤在 r=24 的圆里，
            字号提上去之后两行的包围盒直接叠在一起了 */}
        <g className={cls('qq-map__union', on(p.hits.length > 0))}>
          <circle cx={981} cy={262} r={24} />
          <text className="qq-map__t" x={981} y={267}>
            并集
          </text>
        </g>
        <text className="qq-map__s qq-map__l" x={1012} y={266}>
          {p.hits.length > 0 ? `合并去重 ${p.hits.length} 条` : '合并去重得 R(q)'}
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
        <text className="qq-map__s qq-map__l" x={1042} y={360}>
          先给摘要
        </text>
        <text className="qq-map__s qq-map__l" x={1042} y={376}>
          不够再展开
        </text>
        <text className="qq-map__s qq-map__l" x={1042} y={392}>
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

        {/* 跨区：摄入 → 热存储。
            走 x=348 而不是原图的 338——338 离摄入区那条汇流线（x=332）只有 6 个
            单位，两条长竖线并排看着像一条粗的。顺带去掉「写入热存储」那个竖排
            标签：两头的框本来就写着「生成记忆原子单元」和「热存储」，
            它挤在 16 个单位宽的区间里只添乱。 */}
        <Arrow d="M320,530 L348,530 L348,128 L356,128" lit={wrote} tone={2} />

        {/* 跨区：存储 → 检索，回读。虚线，因为它是读不是写。
            原图三条竖线分别走 x=796 / 800 / 806，挤在 16 个单位宽的区间里成了一条
            毛边。并成一条干线（x=806），三处出口用横向短线接上去。 */}
        <Arrow d="M806,504 L806,128" lit={p.hits.length > 0} dashed tone={3} tip={false} />
        <Arrow d="M784,128 L806,128" lit={p.hits.length > 0} dashed tone={3} tip={false} />
        <Arrow d="M784,266 L806,266" lit={p.promoted.length > 0} dashed tone={3} tip={false} />
        <Arrow d="M784,504 L806,504" lit={false} dashed tone={3} tip={false} />
        <Arrow d="M806,171 L828,171" lit={p.hits.length > 0} dashed tone={3} />
        <text className="qq-map__s" x={806} y={112}>
          读取
        </text>
      </svg>

      {compact ? null : (
        <p className="qq-map__note">
          实线是数据往前走一步，虚线是指针、丢弃与回读。亮起来的块是这一轮走过的路，
          取自记忆事件。灰掉的块尚未实现：视频抽帧、实体抽取、知识图谱；第三路检索走标签，
          不跳图。结构出自 <span className="qq-mono">arXiv 2604.01007</span>。
        </p>
      )}
    </div>
  );
}
