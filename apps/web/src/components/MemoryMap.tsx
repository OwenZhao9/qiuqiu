/**
 * 记忆框图。
 *
 * 结构照 arXiv 2604.01007 的框图：各模态各自的廉价判据 → 新颖度过滤器 →
 * 生成记忆原子单元 → 热冷两层存储 → 三路检索 → 并集合并 → token 预算 → 答案。
 *
 * **只画已经跑通的部分。** 原图里的视频抽帧、实体抽取、知识图谱这三块本项目
 * 没实现，画成灰块摆在那儿只会让人以为它们能用。
 *
 * **方块归 HTML，线归连接层。** 两头都试过：整张图钉死坐标画成一块 SVG，
 * 塞进窄栏只能整体缩放，字跟着糊；全用 HTML 排版，字是清楚了，可是跨列的线
 * 根本画不出来，三个大区之间一根箭头都没有。现在方块是 div（真文字、栏窄了
 * 自己换行、字号不变），线在 `MapWires` 那一层按实测坐标画，两样都保住。
 *
 * 亮起来的块与线是这一轮真的走过的路，数据只来自事件（AD-14）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryEventEnvelope } from '../api.js';
import { reasonCN } from '../format.js';
import { derivePipeline, PATH_LABEL, type SearchPath } from '../store/pipeline.js';
import { Gap, useWireGeom, Wires, type Wire } from './MapWires.js';

/** 一块的状态：这一轮走到了没有。 */
type Lit = 'off' | 'on';

function cls(base: string, lit: Lit): string {
  return base + (lit === 'on' ? ' qq-map--on' : '');
}

/** 图上的一个方块。`note` 写实际做法与图上不同的地方。 */
function Box({
  title,
  en,
  sub,
  note,
  lit = 'off',
  size
}: {
  title: string;
  en?: string;
  sub?: string;
  note?: string;
  lit?: Lit;
  size?: 'sm' | 'lg';
}): React.JSX.Element {
  return (
    <div className={cls('qq-map__box', lit) + (size ? ` qq-map__box--${size}` : '')}>
      <b className="qq-map__box-t">{title}</b>
      {en ? <span className="qq-map__box-en">{en}</span> : null}
      {sub ? <span className="qq-map__box-sub">{sub}</span> : null}
      {note ? <span className="qq-map__box-note">{note}</span> : null}
    </div>
  );
}

/**
 * 整张图的连接拓扑。**固定不变**，所以放在模块常量里：每次渲染新建一个数组
 * 会让连接层的测量 effect 每帧重挂一遍。哪几根亮由渲染时另算。
 *
 * `gap` 是流式布局里占着位置的空档（区内的上下连接、模态那几根横箭头），
 * `span` 是跨区连接——它们正是 HTML 排版画不出来、上一版直接漏掉的那几根。
 */
const WIRES: readonly Wire[] = [
  { id: 'lane-text', kind: 'gap', dir: 'h', tone: 1 },
  { id: 'lane-image', kind: 'gap', dir: 'h', tone: 1 },
  { id: 'lane-audio', kind: 'gap', dir: 'h', tone: 1 },
  { id: 'merge', kind: 'gap', dir: 'v', tone: 1, trunk: 0 },
  { id: 'filter-out', kind: 'gap', dir: 'v', tone: 1, trunk: 1 },
  { id: 'hot-cold', kind: 'gap', dir: 'v', tone: 2, dashed: true },
  { id: 'q-paths', kind: 'gap', dir: 'v', tone: 3, trunk: 4 },
  { id: 'paths-union', kind: 'gap', dir: 'v', tone: 3, trunk: 5 },
  { id: 'union-budget', kind: 'gap', dir: 'v', tone: 3, trunk: 6 },
  { id: 'budget-answer', kind: 'gap', dir: 'v', tone: 3, trunk: 7 },
  // 跨区：新记下来的东西存进热存储；检索时再从热存储里捞
  {
    id: 'mau-store',
    kind: 'span',
    from: 'mau-create',
    to: 'hot',
    stackedFrom: 'zone1',
    stackedTo: 'zone2',
    tone: 2,
    trunk: 2
  },
  {
    id: 'store-recall',
    kind: 'span',
    from: 'hot',
    to: 'paths',
    stackedFrom: 'zone2',
    stackedTo: 'zone3',
    tone: 3,
    trunk: 3
  },
  // 回环：丘丘自己那句回答也要过一遍摄入，跟用户说的话走同一条路
  {
    id: 'answer-back',
    kind: 'span',
    from: 'answer',
    to: 'zone1',
    label: '回复也记一遍',
    tone: 1,
    dashed: true,
    whenStacked: 'skip'
  }
];

/** 一条记忆原子单元。存储区里那种小卡片。 */
function Mau({
  text,
  cold,
  lit
}: {
  text?: string;
  cold?: boolean;
  lit?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={'qq-map__mau' + (cold ? ' qq-map__mau--cold' : '') + (lit ? ' qq-map--on' : '')}
    >
      <b>记忆原子单元</b>
      <span>{text ? clip(text, 14) : '摘要：…'}</span>
      <span>向量：[…]</span>
      <span>时间 · 模态</span>
    </div>
  );
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/* ------------------------------------------------------------------ *
 * 走一遍：哪一段在处理，哪一段亮
 * ------------------------------------------------------------------ */

/** 一段亮多久。 */
const STEP_MS = 520;
/** 最后一段走完再留一会儿，不然一眨眼就全灭了。 */
const HOLD_MS = 1000;
/**
 * 走到头之后还要等多久的后续事件。
 *
 * 一轮里两条线不是同时到的：检索在回答之前，写入在回答之后——中间隔着模型
 * 生成整段回复的时间。等不够的话检索走完就收工，写入那半截永远看不到。
 */
const WAIT_MS = 45000;

/**
 * 这一轮按真实顺序走过的段。
 *
 * 顺序与内容全部来自事件：两条线各自走没走、走到哪一步，都看事件。
 * 一句话通常两条都走——先检索拿旧记忆去答，答完再把这句和回复记下来，
 * `p.lanes` 就是它们真实的先后。筛选判成丢掉的话，写入这条到此为止。
 */
function stepsOf(p: ReturnType<typeof derivePipeline>): string[] {
  const out: string[] = [];
  for (const lane of p.lanes) {
    if (lane === 'recall') {
      out.push('q', 'plan');
      if (p.paths.length > 0) out.push('search');
      if (p.hits.length > 0) out.push('union', 'budget', 'answer');
    } else {
      out.push('in', 'merge');
      if (p.stages.filter.status !== 'idle') out.push('filter');
      if (p.decision === 'reject') continue; // 丢掉就到此为止，后面不走
      if (p.stages.compress.status === 'done') out.push('mau');
      if (p.stages.store.status === 'done') out.push('store');
      if (p.replyFacts.length > 0) out.push('back');
    }
  }
  return out;
}

/**
 * 把这一轮重放一遍，一次只亮一段。
 *
 * 事件是每一段**做完**才发的，而且一轮常常几十毫秒就跑完——照事件直接点亮的话
 * 整条路会同时亮起来，既看不出先后，也看不出此刻在哪一段；而且一轮结束后状态
 * 不清，待机时图上还留着上一轮的残留。
 *
 * 所以这里按事件给出的真实顺序一段一段走，走完全部熄掉。**只有节奏是这里给的**
 * （每段 `STEP_MS`），走哪几段、走不走得下去，全看事件。
 */
function useWalk(p: ReturnType<typeof derivePipeline>): string | null {
  const [at, setAt] = useState(-1);
  const steps = stepsOf(p);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const trace = p.traceId;

  useEffect(() => {
    if (stepsRef.current.length === 0) {
      setAt(-1);
      return;
    }
    setAt(0);
    let n = 0;
    let idle = 0;
    const holdTicks = Math.ceil(HOLD_MS / STEP_MS);
    const waitTicks = Math.ceil(WAIT_MS / STEP_MS);
    const tick = setInterval(() => {
      // 这一轮的事件还在陆续到，段会变多，所以每拍都读最新的
      if (n + 1 < stepsRef.current.length) {
        n += 1;
        idle = 0;
        setAt(n);
        return;
      }
      // 走到头了：留一会儿再熄，然后继续等这一轮的后半截
      idle += 1;
      if (idle === holdTicks) setAt(-1);
      if (idle > waitTicks) clearInterval(tick);
    }, STEP_MS);
    return () => clearInterval(tick);
    // trace 换了才重走；同一轮里事件变多不打断，接着往下走
  }, [trace]);

  return at >= 0 ? (steps[at] ?? null) : null;
}

/** 每一段亮哪几根线。 */
const STEP_WIRES: Readonly<Record<string, readonly string[]>> = {
  in: ['lane-text', 'lane-image', 'lane-audio'],
  merge: ['merge'],
  mau: ['filter-out'],
  store: ['mau-store'],
  plan: ['q-paths'],
  search: ['store-recall'],
  union: ['paths-union'],
  budget: ['union-budget'],
  answer: ['budget-answer'],
  back: ['answer-back']
};

export interface MemoryMapProps {
  events: readonly MemoryEventEnvelope[];
  /** 主页那一条：矮一些，不抢对话的地方。 */
  compact?: boolean;
}

export function MemoryMap({ events, compact = false }: MemoryMapProps): React.JSX.Element {
  const p = useMemo(() => derivePipeline(events), [events]);

  const filtered = p.stages.filter.status === 'done';
  const rejected = p.decision === 'reject';
  const made = p.stages.compress.status === 'done';
  const recall = p.lane === 'recall';
  const written = [...p.facts, ...p.replyFacts];

  // **只有正在走的那一段是亮的**，走过的和没走的都不亮。
  // 「哪一段在处理哪一段亮」——待机时整张图是干净的
  const step = useWalk(p);
  const at = (id: string): boolean => step === id;
  const on = (b: boolean): Lit => (b ? 'on' : 'off');

  const litWires: Record<string, boolean> = {};
  for (const id of STEP_WIRES[step ?? ''] ?? []) litWires[id] = true;

  const zonesRef = useRef<HTMLDivElement | null>(null);
  const geom = useWireGeom(zonesRef, WIRES);

  return (
    <div className={'qq-map' + (compact ? ' qq-map--compact' : '')}>
      <div className="qq-map__zones" ref={zonesRef}>
        <Wires geom={geom} wires={WIRES} lit={litWires} />
        {/* ── ① 选择性摄入 ───────────────────────────────── */}
        <section className="qq-map__zone" data-tone={1} data-node="zone1">
          <header className="qq-map__zone-h">
            <b>① 选择性摄入</b>
            <span>Selective Ingestion</span>
          </header>

          <div className="qq-map__lanes">
            {(
              [
                ['text', '文字', '词汇重合度去重', 'Jaccard', undefined, at('in')],
                ['image', '图片', '画面相似度比对', 'CLIP', '实为 Vision 转描述', false],
                ['audio', '音频', '语音活动检测', 'VAD', undefined, at('in') && filtered]
              ] as [string, string, string, string, string | undefined, boolean][]
            ).map(([key, mode, how, en, note, live]) => {
              const lit: Lit = on(live);
              return (
                <div className="qq-map__lane" key={key}>
                  <Box title={mode} lit={lit} size="sm" />
                  <Gap id={`lane-${key}`} dir="h" />
                  <Box title={how} en={en} note={note} lit={lit} size="sm" />
                </div>
              );
            })}
          </div>

          <Gap id="merge" label="三路汇成一路" />

          <div className={cls('qq-map__filter', on(at('filter')))}>
            <svg viewBox="0 0 120 92" className="qq-map__funnel" aria-hidden="true">
              <path d="M6 6 H114 L74 54 V86 H46 V54 Z" />
              <path className="qq-map__funnel-l" d="M20 20 H100" />
              <path className="qq-map__funnel-l" d="M30 32 H90" />
              <path className="qq-map__funnel-l" d="M40 44 H80" />
            </svg>
            <div className="qq-map__filter-t">
              <b>新颖度过滤器</b>
              <span>Novelty Filter</span>
              <span>{filtered ? p.stages.filter.detail : '留 / 丢 / 拿不准'}</span>
            </div>
            <div className={'qq-map__drop' + (rejected ? ' qq-map--on' : '')}>
              <span aria-hidden="true">✕</span>
              {rejected ? clip(reasonCN(p.reason), 10) : '冗余，丢掉'}
            </div>
          </div>

          <Gap id="filter-out" />

          <div data-node="mau-create">
            <Box
              title="生成记忆原子单元"
              en="MAU Creation"
              sub={made ? p.stages.compress.detail : '大模型产出摘要 + 向量'}
              note="留下来的才进这一步，省的就是这里的钱"
              lit={on(at('mau'))}
              size="lg"
            />
          </div>
        </section>

        {/* ── ② 两层存储 ─────────────────────────────────── */}
        <section className="qq-map__zone" data-tone={2} data-node="zone2">
          <header className="qq-map__zone-h">
            <b>② 两层存储</b>
            <span>MAU Storage</span>
          </header>

          <div className={cls('qq-map__shelf', on(at('store') || at('search')))} data-node="hot">
            <div className="qq-map__shelf-h">
              <b>热存储</b>
              <span>常驻，随时可取</span>
            </div>
            <div className="qq-map__maus">
              {[0, 1, 2].map((i) => (
                <Mau
                  key={i}
                  lit={Boolean(written[i]) && at('store')}
                  text={written[i]?.text ?? p.hits[i]?.text}
                />
              ))}
            </div>
          </div>

          <Gap id="hot-cold" label="指针 p" />

          <div className="qq-map__shelf qq-map__shelf--cold">
            <div className="qq-map__shelf-h">
              <b>冷存储</b>
              <span>
                {p.promoted.length > 0 ? `回热 ${p.promoted.length} 条` : '归档，按需加载'}
              </span>
            </div>
            <div className="qq-map__maus">
              {[0, 1, 2].map((i) => (
                <Mau key={i} cold lit={i < p.promoted.length} />
              ))}
            </div>
          </div>
        </section>

        {/* ── ③ 检索 ─────────────────────────────────────── */}
        <section className="qq-map__zone" data-tone={3} data-node="zone3">
          <header className="qq-map__zone-h">
            <b>③ 检索</b>
            <span>Retrieval</span>
          </header>

          <Box title={recall && p.input ? clip(p.input, 16) : '用户提问 q'} lit={on(at('q'))} />

          <Gap id="q-paths" label="三路并行" />

          <div className="qq-map__paths" data-node="paths">
            {(
              [
                ['semantic', '稠密检索', 'FAISS 向量', undefined],
                ['lexical', '稀疏检索', 'BM25 关键词', undefined],
                ['symbolic', '图检索', 'h 跳邻居', '实为按标签']
              ] as [SearchPath, string, string, string | undefined][]
            ).map(([path, title, en, note]) => (
              <Box
                key={path}
                title={title}
                en={en}
                sub={PATH_LABEL[path]}
                note={note}
                lit={on(at('search') && p.paths.includes(path))}
                size="sm"
              />
            ))}
          </div>

          <Gap id="paths-union" />

          <div className={cls('qq-map__union', on(at('union')))}>
            <b>并集</b>
            <span>{p.hits.length > 0 ? `合并去重 ${p.hits.length} 条` : '合并去重得 R(q)'}</span>
          </div>

          <Gap id="union-budget" />

          <div className="qq-map__budget">
            <div className="qq-map__budget-h">
              <b>token 预算 B</b>
              <span>先给摘要，不够再展开，预算内为止</span>
            </div>
            <div className="qq-map__tiers">
              {(['摘要', '全文', '原始内容'] as const).map((label, i) => (
                <div
                  key={label}
                  className={cls('qq-map__tier', on(at('budget') && p.hits.length > i))}
                  style={{ width: `${100 - i * 14}%` }}
                >
                  {label}
                </div>
              ))}
            </div>
            <span className="qq-map__budget-detail">
              {recall ? p.stages.recall.detail || '按预算截断' : '按预算截断'}
            </span>
          </div>

          <Gap id="budget-answer" />

          <div data-node="answer">
            <Box title="答案" lit={on(at('answer'))} size="lg" />
          </div>
        </section>
      </div>

      {compact ? null : (
        <p className="qq-map__note">
          亮起来的块与线是这一轮走过的路，取自记忆事件。丘丘自己那句回答也会过一遍摄入。 结构出自{' '}
          <span className="qq-mono">arXiv 2604.01007</span>。
        </p>
      )}
    </div>
  );
}
