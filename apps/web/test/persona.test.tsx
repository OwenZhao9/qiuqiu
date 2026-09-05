/**
 * 人格设置页。重点是 **AD-11：「不设」传 `null`，不是传一组中等值**。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { setFetchImpl, type Persona } from '../src/api.js';
import { PersonaPage } from '../src/components/PersonaPage.js';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubApi(persona: Partial<Persona> = {}): Call[] {
  const calls: Call[] = [];
  const state: Persona = {
    preset: 'warm',
    sliders: { initiative: 60, verbosity: 45, emotion: 70, humor: 50 },
    learned: { nickname: '老张', reply_length: 'short', topics: ['旧书店'] },
    current: '快照',
    ...persona
  };
  setFetchImpl(async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    });
    const payload = url.endsWith('/persona') && method === 'GET' ? state : {};
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => payload,
      body: null
    } as unknown as Response;
  });
  return calls;
}

describe('PersonaPage', () => {
  it('四个预设卡片都在，当前的那张按下', async () => {
    stubApi();
    render(<PersonaPage />);
    await screen.findByText('温和');
    for (const name of ['温和', '安静', '软萌', '毒舌']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.getByText('温和').closest('button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('AD-11：勾上「不设」时 PUT /persona/preset 传的是 null', async () => {
    const calls = stubApi();
    render(<PersonaPage />);
    await screen.findByText('温和');

    fireEvent.click(screen.getByLabelText('不设'));
    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith('/persona/preset') && c.method === 'PUT');
      expect(put).toBeTruthy();
      expect(put?.body).toEqual({ preset: null });
    });
  });

  it('「不设」期间滑块禁用，界面说清它是真空不是中等值', async () => {
    stubApi({ preset: null });
    render(<PersonaPage />);
    await screen.findByText('温和');
    expect((screen.getByLabelText('主动') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/「不设」是真空/)).toBeTruthy();
  });

  it('四个滑块都在，拖动后 PUT /persona/sliders', async () => {
    const calls = stubApi();
    render(<PersonaPage />);
    await screen.findByText('温和');
    for (const label of ['主动', '话多', '情绪', '幽默']) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    fireEvent.change(screen.getByLabelText('幽默'), { target: { value: '88' } });
    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith('/persona/sliders'));
      expect(put?.body).toMatchObject({ humor: 88 });
    });
  });

  it('「重置相处性格」调 POST /persona/reset-learned', async () => {
    const calls = stubApi();
    render(<PersonaPage />);
    await screen.findByText('温和');
    fireEvent.click(screen.getByText('重置相处性格'));
    await waitFor(() => {
      expect(
        calls.some((c) => c.url.endsWith('/persona/reset-learned') && c.method === 'POST')
      ).toBe(true);
    });
  });

  it('读不到人格时给带 hint 的错误和重试按钮', async () => {
    setFetchImpl(async () => {
      throw new Error('ECONNREFUSED');
    });
    render(<PersonaPage />);
    expect(await screen.findByText('重试')).toBeTruthy();
    expect(screen.getByText(/确认后端已经起来/)).toBeTruthy();
  });

  it('相处性格里的字段照原样列出来', async () => {
    stubApi();
    render(<PersonaPage />);
    expect(await screen.findByText('称呼：老张')).toBeTruthy();
    expect(screen.getByText('话题：旧书店')).toBeTruthy();
  });
});

describe('PersonaPage · 不越界', () => {
  it('页面上不出现任何 key 字样，密钥不落前端', async () => {
    stubApi();
    const { container } = render(<PersonaPage />);
    await screen.findByText('温和');
    expect(container.textContent?.toLowerCase()).not.toContain('api_key');
    expect(vi.isMockFunction(vi.fn())).toBe(true);
  });
});
