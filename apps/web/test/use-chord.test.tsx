/**
 * 和弦快捷键。字母键当快捷键最容易在输入框里误触发——
 * 中文拼音打「擦」「察」「猜」都要先 c 后 a，两个键会短暂同按。
 */

import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { isTyping, useChord } from '../src/useChord.js';

function Probe({ onFire, allowWhileTyping }: { onFire(): void; allowWhileTyping?: boolean }) {
  useChord(['KeyC', 'KeyA'], onFire, { allowWhileTyping });
  return <textarea aria-label="输入框" />;
}

/** 按下 / 抬起一个键。`target` 缺省是 body，即不在输入框里。 */
function key(type: 'keydown' | 'keyup', code: string, target?: Element): void {
  // testing-library 的方法名是驼峰的 keyDown / keyUp，不是事件名
  const fn = type === 'keydown' ? fireEvent.keyDown : fireEvent.keyUp;
  fn(target ?? document.body, { code, bubbles: true });
}

describe('useChord', () => {
  it('两个键都按下才触发', () => {
    const fire = vi.fn();
    render(<Probe onFire={fire} />);
    key('keydown', 'KeyC');
    expect(fire).not.toHaveBeenCalled();
    key('keydown', 'KeyA');
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('顺序反过来也算', () => {
    const fire = vi.fn();
    render(<Probe onFire={fire} />);
    key('keydown', 'KeyA');
    key('keydown', 'KeyC');
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('按住不放不连发', () => {
    const fire = vi.fn();
    render(<Probe onFire={fire} />);
    key('keydown', 'KeyC');
    key('keydown', 'KeyA');
    key('keydown', 'KeyA'); // 系统的自动重复
    key('keydown', 'KeyA');
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('松开再按能再次触发', () => {
    const fire = vi.fn();
    render(<Probe onFire={fire} />);
    key('keydown', 'KeyC');
    key('keydown', 'KeyA');
    key('keyup', 'KeyA');
    key('keydown', 'KeyA');
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('在输入框里打字不触发——这是字母和弦的主要风险', () => {
    const fire = vi.fn();
    const { getByLabelText } = render(<Probe onFire={fire} />);
    const box = getByLabelText('输入框');
    key('keydown', 'KeyC', box);
    key('keydown', 'KeyA', box);
    expect(fire).not.toHaveBeenCalled();
  });

  it('带修饰键的组合不抢——那是别人的快捷键', () => {
    const fire = vi.fn();
    render(<Probe onFire={fire} />);
    fireEvent.keyDown(document.body, { code: 'KeyC', metaKey: true, bubbles: true });
    fireEvent.keyDown(document.body, { code: 'KeyA', metaKey: true, bubbles: true });
    expect(fire).not.toHaveBeenCalled();
  });

  it('不相干的键不参与', () => {
    const fire = vi.fn();
    render(<Probe onFire={fire} />);
    key('keydown', 'KeyC');
    key('keydown', 'KeyB');
    expect(fire).not.toHaveBeenCalled();
  });

  it('切走窗口再回来不会以为键还按着', () => {
    const fire = vi.fn();
    render(<Probe onFire={fire} />);
    key('keydown', 'KeyC');
    fireEvent.blur(window);
    key('keydown', 'KeyA');
    expect(fire).not.toHaveBeenCalled();
  });
});

describe('isTyping', () => {
  it('认得出输入框、文本域与可编辑区', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isTyping(document.createElement(tag))).toBe(true);
    }
    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTyping(editable)).toBe(true);
  });

  it('普通元素与空值都不算', () => {
    expect(isTyping(document.createElement('div'))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});
