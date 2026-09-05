/**
 * 通话按钮：桌宠转过来的和弦落点只能有一个。
 *
 * `onCallFromPet` 在契约 § 2 里只有订阅端、没有退订端，而 `Composer` 会随页面
 * 切换反复卸载重挂。每挂一次订一个的话，桌宠按一次和弦会 toggle 好多次
 * ——按了等于没按。这里守的就是这条。
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<() => void> = [];
const bridge = {
  onCallFromPet: vi.fn((cb: () => void) => void calls.push(cb))
};

vi.mock('../src/bridge.js', () => ({ getBridge: () => bridge }));
vi.mock('../src/voice.js', () => ({
  startVoice: vi.fn(async () => ({ stop: vi.fn() }))
}));

const { VoiceButton } = await import('../src/components/VoiceButton.js');

describe('VoiceButton · 桌宠和弦', () => {
  beforeEach(() => {
    calls.length = 0;
    bridge.onCallFromPet.mockClear();
  });
  afterEach(cleanup);

  it('反复卸载重挂只订一次，落点换成最新那个实例', async () => {
    const first = render(<VoiceButton />);
    expect(bridge.onCallFromPet, '第一次挂载订一次').toHaveBeenCalledTimes(1);
    first.unmount();

    render(<VoiceButton />);
    render(<VoiceButton />);
    expect(bridge.onCallFromPet, '再挂几次也不该再订').toHaveBeenCalledTimes(1);

    // 主进程推一次和弦，按钮应该只切一次状态。startVoice 是异步的，要等它落地
    await act(async () => {
      calls[0]!();
      await Promise.resolve();
    });
    const pressed = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed, '一次和弦只该接通一路').toHaveLength(1);
  });
});
