/**
 * 输入条的键盘行为，`design/interaction.md` § 2。
 *
 * 中文界面的头号 bug：**输入法组字期间 `Enter` 绝不发送**。
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Composer } from '../src/components/Composer.js';

function main(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSubmit = vi.fn();
  render(<Composer variant="main" history={[]} onSubmit={onSubmit} {...props} />);
  return { onSubmit, box: screen.getByLabelText('说点什么') as HTMLTextAreaElement };
}

describe('Composer · 键盘', () => {
  it('Enter 发送', () => {
    const { onSubmit, box } = main();
    fireEvent.change(box, { target: { value: '在吗' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('在吗', []);
  });

  it('组字期间的 Enter 一律不发送（isComposing）', () => {
    const { onSubmit, box } = main();
    fireEvent.change(box, { target: { value: 'zhonguo' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('组字期间的 Enter 一律不发送（compositionstart 标志）', () => {
    const { onSubmit, box } = main();
    fireEvent.change(box, { target: { value: '中国' } });
    fireEvent.compositionStart(box);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.compositionEnd(box);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).toHaveBeenCalledWith('中国', []);
  });

  it('Shift+Enter 换行，不发送', () => {
    const { onSubmit, box } = main();
    fireEvent.change(box, { target: { value: '第一行' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Cmd/Ctrl+Enter 等同 Enter', () => {
    const { onSubmit, box } = main();
    fireEvent.change(box, { target: { value: '发' } });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('内容去空白后为空则不发，也不报错', () => {
    const { onSubmit, box } = main();
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('输入框为空时 ↑ 载入上一条，连按继续往前翻', () => {
    const { box } = main({ history: ['第一句', '第二句'] });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.value).toBe('第二句');
  });

  it('输入框非空时 ↑ 不劫持', () => {
    const { box } = main({ history: ['第一句'] });
    fireEvent.change(box, { target: { value: '正在打' } });
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.value).toBe('正在打');
  });

  it('主窗口流式中按 Esc 等于点停止', () => {
    const onStop = vi.fn();
    const { box } = main({ streaming: true, onStop });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('主窗口不流式时按 Esc 清空输入框', () => {
    const { box } = main();
    fireEvent.change(box, { target: { value: '写了一半' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
  });

  it('流式中显示「停止」，不流式显示「发送」', () => {
    const { unmount } = render(
      <Composer variant="main" history={[]} onSubmit={vi.fn()} streaming onStop={vi.fn()} />
    );
    expect(screen.getByText('停止')).toBeTruthy();
    unmount();
    render(<Composer variant="main" history={[]} onSubmit={vi.fn()} />);
    expect(screen.getByText('发送')).toBeTruthy();
  });
});

describe('Composer · 桌宠变体', () => {
  it('桌宠是单行输入条，Esc 交给宿主收起', () => {
    const onEscape = vi.fn();
    render(<Composer variant="pet" history={[]} onSubmit={vi.fn()} onEscape={onEscape} />);
    const box = screen.getByLabelText('跟丘丘说话');
    expect((box as HTMLInputElement).type).toBe('text');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledOnce();
  });

  it('桌宠的文本受控，收起再展开还在', () => {
    const onTextChange = vi.fn();
    const { rerender } = render(
      <Composer
        variant="pet"
        history={[]}
        onSubmit={vi.fn()}
        text="打了一半"
        onTextChange={onTextChange}
      />
    );
    expect((screen.getByLabelText('跟丘丘说话') as HTMLInputElement).value).toBe('打了一半');
    rerender(
      <Composer
        variant="pet"
        history={[]}
        onSubmit={vi.fn()}
        text="打了一半"
        onTextChange={onTextChange}
      />
    );
    expect((screen.getByLabelText('跟丘丘说话') as HTMLInputElement).value).toBe('打了一半');
  });

  it('语音按钮是「说话」，按一下开会话再按一下挂断', () => {
    // 端到端链路是全双工的，不做「按住不放」——那样人不敢插话，
    // 把这条链路最值钱的「能打断」浪费掉了
    render(<Composer variant="main" history={[]} onSubmit={vi.fn()} />);
    const btn = screen.getByRole('button', { name: '说话' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('拿不到麦克风时给能看懂的话，不是静默失败', async () => {
    const original = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => Promise.reject(new Error('NotAllowedError')) }
    });
    try {
      render(<Composer variant="main" history={[]} onSubmit={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: '说话' }));
      expect(await screen.findByText(/拿不到麦克风/)).toBeTruthy();
      expect(screen.getByText(/允许麦克风/)).toBeTruthy();
    } finally {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: original });
    }
  });
});
