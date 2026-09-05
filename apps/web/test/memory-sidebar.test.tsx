/** 侧栏骨架、连接状态、筛选、空态、阈值区。 */

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemorySidebar,
  computeAtBottom,
  AT_BOTTOM_SLACK
} from '../src/components/MemorySidebar.js';
import { createEventsStore, type EventsStore } from '../src/store/events.js';
import { DEFAULT_THRESHOLDS } from '../src/store/thresholds.js';
import type { StreamStatus } from '../src/api.js';
import { makeEvent, resetEventSeq } from './helpers.js';

function stubStore(): { store: EventsStore; setStatus(s: StreamStatus): void; retried(): number } {
  let onStatus: ((s: StreamStatus) => void) | undefined;
  let retries = 0;
  const store = createEventsStore({
    open: (opts) => {
      onStatus = opts.onStatus as (s: StreamStatus) => void;
      return {
        cursor: () => null,
        status: () => 'open',
        retryNow: () => {
          retries += 1;
        },
        close() {}
      };
    }
  });
  store.connect();
  return { store, setStatus: (s) => onStatus?.(s), retried: () => retries };
}

function show(store: EventsStore) {
  return render(
    <MemorySidebar store={store} thresholds={DEFAULT_THRESHOLDS} onThresholdsChange={vi.fn()} />
  );
}

describe('computeAtBottom', () => {
  it('阈值是 24 px', () => {
    expect(AT_BOTTOM_SLACK).toBe(24);
    expect(computeAtBottom({ scrollHeight: 1000, scrollTop: 776, clientHeight: 200 })).toBe(true);
    expect(computeAtBottom({ scrollHeight: 1000, scrollTop: 775, clientHeight: 200 })).toBe(false);
  });
});

describe('MemorySidebar', () => {
  beforeEach(() => resetEventSeq());

  it('没有事件时给空态两行', () => {
    const { store } = stubStore();
    show(store);
    expect(screen.getByText('还没有记忆事件')).toBeTruthy();
    expect(screen.getByText('说点什么，或者打开被动采集')).toBeTruthy();
  });

  it('连接状态点跟着流的状态走，断开时旁边出「重试」', () => {
    const { store, setStatus, retried } = stubStore();
    const { container } = show(store);
    act(() => setStatus('open'));
    expect(container.querySelector('.qq-dot--open')).toBeTruthy();

    act(() => setStatus('reconnecting'));
    expect(container.querySelector('.qq-dot--reconnecting')).toBeTruthy();
    fireEvent.click(screen.getByText('重试'));
    expect(retried()).toBe(1);
  });

  it('筛选是纯前端的：只看召回时写入卡不渲染，但事件还在', () => {
    const { store } = stubStore();
    show(store);
    act(() => {
      store.push(
        makeEvent('write', { facts: [{ id: 'f', text: '写了一条', entities: [], valid_from: '' }] })
      );
      store.push(makeEvent('recall', { query: '召回一条', hits: [], cold_promoted: [] }));
    });
    // 流程图会把同一条事实也显示一遍，所以要限定在事件流里找
    const stream = () => screen.getByTestId('event-stream');
    expect(within(stream()).getByText('写了一条')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('事件筛选'), { target: { value: 'recall' } });
    expect(within(stream()).queryByText('写了一条')).toBeNull();
    expect(within(stream()).getByText('召回一条')).toBeTruthy();
    expect(store.get().events).toHaveLength(2);
  });

  it('点卡头切展开态，再点收回', () => {
    const { store } = stubStore();
    show(store);
    act(() => {
      store.push(
        makeEvent('filter', {
          decision: 'uncertain',
          score: 0.5,
          reason: '时间缺',
          source: 'ambient_audio',
          input_preview: '明天下午'
        })
      );
    });
    const head = within(screen.getByTestId('event-stream'))
      .getByText('明天下午')
      .closest('button') as HTMLButtonElement;
    fireEvent.click(head);
    expect(screen.getByText('时间缺')).toBeTruthy();
    fireEvent.click(head);
    expect(screen.queryByText('时间缺')).toBeNull();
  });

  it('齿轮展开阈值区，折叠时标题栏显示 0.72 / 0.45', () => {
    const { store } = stubStore();
    const { container } = show(store);
    expect(screen.getByText('0.72 / 0.45')).toBeTruthy();
    expect(container.querySelector('.qq-thresholds--collapsed')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('阈值'));
    expect(container.querySelector('.qq-thresholds--expanded')).toBeTruthy();
    expect(screen.getByLabelText('保留线')).toBeTruthy();
    expect(screen.getByLabelText('丢弃线')).toBeTruthy();
  });

  it('不贴底时浮出「N 条新事件 ↓」，点了清零', () => {
    const { store } = stubStore();
    show(store);
    act(() => {
      store.setAtBottom(false);
      store.push(makeEvent('write', { facts: [] }));
      store.push(makeEvent('merge', {}));
    });
    const jump = screen.getByText('2 条新事件 ↓');
    fireEvent.click(jump);
    expect(store.get().unread).toBe(0);
  });

  it('丢弃过头部事件时列表顶显示「更早的事件已折叠」', () => {
    const { store } = stubStore();
    show(store);
    act(() => {
      store.setAtBottom(true);
      for (let i = 1; i <= 502; i += 1) {
        store.push(
          makeEvent('filter', { decision: 'reject', score: 0.1, input_preview: 'x' }, 'evt_' + i)
        );
      }
    });
    expect(screen.getByText('更早的事件已折叠')).toBeTruthy();
  });
});
