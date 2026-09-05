/**
 * 音色选择组件。契约 v0.1.10 § 1。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getFetchImpl, setFetchImpl } from '../src/api.js';
import { VoicePicker } from '../src/components/VoicePicker.js';
import { installMockServer, type MockServer } from '../src/mock-server.js';

describe('VoicePicker', () => {
  let server: MockServer | null = null;

  beforeEach(() => {
    server = installMockServer({ deltaMs: 0, ambientMs: 0 });
  });
  afterEach(() => {
    cleanup();
    server?.stop();
    server = null;
  });

  it('列出音色，且一个都不是男声', async () => {
    render(<VoicePicker />);
    await screen.findByText('Vivi');
    const buttons = screen.getAllByRole('radio');
    expect(buttons.length).toBeGreaterThan(1);
    for (const button of buttons) {
      expect(button.textContent ?? '').not.toMatch(/男/);
    }
  });

  it('当前音色是选中态', async () => {
    render(<VoicePicker />);
    const vivi = await screen.findByRole('radio', { name: /Vivi/ });
    expect(vivi.getAttribute('aria-checked')).toBe('true');
  });

  it('点一下就切过去并存下来', async () => {
    render(<VoicePicker />);
    const target = await screen.findByRole('radio', { name: /高冷御姐/ });
    fireEvent.click(target);
    await waitFor(() => expect(target.getAttribute('aria-checked')).toBe('true'));
    const vivi = screen.getByRole('radio', { name: /Vivi/ });
    expect(vivi.getAttribute('aria-checked')).toBe('false');
  });

  it('没有实时语音对应项的音色，界面上说清会回退', async () => {
    render(<VoicePicker />);
    await screen.findByText('Vivi');
    // Vivi 两条链路都有，不该有这行提示；高冷御姐没有，该有
    const notes = screen.getAllByText('实时语音下用默认音色');
    expect(notes.length).toBeGreaterThan(0);
    const vivi = screen.getByRole('radio', { name: /Vivi/ });
    expect(vivi.textContent).not.toContain('实时语音下用默认音色');
  });

  it('存失败时退回原值并把 hint 显示出来', async () => {
    render(<VoicePicker />);
    await screen.findByText('Vivi');

    // `api.ts` 走的是注入的 fetch，不是全局的——所以打桩要走 `setFetchImpl`。
    // 只截 PUT /config/voice，其余照旧走 mock server。
    // mock server 自己也是经 `setFetchImpl` 装上的，先把它取回来做兜底，
    // 否则会退到全局 fetch，把 mock 整个绕过去。
    const passthrough = getFetchImpl();
    setFetchImpl((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/config/voice') && init?.method === 'PUT') {
        return new Response(
          JSON.stringify({ error: { code: 'boom', message: '存不了', hint: '再点一次' } }),
          { status: 500, headers: { 'content-type': 'application/json' } }
        );
      }
      return passthrough(String(input), init);
    }) as typeof fetch);

    try {
      const target = screen.getByRole('radio', { name: /高冷御姐/ });
      fireEvent.click(target);
      await screen.findByText('再点一次', {}, { timeout: 3000 });
      expect(target.getAttribute('aria-checked')).toBe('false');
      expect(screen.getByRole('radio', { name: /Vivi/ }).getAttribute('aria-checked')).toBe('true');
    } finally {
      setFetchImpl(passthrough);
    }
  });
});
