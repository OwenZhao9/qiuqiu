/**
 * 人格设置页。重点是 **AD-11：「不设」传 `null`，不是传一组中等值**。
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { setFetchImpl, type Persona } from '../src/api.js';
import { PersonaPage, PRESET_DESCRIPTIONS } from '../src/components/PersonaPage.js';

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
    await screen.findByText('热情');
    for (const name of ['热情', '安静', '可爱', '毒舌']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.getByText('热情').closest('button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('AD-11：勾上「不设」时 PUT /persona/preset 传的是 null', async () => {
    const calls = stubApi();
    render(<PersonaPage />);
    await screen.findByText('热情');

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
    await screen.findByText('热情');
    expect((screen.getByLabelText('主动') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/「不设」是真空/)).toBeTruthy();
  });

  it('四个滑块都在，拖动后 PUT /persona/sliders', async () => {
    const calls = stubApi();
    render(<PersonaPage />);
    await screen.findByText('热情');
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
    await screen.findByText('热情');
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
    await screen.findByText('热情');
    expect(container.textContent?.toLowerCase()).not.toContain('api_key');
    expect(vi.isMockFunction(vi.fn())).toBe(true);
  });
});

describe('预设卡片与后端的滑块值', () => {
  /**
   * 卡片上写的和预设实际的表现必须是一回事。
   *
   * 踩过一次：`warm` 的滑块是主动 80、话量 70，卡片却写着「话不多，接得住情绪，
   * **不追问**」——两个维度都说反了。用户按字面选，选到的是相反的性格。
   *
   * 滑块值来自 `packages/memory/qiuqiu_memory/persona.py::PRESETS`（契约 § 7）。
   * 这里按「高/低」两端断言措辞方向，措辞怎么写不管，方向不能反。
   */
  const SLIDERS: Record<string, { initiative: number; verbosity: number; humor: number }> = {
    warm: { initiative: 80, verbosity: 70, humor: 55 },
    quiet: { initiative: 20, verbosity: 25, humor: 20 },
    cute: { initiative: 65, verbosity: 55, humor: 75 },
    sassy: { initiative: 70, verbosity: 40, humor: 90 }
  };

  /** 说明里表示「不主动」的说法。主动性高的预设不该出现这些。 */
  const PASSIVE_WORDS = ['不追问', '不主动', '等你开口', '被问到时'];
  /** 表示「话少」的说法。话量高的预设不该出现这些。 */
  const TERSE_WORDS = ['话不多', '回复短', '一句带过'];

  it('主动性高的预设，说明里不能写「不追问」这类词', () => {
    for (const [id, sliders] of Object.entries(SLIDERS)) {
      if (sliders.initiative < 67) continue;
      const desc = PRESET_DESCRIPTIONS[id]!;
      for (const w of PASSIVE_WORDS) {
        expect(desc.includes(w), `${id} 主动性 ${sliders.initiative}，说明却写了「${w}」`).toBe(
          false
        );
      }
    }
  });

  it('话量高的预设，说明里不能写「话不多」这类词', () => {
    for (const [id, sliders] of Object.entries(SLIDERS)) {
      if (sliders.verbosity < 67) continue;
      const desc = PRESET_DESCRIPTIONS[id]!;
      for (const w of TERSE_WORDS) {
        expect(desc.includes(w), `${id} 话量 ${sliders.verbosity}，说明却写了「${w}」`).toBe(false);
      }
    }
  });

  it('四个 id 与契约一致', () => {
    expect(Object.keys(PRESET_DESCRIPTIONS).sort()).toEqual(['cute', 'quiet', 'sassy', 'warm']);
  });
});
