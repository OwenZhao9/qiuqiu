/** 事件缓存：去重、500 上限、未读、筛选、展开态。规则见 `design/memory-panel.md` § 4。 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEventsStore,
  MAX_EVENTS,
  shouldAutoScroll,
  visibleEvents
} from '../src/store/events.js';
import { makeEvent, resetEventSeq } from './helpers.js';

function store() {
  return createEventsStore({
    open: () => ({ cursor: () => null, status: () => 'open', retryNow() {}, close() {} })
  });
}

describe('createEventsStore', () => {
  beforeEach(() => resetEventSeq());

  it('同一个 id 重复到达时丢掉后到的那条', () => {
    const s = store();
    const ev = makeEvent('write', { facts: [] }, 'evt_5');
    s.push(ev);
    s.push({ ...ev });
    expect(s.get().events).toHaveLength(1);
  });

  it('贴底时超过 500 条从头丢，并标记「更早的事件已折叠」', () => {
    const s = store();
    s.setAtBottom(true);
    for (let i = 1; i <= MAX_EVENTS + 3; i += 1) {
      s.push(makeEvent('filter', { decision: 'reject', score: 0.1 }, 'evt_' + i));
    }
    expect(s.get().events).toHaveLength(MAX_EVENTS);
    expect(s.get().truncated).toBe(true);
    expect(s.get().events[0].id).toBe('evt_4');
  });

  it('不贴底时不丢——用户正在往上翻，不能删他脚下的内容', () => {
    const s = store();
    s.setAtBottom(false);
    for (let i = 1; i <= MAX_EVENTS + 3; i += 1) {
      s.push(makeEvent('filter', { decision: 'reject', score: 0.1 }, 'evt_' + i));
    }
    expect(s.get().events).toHaveLength(MAX_EVENTS + 3);
    expect(s.get().truncated).toBe(false);
  });

  it('不贴底时新事件累计未读，滚回底部清零', () => {
    const s = store();
    s.setAtBottom(false);
    s.push(makeEvent('write', { facts: [] }));
    s.push(makeEvent('merge', {}));
    expect(s.get().unread).toBe(2);
    s.setAtBottom(true);
    expect(s.get().unread).toBe(0);
  });

  it('filter.reject 照常计入未读，只是不触发自动滚', () => {
    const s = store();
    s.setAtBottom(false);
    const reject = makeEvent('filter', { decision: 'reject', score: 0.1 });
    s.push(reject);
    expect(s.get().unread).toBe(1);
    expect(shouldAutoScroll(reject)).toBe(false);
    expect(shouldAutoScroll(makeEvent('write', { facts: [] }))).toBe(true);
  });

  it('筛选是纯前端的，不动已经收到的事件', () => {
    const s = store();
    s.push(makeEvent('write', { facts: [] }));
    s.push(makeEvent('recall', { hits: [], cold_promoted: [] }));
    s.setFilter('recall');
    expect(visibleEvents(s.get())).toHaveLength(1);
    expect(s.get().events).toHaveLength(2);
  });

  it('展开态按事件 id 记，切筛选之后还在', () => {
    const s = store();
    s.push(makeEvent('write', { facts: [] }, 'evt_1'));
    s.toggleExpanded('evt_1');
    expect(s.get().expanded['evt_1']).toBe(true);
    s.setFilter('write');
    expect(s.get().expanded['evt_1']).toBe(true);
    s.toggleExpanded('evt_1');
    expect(s.get().expanded['evt_1']).toBe(false);
  });

  it('游标跟着最大的自增 id 走，乱序到达也不倒退', () => {
    const s = store();
    s.push(makeEvent('write', { facts: [] }, 'evt_9'));
    s.push(makeEvent('write', { facts: [] }, 'evt_4'));
    expect(s.cursor()).toBe(9);
  });
});
