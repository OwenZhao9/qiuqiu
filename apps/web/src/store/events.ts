/**
 * 记忆事件流的本地缓存。
 *
 * 数据源只有 `GET /events`（**AD-14：事件是可见性的唯一数据源**，
 * 侧栏不读记忆库、不解析回复）。滚动与丢弃规则逐条按 `design/memory-panel.md` § 4。
 */

import {
  openEventStream,
  type ApiError,
  type EventStream,
  type MemoryEventEnvelope,
  type MemoryEventType,
  type StreamStatus,
  cursorOf
} from '../api.js';
import { createStore, type Store } from './store.js';

/** DOM 里最多保留 500 张卡。 */
export const MAX_EVENTS = 500;

export type EventFilter = 'all' | MemoryEventType;

export interface EventsState {
  events: MemoryEventEnvelope[];
  status: StreamStatus;
  lastError: ApiError | null;
  /** 头部丢弃过事件，列表顶要显示「更早的事件已折叠」。 */
  truncated: boolean;
  /** 未读计数：不在底部时来的事件。 */
  unread: number;
  filter: EventFilter;
  /** 按事件 id 记住的展开态，切筛选或重连后保持。 */
  expanded: Readonly<Record<string, boolean>>;
}

export interface EventsStore extends Store<EventsState> {
  /** 收一条事件（真实流或 mock 都走这里）。 */
  push(ev: MemoryEventEnvelope): void;
  /** 列表是否贴底。丢弃与自动滚都看它。 */
  setAtBottom(atBottom: boolean): void;
  atBottom(): boolean;
  clearUnread(): void;
  setFilter(f: EventFilter): void;
  toggleExpanded(id: string): void;
  cursor(): number | null;
  retry(): void;
  connect(): void;
  destroy(): void;
}

export interface EventsStoreDeps {
  /** 注入 `openEventStream`，测试与 mock 用。 */
  open?: typeof openEventStream;
  since?: number | null;
  /** 每条事件都抄送一份（丘丘的事件表情从这里走）。 */
  onEvent?(ev: MemoryEventEnvelope): void;
}

function isReject(ev: MemoryEventEnvelope): boolean {
  return ev.type === 'filter' && ev.payload.decision === 'reject';
}

export function createEventsStore(deps: EventsStoreDeps = {}): EventsStore {
  const open = deps.open ?? openEventStream;

  const store = createStore<EventsState>({
    events: [],
    status: 'connecting',
    lastError: null,
    truncated: false,
    unread: 0,
    filter: 'all',
    expanded: {}
  });

  let stream: EventStream | null = null;
  let atBottom = true;
  let manualCursor: number | null = deps.since ?? null;
  const seen = new Set<string>();

  function push(ev: MemoryEventEnvelope): void {
    // 重复到达时按 id 丢弃后到的那条（design/memory-panel.md § 4）
    if (seen.has(ev.id)) return;
    seen.add(ev.id);
    const c = cursorOf(ev.id);
    if (c !== null) manualCursor = manualCursor === null ? c : Math.max(manualCursor, c);

    store.set((s) => {
      let events = [...s.events, ev];
      let truncated = s.truncated;
      // 丢弃只发生在贴底时——用户正在往上翻的时候删他脚下的内容是最糟糕的体验
      if (events.length > MAX_EVENTS && atBottom) {
        events = events.slice(events.length - MAX_EVENTS);
        truncated = true;
      }
      return {
        ...s,
        events,
        truncated,
        // filter.reject 照常计入未读，只是不触发自动滚（§ 4 例外 1，滚动那半边在组件里）
        unread: atBottom ? 0 : s.unread + 1
      };
    });
    deps.onEvent?.(ev);
  }

  function connect(): void {
    stream?.close();
    stream = open({
      since: manualCursor,
      onEvent: push,
      onStatus(status, detail) {
        store.set((s) => ({
          ...s,
          status,
          lastError: detail ?? (status === 'open' ? null : s.lastError)
        }));
      }
    });
  }

  return {
    ...store,
    push,
    setAtBottom(next) {
      atBottom = next;
      if (next && store.get().unread !== 0) store.set((s) => ({ ...s, unread: 0 }));
    },
    atBottom: () => atBottom,
    clearUnread() {
      store.set((s) => (s.unread === 0 ? s : { ...s, unread: 0 }));
    },
    setFilter(f) {
      store.set((s) => ({ ...s, filter: f }));
    },
    toggleExpanded(id) {
      store.set((s) => ({ ...s, expanded: { ...s.expanded, [id]: !s.expanded[id] } }));
    },
    cursor: () => stream?.cursor() ?? manualCursor,
    retry() {
      stream?.retryNow();
    },
    connect,
    destroy() {
      stream?.close();
      stream = null;
    }
  };
}

/** 侧栏当前该显示哪些事件。纯前端过滤，不改 `since` 游标。 */
export function visibleEvents(state: EventsState): MemoryEventEnvelope[] {
  if (state.filter === 'all') return state.events;
  return state.events.filter((e) => e.type === state.filter);
}

/** 这条事件到达时该不该触发自动滚。`filter.reject` 永远不触发（§ 4 例外 1）。 */
export function shouldAutoScroll(ev: MemoryEventEnvelope): boolean {
  return !isReject(ev);
}
