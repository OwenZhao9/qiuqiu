/**
 * 记忆框图。
 *
 * 结构照 arXiv 2604.01007 的框图：四模态各自的廉价判据 → 新颖度过滤器 →
 * 生成记忆原子单元 → 热冷两层存储与知识图谱 → 三路检索 → 并集合并 →
 * token 预算 → 答案。
 *
 * **用 HTML 排版，不是一整块钉死坐标的 SVG。** 上一版是照原图逐点量的绝对坐标，
 * 后果是：改一个框的大小旁边全都不跟着动，得手算；整张图是固定宽度的画布，
 * 塞进窄栏只能整体缩放，字跟着一起缩到看不清。现在方块是 div，文字是真文字，
 * 栏窄了三段自己换行往下排，字号不变。只有漏斗与预算金字塔这两个形状还是
 * 小块内联 SVG——它们是图形不是排版。
 *
 * 亮起来的块是这一轮走过的路，数据只来自事件（AD-14）。尚未实现的块标出来。
 */

import { useMemo } from 'react';
import type { MemoryEventEnvelope } from '../api.js';
import { derivePipeline, PATH_LABEL, type SearchPath } from '../store/pipeline.js';

/** 一块的状态。`off` 没走到，`on` 这一轮走到了，`none` 是这一块尚未实现。 */
type Lit = 'off' | 'on' | 'none';

function cls(base: string, lit: Lit): string {
  return base + (lit === 'on' ? ' qq-map--on' : lit === 'none' ? ' qq-map--none' : '');
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

/** 竖向连接。亮起来时那道流光在往下跑，看得出方向。 */
function Link({
  lit = false,
  label,
  dashed
}: {
  lit?: boolean;
  label?: string;
  dashed?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={
        'qq-map__link' + (lit ? ' qq-map--on' : '') + (dashed ? ' qq-map__link--dashed' : '')
      }
    >
      {label ? <span className="qq-map__link-label">{label}</span> : null}
    </div>
  );
}

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
      <div className="qq-map__zones">
        {/* ── ① 选择性摄入 ───────────────────────────────── */}
        <section className="qq-map__zone" data-tone={1}>
          <header className="qq-map__zone-h">
            <b>① 选择性摄入</b>
            <span>Selective Ingestion</span>
          </header>

          <div className="qq-map__lanes">
            {(
              [
                ['文字', '词汇重合度去重', 'Jaccard', undefined, ingest],
                ['图片', '画面相似度比对', 'CLIP', '实为 Vision 转描述', false],
                ['音频', '语音活动检测', 'VAD', undefined, ingest && filtered],
                ['视频', '抽帧', 'Frame sampling', '未实现', null]
              ] as [string, string, string, string | undefined, boolean | null][]
            ).map(([mode, how, en, note, live]) => {
              const lit: Lit = live === null ? 'none' : on(Boolean(live));
              return (
                <div className="qq-map__lane" key={mode}>
                  <Box title={mode} lit={lit} size="sm" />
                  <span className={'qq-map__lane-arrow' + (lit === 'on' ? ' qq-map--on' : '')} />
                  <Box title={how} en={en} note={note} lit={lit} size="sm" />
                </div>
              );
            })}
          </div>

          <Link lit={ingest} label="四路汇成一路" />

          <div className={cls('qq-map__filter', on(ingest && (filtered || passed)))}>
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
              {rejected ? clip(p.reason, 10) : '冗余，丢掉'}
            </div>
          </div>

          <Link lit={passed} />

          <Box
            title="生成记忆原子单元"
            en="MAU Creation"
            sub={made ? p.stages.compress.detail : '大模型产出摘要 + 向量'}
            note="留下来的才进这一步，省的就是这里的钱"
            lit={on(made)}
            size="lg"
          />
        </section>

        {/* ── ② 存储与知识图谱 ───────────────────────────── */}
        <section className="qq-map__zone" data-tone={2}>
          <header className="qq-map__zone-h">
            <b>② 存储与知识图谱</b>
            <span>MAU Storage + Knowledge Graph</span>
          </header>

          <div className={cls('qq-map__shelf', on(wrote || p.hits.length > 0))}>
            <div className="qq-map__shelf-h">
              <b>热存储</b>
              <span>常驻，随时可取</span>
            </div>
            <div className="qq-map__maus">
              {[0, 1, 2].map((i) => (
                <Mau
                  key={i}
                  lit={Boolean(written[i]) && wrote}
                  text={written[i]?.text ?? p.hits[i]?.text}
                />
              ))}
            </div>
          </div>

          <Link label="指针 p" dashed />

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

          <Link />

          <Box title="实体抽取" en="Entity Extraction" note="未实现" lit="none" />

          <Link />

          <div className="qq-map__graph qq-map--none">
            <div className="qq-map__graph-h">实体归并 · 未实现，第三路走标签不跳图</div>
            <div className="qq-map__nodes">
              {(
                [
                  ['人物', '张三'],
                  ['事件', '研讨会'],
                  ['人物', '李四'],
                  ['地点', '上海']
                ] as [string, string][]
              ).map(([kind, name]) => (
                <div className="qq-map__node" key={name}>
                  <span>{kind}</span>
                  <b>{name}</b>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── ③ 检索 ─────────────────────────────────────── */}
        <section className="qq-map__zone" data-tone={3}>
          <header className="qq-map__zone-h">
            <b>③ 检索</b>
            <span>Retrieval</span>
          </header>

          <Box title={recall && p.input ? clip(p.input, 16) : '用户提问 q'} lit={on(recall)} />

          <Link lit={recall} label="三路并行" />

          <div className="qq-map__paths">
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
                lit={on(p.paths.includes(path))}
                size="sm"
              />
            ))}
          </div>

          <Link lit={p.hits.length > 0} />

          <div className={cls('qq-map__union', on(p.hits.length > 0))}>
            <b>并集</b>
            <span>{p.hits.length > 0 ? `合并去重 ${p.hits.length} 条` : '合并去重得 R(q)'}</span>
          </div>

          <Link lit={p.hits.length > 0} />

          <div className="qq-map__budget">
            <div className="qq-map__budget-h">
              <b>token 预算 B</b>
              <span>先给摘要，不够再展开，预算内为止</span>
            </div>
            <div className="qq-map__tiers">
              {(['摘要', '全文', '原始内容'] as const).map((label, i) => (
                <div
                  key={label}
                  className={cls('qq-map__tier', on(recall && p.hits.length > i))}
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

          <Link lit={recall && p.hits.length > 0} />

          <Box title="答案" lit={on(recall && p.hits.length > 0)} size="lg" />
        </section>
      </div>

      {compact ? null : (
        <p className="qq-map__note">
          亮起来的块是这一轮走过的路，取自记忆事件。灰掉的块尚未实现：视频抽帧、实体抽取、知识图谱；
          第三路检索走标签，不跳图。结构出自 <span className="qq-mono">arXiv 2604.01007</span>。
        </p>
      )}
    </div>
  );
}
