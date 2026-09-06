/**
 * 设置页：场景控制台 + 音色 + 供应商清单。
 *
 * 供应商只看 `has_key` 的真假，**密钥永远不落前端**（`docs/CONVENTIONS.md`）。
 * 场景列表走 `GET /scenarios`（契约 v0.1.8 § 1 收编）；请求不通时退回写死的四个，
 * 让界面上还看得见有哪些演示。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  FALLBACK_SCENARIOS,
  getProviders,
  getScenarios,
  playScenario,
  type ProviderInfo,
  type ScenarioInfo
} from '../api.js';
import { VoicePicker } from './VoicePicker.js';
import { applySkin, readSkin, SKINS, type Skin } from '../skin.js';

const CAPABILITY_CN: Record<string, string> = {
  chat: '对话',
  vision: '看图',
  asr: '听写',
  vad: '有没有人说话',
  tts: '朗读',
  realtime: '实时语音'
};

export interface SettingsPageProps {}

export function SettingsPage({}: SettingsPageProps): React.JSX.Element {
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [scenarios, setScenarios] = useState<readonly ScenarioInfo[]>(FALLBACK_SCENARIOS);
  const [skin, setSkin] = useState<Skin>(readSkin);

  const load = useCallback(() => {
    getProviders()
      .then((list) => {
        setProviders(list);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(
          err instanceof ApiError
            ? err
            : new ApiError('providers_failed', String(err), '确认后端已经起来，再刷新这一页')
        )
      );
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    getScenarios()
      .then((list) => {
        if (list.length > 0) setScenarios(list);
      })
      .catch(() => {
        /* 列不出来就用兜底的四个，不打断这一页的其余部分 */
      });
  }, []);

  return (
    <div className="qq-page">
      <h1 className="qq-page__title">设置</h1>

      <section>
        <h2 className="qq-section__title">场景控制台</h2>
        <p className="qq-note">一键回放演示场景，事件会实时落进右边的记忆过程侧栏。</p>
        <div className="qq-scenarios">
          {scenarios.map((s) => (
            <div className="qq-scenario" key={s.name}>
              <div style={{ flex: 1 }}>
                <div>{s.title}</div>
                <div className="qq-note qq-mono">{s.name}</div>
              </div>
              <button
                type="button"
                className="qq-btn qq-focusable"
                disabled={busy === s.name}
                onClick={() => {
                  setBusy(s.name);
                  playScenario(s.name)
                    .then(() => setNote(`已开始回放「${s.title}」`))
                    .catch((err: unknown) =>
                      setError(
                        err instanceof ApiError
                          ? err
                          : new ApiError(
                              'scenario_failed',
                              String(err),
                              '确认后端实现了场景回放路由'
                            )
                      )
                    )
                    .finally(() => setBusy(null));
                }}
              >
                {busy === s.name ? '回放中…' : '回放'}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="qq-section__title">外观</h2>
        <p className="qq-note">换页面的颜色与圆角，功能完全一样。二次元连丘丘本人一起换。</p>
        <div className="qq-voices" role="radiogroup" aria-label="外观">
          {SKINS.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={skin === s.id}
              className={'qq-voice' + (skin === s.id ? ' qq-voice--on' : '')}
              onClick={() => {
                setSkin(s.id);
                applySkin(s.id);
              }}
            >
              <span className="qq-voice__label">{s.label}</span>
              <span className="qq-voice__blurb">{s.blurb}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="qq-section__title">音色</h2>
        <p className="qq-note">丘丘的声音。选中即生效，文字对话的朗读和实时通话共用这一个选择。</p>
        <VoicePicker />
      </section>

      <section>
        <h2 className="qq-section__title">模型供应商</h2>
        <p className="qq-note">这里只看得到「有没有配 key」，看不到 key 本身。</p>
        {providers === null ? (
          <p className="qq-muted">读取中…</p>
        ) : (
          <div>
            {providers.map((p) => (
              <div className="qq-provider" key={p.capability + '_' + p.provider}>
                <span style={{ minWidth: '7em' }}>
                  {CAPABILITY_CN[p.capability] ?? p.capability}
                </span>
                <span className="qq-mono">{p.provider}</span>
                <span className="qq-muted">{p.model ?? '—'}</span>
                <span className="qq-spacer" />
                <span className="qq-pill qq-pill--tag">{p.local ? '本地' : '出网'}</span>
                <span className="qq-pill qq-pill--tag">{p.has_key ? '已配 key' : '没有 key'}</span>
                <span className={'qq-dot ' + (p.available ? 'qq-dot--open' : 'qq-dot--closed')} />
                {p.available ? null : <span className="qq-note">{p.hint ?? '暂时不可用'}</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      {note ? <div className="qq-note">{note}</div> : null}
      {error ? (
        <div className="qq-error">
          {error.message}
          <span className="qq-error__hint">{error.hint}</span>
        </div>
      ) : null}
    </div>
  );
}
