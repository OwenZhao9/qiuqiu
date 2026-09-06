/**
 * 记忆事件卡。四类事件的颜色、字段、附加处理逐条按 `design/memory-panel.md` § 2 与 § 3。
 *
 * **AD-14：侧栏只消费事件。** 卡上出现的每一个字都追得到某条事件的某个字段，
 * 不读记忆库、不解析回复内容。
 */

import { useMemo } from 'react';
import type { FilterDecision, MemoryEventEnvelope, RecallPath, Thresholds } from '../api.js';
import { decide, decisionLabel } from '../store/thresholds.js';
import {
  eventTypeLabel,
  formatClock,
  formatDay,
  pathLabel,
  reasonCN,
  score2,
  shortId,
  sourceLabel,
  speakerLabel
} from '../format.js';

export interface EventCardProps {
  event: MemoryEventEnvelope;
  expanded: boolean;
  onToggle(id: string): void;
  /** 拖动阈值时的本地预演：只重算颜色，不改 `payload.decision` 的原值。 */
  preview?: Thresholds | null;
  /**
   * `uncertain` 卡上的「留下 / 丢掉」。**契约 v0.1.8 把它推迟到 M3**，暂无路由。
   *
   * 原因不是漏了：v0.1.7 定的「`uncertain` 只发事件不落库」意味着事件里只剩
   * `input_preview`——80 字截断带省略号。照它「留下」，存进记忆的是被截断的半句话，
   * 比按钮点不动更糟。要做得先定「拿不准的原文停在哪里等用户决定」。
   */
  onResolveUncertain?(event: MemoryEventEnvelope, keep: boolean): void;
}

function Pill({
  children,
  kind
}: {
  children: React.ReactNode;
  kind?: 'hit' | 'skipped' | 'cold' | 'tag';
}): React.JSX.Element {
  return <span className={'qq-pill' + (kind ? ' qq-pill--' + kind : '')}>{children}</span>;
}

/** `plan.paths` 每条一个胶囊：命中的实心，`skipped_paths` 里的描边加删除线。 */
function PathPills({
  paths,
  skipped
}: {
  paths: readonly RecallPath[];
  skipped: readonly RecallPath[];
}): React.JSX.Element | null {
  if (paths.length === 0 && skipped.length === 0) return null;
  const all = [...paths, ...skipped.filter((p) => !paths.includes(p))];
  return (
    <span className="qq-paths">
      {all.map((p) => (
        <Pill key={p} kind={skipped.includes(p) ? 'skipped' : 'hit'}>
          {pathLabel(p)}
        </Pill>
      ))}
    </span>
  );
}

function summaryOf(ev: MemoryEventEnvelope): string {
  switch (ev.type) {
    case 'filter':
      return ev.payload.input_preview ?? '';
    case 'write': {
      const facts = ev.payload.facts ?? [];
      if (facts.length === 0) return '';
      return facts.length > 1 ? `${facts[0].text} 等 ${facts.length} 条` : facts[0].text;
    }
    case 'merge':
      return ev.payload.result_text ?? '';
    case 'recall':
      return ev.payload.query ?? '';
    default:
      return '';
  }
}

/** 卡的配色类。`filter` 按（可能被预演重算过的）判定分三色。 */
function variantOf(ev: MemoryEventEnvelope, effective: FilterDecision | null): string {
  if (ev.type === 'filter') return 'qq-card--filter-' + (effective ?? ev.payload.decision);
  return 'qq-card--' + ev.type;
}

export function EventCard({
  event,
  expanded,
  onToggle,
  preview,
  onResolveUncertain
}: EventCardProps): React.JSX.Element {
  const effective = useMemo<FilterDecision | null>(() => {
    if (event.type !== 'filter' || !preview) return null;
    return decide(event.payload.score, preview);
  }, [event, preview]);

  const badge =
    event.type === 'filter'
      ? `${eventTypeLabel(event.type)}·${decisionLabel(event.payload.decision)}`
      : eventTypeLabel(event.type);

  return (
    <div
      className={'qq-card ' + variantOf(event, effective)}
      data-testid={'event-' + event.id}
      data-event-type={event.type}
      data-decision={event.type === 'filter' ? event.payload.decision : undefined}
      data-effective-decision={effective ?? undefined}
    >
      <span className="qq-card__bar" aria-hidden="true" />
      <div className="qq-card__body">
        <button
          type="button"
          className="qq-card__head qq-focusable"
          style={{ border: 'none', background: 'none', padding: 0, width: '100%' }}
          title={`id ${event.id}\ntrace_id ${event.trace_id}\n${event.ts}`}
          aria-expanded={expanded}
          onClick={() => onToggle(event.id)}
        >
          <span className="qq-card__badge">{badge}</span>
          <span className="qq-card__summary">{summaryOf(event)}</span>
          <span className="qq-card__time">{formatClock(event.ts)}</span>
        </button>

        {event.type === 'recall' && event.payload.cold_promoted.length > 0 ? (
          <span className="qq-paths">
            <Pill kind="cold">回热 {event.payload.cold_promoted.length} 条</Pill>
          </span>
        ) : null}

        {event.type === 'filter' && event.payload.decision === 'uncertain' ? (
          <div className="qq-paths">
            <button
              type="button"
              className="qq-btn qq-focusable"
              onClick={() => onResolveUncertain?.(event, true)}
            >
              留下
            </button>
            <button
              type="button"
              className="qq-btn qq-focusable"
              onClick={() => onResolveUncertain?.(event, false)}
            >
              丢掉
            </button>
          </div>
        ) : null}

        {expanded ? <EventDetail event={event} /> : null}
      </div>
    </div>
  );
}

/** 展开态。空数组的小节整段不渲染——空态标题比空数据更吵（§ 3）。 */
function EventDetail({ event }: { event: MemoryEventEnvelope }): React.JSX.Element {
  if (event.type === 'filter') {
    const p = event.payload;
    return (
      <div className="qq-card__detail">
        <div>
          <span className="qq-card__badge">{decisionLabel(p.decision)}</span>{' '}
          <span className="qq-mono">{score2(p.score)}</span>
        </div>
        {p.reason ? <p className="qq-plain">{reasonCN(p.reason)}</p> : null}
        {p.input_preview ? <p className="qq-card__preview">{p.input_preview}</p> : null}
        {p.source ? <div className="qq-card__foot">{sourceLabel(p.source)}</div> : null}
      </div>
    );
  }

  if (event.type === 'write') {
    const p = event.payload;
    const facts = p.facts ?? [];
    const dropped = p.dropped_spans ?? [];
    return (
      <div className="qq-card__detail">
        {p.speaker ? <div className="qq-card__foot">{speakerLabel(p.speaker)}</div> : null}
        {facts.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 'var(--qq-space-6)' }}>
            {facts.map((f) => {
              const entities = f.entities ?? [];
              const shown = entities.slice(0, 3);
              const rest = entities.length - shown.length;
              return (
                <li key={f.id} data-fact-id={f.id}>
                  {f.text}{' '}
                  {shown.map((e) => (
                    <Pill key={e} kind="tag">
                      {e}
                    </Pill>
                  ))}
                  {rest > 0 ? <Pill kind="tag">+{rest}</Pill> : null}{' '}
                  <span className="qq-card__foot">{formatDay(f.valid_from)}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        {dropped.length > 0 ? (
          <details>
            <summary className="qq-card__section-title">丢掉了 {dropped.length} 段</summary>
            {dropped.map((s, i) => (
              <div key={i} className="qq-strike">
                {s}
              </div>
            ))}
          </details>
        ) : null}
        {p.raw ? (
          <details>
            <summary className="qq-card__section-title">看原话</summary>
            <p style={{ margin: 0 }}>{p.raw}</p>
          </details>
        ) : null}
      </div>
    );
  }

  if (event.type === 'merge') {
    const p = event.payload;
    const absorbed = p.absorbed ?? [];
    const invalidated = p.invalidated ?? [];
    return (
      <div className="qq-card__detail" data-memory-id={p.result_id}>
        <div className="qq-card__result">{p.result_text}</div>
        {absorbed.length > 0 ? (
          <div>
            <div className="qq-card__section-title">合并了 {absorbed.length} 条</div>
            {absorbed.map((a) => (
              <div key={a.id} className="qq-strike">
                {a.text || shortId(a.id)}
              </div>
            ))}
          </div>
        ) : null}
        {invalidated.length > 0 ? (
          <div>
            <div className="qq-card__section-title">作废 {invalidated.length} 条</div>
            {invalidated.map((a) => (
              <div key={a.id} className="qq-strike">
                {a.text || shortId(a.id)}{' '}
                <span className="qq-card__foot">{formatDay(a.valid_to)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const p = event.payload;
  const hits = p.hits ?? [];
  const cold = p.cold_promoted ?? [];
  const rewritten = p.plan?.rewritten;
  return (
    <div className="qq-card__detail">
      <div>{p.query}</div>
      {rewritten && rewritten !== p.query ? (
        <div className="qq-card__foot">改写为 {rewritten}</div>
      ) : null}
      <div className="qq-paths">
        <PathPills paths={p.plan?.paths ?? []} skipped={p.skipped_paths ?? []} />
        {typeof p.plan?.depth === 'number' ? (
          <span className="qq-card__foot">深度 {p.plan.depth}</span>
        ) : null}
      </div>
      {hits.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 'var(--qq-space-6)' }}>
          {hits.map((h) => (
            <li key={h.id} data-memory-id={h.id}>
              <Pill kind="hit">{pathLabel(h.path)}</Pill>{' '}
              <span className="qq-mono">{score2(h.score)}</span>{' '}
              {h.text || <span className="qq-mono">{shortId(h.id)}</span>}
            </li>
          ))}
        </ul>
      ) : null}
      {cold.length > 0 ? (
        <div>
          <div className="qq-card__section-title">回热 {cold.length} 条</div>
          {cold.map((id) => (
            <div key={id} className="qq-mono qq-card__foot">
              {shortId(id)}
            </div>
          ))}
        </div>
      ) : null}
      {typeof p.tokens_injected === 'number' ? (
        <div className="qq-card__foot">注入 {p.tokens_injected} tokens</div>
      ) : null}
    </div>
  );
}
