/** 对话面板：流式渲染与「参考了 N 条记忆」。 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatPanel } from '../src/components/ChatPanel.js';
import type { ChatMessage } from '../src/store/chat.js';

function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    streaming: false,
    recallIds: [],
    memoryUsed: false,
    model: null,
    attachments: [],
    error: null,
    at: 0,
    ...over
  };
}

describe('ChatPanel', () => {
  it('没有消息时给空态', () => {
    render(<ChatPanel messages={[]} recallTexts={new Map()} />);
    expect(screen.getByText('还没聊过')).toBeTruthy();
  });

  /** jsdom 不排版，`scrollHeight` 永远是 0——量不出「跟到底了没有」，自己钉一个。 */
  function fakeLayout(el: HTMLElement, scrollHeight: number, clientHeight: number) {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  }

  it('新消息把对话滚到底——原来一行滚动都没有，说满一屏之后新说的话全在屏幕外', () => {
    const { rerender } = render(
      <ChatPanel messages={[msg({ id: 'a', content: '第一句' })]} recallTexts={new Map()} />
    );
    const thread = screen.getByTestId('thread');
    fakeLayout(thread, 1000, 300);
    thread.scrollTop = 0;

    rerender(
      <ChatPanel
        messages={[msg({ id: 'a', content: '第一句' }), msg({ id: 'b', content: '第二句' })]}
        recallTexts={new Map()}
      />
    );
    expect(thread.scrollTop).toBe(1000);
  });

  it('边说边跟：同一条回复越写越长也一直贴着底', () => {
    const { rerender } = render(
      <ChatPanel messages={[msg({ id: 'a', content: '好' })]} recallTexts={new Map()} />
    );
    const thread = screen.getByTestId('thread');
    fakeLayout(thread, 800, 300);
    rerender(<ChatPanel messages={[msg({ id: 'a', content: '好嘞，记下了' })]} recallTexts={new Map()} />);
    expect(thread.scrollTop).toBe(800);
  });

  it('人往上翻的时候不许拽回去——他在看前面说过什么', () => {
    const { rerender } = render(
      <ChatPanel messages={[msg({ id: 'a', content: '第一句' })]} recallTexts={new Map()} />
    );
    const thread = screen.getByTestId('thread');
    fakeLayout(thread, 1000, 300);
    thread.scrollTop = 100; // 离底 600，远远不算贴着底
    fireEvent.scroll(thread);

    rerender(
      <ChatPanel
        messages={[msg({ id: 'a', content: '第一句' }), msg({ id: 'b', content: '第二句' })]}
        recallTexts={new Map()}
      />
    );
    expect(thread.scrollTop).toBe(100);
  });

  it('流式中的回复标上 data-streaming，写完就摘掉', () => {
    const { rerender, container } = render(
      <ChatPanel messages={[msg({ content: '在的', streaming: true })]} recallTexts={new Map()} />
    );
    expect(container.querySelector('[data-streaming="true"]')).toBeTruthy();
    rerender(
      <ChatPanel messages={[msg({ content: '在的', streaming: false })]} recallTexts={new Map()} />
    );
    expect(container.querySelector('[data-streaming="true"]')).toBeNull();
  });

  it('还没有第一个字时显示「丘丘在想…」', () => {
    render(
      <ChatPanel messages={[msg({ content: '', streaming: true })]} recallTexts={new Map()} />
    );
    expect(screen.getByText('丘丘在想…')).toBeTruthy();
  });

  it('「参考了 N 条记忆」默认收起，点开列出 recall 事件里的文本', () => {
    render(
      <ChatPanel
        messages={[msg({ content: '你上周搬家了', recallIds: ['fact_a', 'fact_b'] })]}
        recallTexts={new Map([['fact_a', '他上周搬到深圳']])}
      />
    );
    const toggle = screen.getByText('参考了 2 条记忆');
    expect(screen.queryByText('他上周搬到深圳')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText('他上周搬到深圳')).toBeTruthy();
    // 事件里没有文本的那条退化成 id 前 8 位
    expect(screen.getByText('fact_b')).toBeTruthy();
  });

  it('没有 recall_ids 时不显示那一行', () => {
    render(<ChatPanel messages={[msg({ content: '好' })]} recallTexts={new Map()} />);
    expect(screen.queryByText(/参考了/)).toBeNull();
  });

  it('这一轮出错时把 message 与 hint 都显示出来', () => {
    render(
      <ChatPanel
        messages={[msg({ error: { code: 'x', message: '模型没回', hint: '换一个供应商再试' } })]}
        recallTexts={new Map()}
      />
    );
    expect(screen.getByText('模型没回')).toBeTruthy();
    expect(screen.getByText('换一个供应商再试')).toBeTruthy();
  });

  it('用户消息与丘丘消息分开两种气泡', () => {
    const { container } = render(
      <ChatPanel
        messages={[
          msg({ id: 'u', role: 'user', content: '在吗' }),
          msg({ id: 'a', content: '在' })
        ]}
        recallTexts={new Map()}
      />
    );
    expect(container.querySelectorAll('.qq-msg--user')).toHaveLength(1);
    expect(container.querySelectorAll('.qq-msg--assistant')).toHaveLength(1);
  });
});
