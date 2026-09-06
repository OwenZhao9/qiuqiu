/**
 * 记忆事件侧栏。骨架、颜色、字段、滚动行为全部按 `design/memory-panel.md`。
 *
 * **AD-14：只渲染事件。** 这里不做任何记忆逻辑，也不请求记忆库。
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MemoryEventEnvelope, StreamStatus, Thresholds } from '../api.js';
import { visibleEvents, type EventFilter, type EventsStore } from '../store/events.js';
import { EventCard } from './EventCard.js';
import { MemoryFlow } from './MemoryFlow.js';
import { ThresholdBadge, ThresholdPanel } from './ThresholdPanel.js';

/** 贴底判定阈值：24 px，够容忍触控板惯性又不会把「刻意往上翻一点」误判成贴底。 */
export const AT_BOTTOM_SLACK = 24;

export function computeAtBottom(el: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_SLACK;
}

const FILTERS: Array<{ value: EventFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'write', label: '只看写入' },
  { value: 'filter', label: '只看筛选' },
  { value: 'recall', label: '只看召回' },
  { value: 'merge', label: '只看合并' }
];

const STATUS_TEXT: Record<StreamStatus, string> = {
  connecting: '连接中',
  open: '已连接',
  reconnecting: '重连中',
  closed: '断开'
};

function statusClass(s: StreamStatus): string {
  if (s === 'open') return 'qq-dot qq-dot--open';
  if (s === 'closed') return 'qq-dot qq-dot--closed';
  return 'qq-dot qq-dot--reconnecting';
}

export interface MemorySidebarProps {
  store: EventsStore;
  thresholds: Thresholds;
  onThresholdsChange(next: Thresholds): void;
  /** 窄窗口下右栏变抽屉，这个位控制它有没有滑进来。 */
  open?: boolean;
}

export function MemorySidebar({
  store,
  thresholds,
  onThresholdsChange,
  open = false
}: MemorySidebarProps): React.JSX.Element {
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const [showThresholds, setShowThresholds] = useState(false);
  /** 卡片流默认收起。流程图已经把这一轮讲清楚了，同一条事实显示两遍只会让人不知道看哪。 */
  const [showLog, setShowLog] = useState(false);
  const [preview, setPreview] = useState<Thresholds | null>(null);
  const [uncertainNote, setUncertainNote] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rafPending = useRef(false);
  const lastCount = useRef(0);

  const shown = useMemo(() => visibleEvents(state), [state]);

  /** 有卡展开且在视口内时暂停自动滚（§ 4 例外 2）。 */
  const pinned = useCallback((): boolean => {
    const el = listRef.current;
    if (!el) return false;
    const open = el.querySelectorAll('[aria-expanded="true"]');
    for (const node of Array.from(open)) {
      const card = node.closest('.qq-card');
      if (!card) continue;
      const r = card.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      if (r.bottom > box.top && r.top < box.bottom) return true;
    }
    return false;
  }, []);

  const stickToBottom = useCallback((smooth: boolean) => {
    const el = listRef.current;
    if (!el) return;
    // 事件密集时平滑滚动会排队，越滚越慢——所以自动滚一律 auto
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    else el.scrollTop = el.scrollHeight;
  }, []);

  // 滚动监听：passive + rAF 节流，一帧最多算一次
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = (): void => {
      if (rafPending.current) return;
      rafPending.current = true;
      requestAnimationFrame(() => {
        rafPending.current = false;
        store.setAtBottom(computeAtBottom(el));
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // resize 只在贴底时重新贴一次（§ 4 例外 3）
    const onResize = (): void => {
      if (store.atBottom()) stickToBottom(false);
    };
    window.addEventListener('resize', onResize);
    return () => {
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [store, stickToBottom]);

  // 新事件到达后的自动滚
  useEffect(() => {
    const added = state.events.slice(lastCount.current);
    lastCount.current = state.events.length;
    if (added.length === 0) return;
    if (!store.atBottom() || pinned()) return;
    // filter.reject 照常进列表，但不触发自动滚（§ 4 例外 1）
    const worth = added.some((e) => !(e.type === 'filter' && e.payload.decision === 'reject'));
    if (worth) stickToBottom(false);
  }, [state.events, store, pinned, stickToBottom]);

  const onResolveUncertain = useCallback((_ev: MemoryEventEnvelope, keep: boolean) => {
    // 契约 § 1 没有「把拿不准的这条留下 / 丢掉」的路由，见报告的缺口清单。
    setUncertainNote(
      keep
        ? '契约里还没有「留下」的路由，这条暂时只留在侧栏里'
        : '已从这一屏收起；后端补上路由之后这里会真的落库'
    );
    setTimeout(() => setUncertainNote(null), 3000);
  }, []);

  return (
    <aside className={'qq-right' + (open ? ' qq-right--open' : '')} aria-label="记忆过程">
      {/* 抬头拆两行。六件东西挤在 340 px 一行里，标题会被断成「记忆过 程」，
          「筛选」也断成两行——这不是字号问题，是塞不下 */}
      <div className="qq-header">
        <h2 className="qq-header__title">记忆过程</h2>
        <span
          className={statusClass(state.status)}
          role="status"
          aria-label={STATUS_TEXT[state.status]}
          title={STATUS_TEXT[state.status]}
        />
        <span className="qq-spacer" />
        {state.status === 'closed' || state.status === 'reconnecting' ? (
          <button type="button" className="qq-btn qq-focusable" onClick={() => store.retry()}>
            重试
          </button>
        ) : null}
      </div>

      <div className="qq-toolbar">
        <select
          className="qq-select qq-focusable"
          aria-label="事件筛选"
          value={state.filter}
          onChange={(e) => store.setFilter(e.target.value as EventFilter)}
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="qq-spacer" />
        {/* 数字并进按钮：两个光秃秃的小数摆在抬头上，没人知道那是采集阈值 */}
        <button
          type="button"
          className="qq-btn qq-focusable"
          aria-expanded={showThresholds}
          onClick={() => setShowThresholds((v) => !v)}
        >
          采集阈值
          <ThresholdBadge value={preview ?? thresholds} />
        </button>
      </div>

      <ThresholdPanel
        expanded={showThresholds}
        value={thresholds}
        events={state.events}
        onCommitted={onThresholdsChange}
        onPreview={setPreview}
      />

      {state.lastError ? (
        <div className="qq-error qq-error--inset">
          {state.lastError.message}
          <span className="qq-error__hint">{state.lastError.hint}</span>
        </div>
      ) : null}
      {uncertainNote ? <div className="qq-note qq-note--inset">{uncertainNote}</div> : null}

      <MemoryFlow events={state.events} />

      <button
        type="button"
        className="qq-events-toggle qq-focusable"
        aria-expanded={showLog}
        onClick={() => setShowLog((v) => !v)}
      >
        {showLog ? '收起全部事件' : `全部事件（${state.events.length}）`}
      </button>

      <div className="qq-events" ref={listRef} data-testid="event-stream" hidden={!showLog}>
        {state.truncated ? <div className="qq-events__folded">更早的事件已折叠</div> : null}

        {shown.length === 0 ? (
          <div className="qq-empty">
            <div className="qq-empty__title">还没有记忆事件</div>
            <div className="qq-empty__hint">说点什么，或者打开被动采集</div>
          </div>
        ) : (
          shown.map((ev) => (
            <EventCard
              key={ev.id}
              event={ev}
              expanded={Boolean(state.expanded[ev.id])}
              onToggle={store.toggleExpanded}
              preview={preview}
              onResolveUncertain={onResolveUncertain}
            />
          ))
        )}

        {state.unread > 0 ? (
          <button
            type="button"
            className="qq-events__jump qq-focusable"
            onClick={() => {
              stickToBottom(true);
              store.setAtBottom(true);
            }}
          >
            {state.unread} 条新事件 ↓
          </button>
        ) : null}
      </div>
    </aside>
  );
}
