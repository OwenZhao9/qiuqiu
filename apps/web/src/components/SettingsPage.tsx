/**
 * 设置页：外观 + 音色 + 供应商清单。
 *
 * 供应商只看 `has_key` 的真假，**密钥永远不落前端**（`docs/CONVENTIONS.md`）。
 *
 * **场景控制台去掉了。** 那四个「一键回放」把脚本里写好的台词当成用户真说过的话
 * 灌进记忆库——点一下「过了三个月」，深圳、南山那一套就进了真实记忆，
 * 而人从没说过。演示归演示，不该和真话共用一个库。
 * 后端的 `GET /scenarios` / `POST /scenario/{name}/play` 还在（契约 § 1 里有），
 * 只是界面上不再有入口。
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, getProviders, type ProviderInfo } from '../api.js';
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

  return (
    <div className="qq-page">
      <h1 className="qq-page__title">设置</h1>

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

      {error ? (
        <div className="qq-error">
          {error.message}
          <span className="qq-error__hint">{error.hint}</span>
        </div>
      ) : null}
    </div>
  );
}
