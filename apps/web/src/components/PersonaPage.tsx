/**
 * 人格设置页：四个预设卡片 + 四个滑块 + 「不设」开关 + 「重置相处性格」。
 *
 * **AD-11：「不设」是真空。** 开关打开时 `PUT /persona/preset` 传 **`null`**，
 * 不是传一组中等值——后端据此完全不生成 `preset_block`，prompt 里不出现任何滑块描述。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  getPersona,
  putPersonaPreset,
  putPersonaSliders,
  resetLearned,
  type Persona,
  type PresetId,
  type Sliders
} from '../api.js';

const PRESETS: Array<{ id: PresetId; name: string; desc: string }> = [
  { id: 'warm', name: '温和', desc: '话不多，接得住情绪，不追问' },
  { id: 'quiet', name: '安静', desc: '只在被问到时开口，回复短' },
  { id: 'cute', name: '软萌', desc: '语气轻，爱用短句和语气词' },
  { id: 'sassy', name: '毒舌', desc: '直接，偶尔戳一下，不绕弯' }
];

const SLIDERS: Array<{ key: keyof Sliders; label: string; low: string; high: string }> = [
  { key: 'initiative', label: '主动', low: '等你开口', high: '常常先说' },
  { key: 'verbosity', label: '话多', low: '一句带过', high: '展开讲' },
  { key: 'emotion', label: '情绪', low: '平静', high: '起伏明显' },
  { key: 'humor', label: '幽默', low: '正经', high: '爱开玩笑' }
];

export function PersonaPage(): React.JSX.Element {
  const [persona, setPersona] = useState<Persona | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    getPersona()
      .then((p) => {
        setPersona(p);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(
          err instanceof ApiError
            ? err
            : new ApiError('persona_failed', String(err), '确认后端已经起来，再刷新这一页')
        )
      );
  }, []);

  useEffect(load, [load]);

  const say = useCallback((msg: string) => {
    setNote(msg);
    setTimeout(() => setNote(null), 3000);
  }, []);

  const choosePreset = useCallback(
    (preset: PresetId | null) => {
      setPersona((p) => (p ? { ...p, preset } : p));
      putPersonaPreset(preset)
        .then(() => say(preset === null ? '已设成「不设」，滑块不再进 prompt' : '已切换'))
        .catch((err: unknown) => {
          load();
          setError(
            err instanceof ApiError ? err : new ApiError('preset_failed', String(err), '再试一次')
          );
        });
    },
    [load, say]
  );

  const changeSlider = useCallback((key: keyof Sliders, value: number) => {
    setPersona((p) => {
      if (!p) return p;
      const sliders = { ...p.sliders, [key]: value };
      void putPersonaSliders(sliders).catch((err: unknown) =>
        setError(
          err instanceof ApiError ? err : new ApiError('sliders_failed', String(err), '再拖一次')
        )
      );
      return { ...p, sliders };
    });
  }, []);

  if (error && !persona) {
    return (
      <div className="qq-page">
        <div className="qq-error">
          {error.message}
          <span className="qq-error__hint">{error.hint}</span>
        </div>
        <button type="button" className="qq-btn qq-focusable" onClick={load}>
          重试
        </button>
      </div>
    );
  }

  if (!persona) return <div className="qq-page qq-muted">读取人格设置…</div>;

  const vacuum = persona.preset === null;

  return (
    <div className="qq-page">
      <h1 className="qq-page__title">人格</h1>

      <section>
        <h2 className="qq-section__title">预设</h2>
        <div className="qq-presets">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="qq-preset-card qq-focusable"
              aria-pressed={persona.preset === p.id}
              disabled={vacuum}
              onClick={() => choosePreset(p.id)}
            >
              <span className="qq-preset-card__name">{p.name}</span>
              <span className="qq-preset-card__desc">{p.desc}</span>
            </button>
          ))}
        </div>

        <label className="qq-switch" style={{ marginTop: 'var(--qq-space-5)' }}>
          <input
            type="checkbox"
            className="qq-focusable"
            checked={vacuum}
            onChange={(e) => choosePreset(e.target.checked ? null : 'warm')}
          />
          <span>不设</span>
        </label>
        <p className="qq-note">
          「不设」是真空，不是一组中等值：prompt 里不会出现任何滑块描述，只留边界与相处性格。
        </p>
      </section>

      <section>
        <h2 className="qq-section__title">滑块</h2>
        {SLIDERS.map((s) => (
          <label className="qq-slider-row" key={s.key}>
            <span style={{ minWidth: '3em' }}>{s.label}</span>
            <span className="qq-muted">{s.low}</span>
            <input
              type="range"
              className="qq-focusable"
              min={0}
              max={100}
              step={1}
              aria-label={s.label}
              disabled={vacuum}
              value={persona.sliders[s.key]}
              onChange={(e) => changeSlider(s.key, Number(e.target.value))}
            />
            <span className="qq-muted">{s.high}</span>
            <span className="qq-slider-row__value">{persona.sliders[s.key]}</span>
          </label>
        ))}
        {vacuum ? <p className="qq-note">「不设」期间滑块不生效，所以先禁用了。</p> : null}
      </section>

      <section>
        <h2 className="qq-section__title">相处性格</h2>
        <p className="qq-note">丘丘从你们的原始对话里自己归纳的那部分，会覆盖预设里同名的维度。</p>
        <ul className="qq-note">
          {persona.learned.nickname ? <li>称呼：{persona.learned.nickname}</li> : null}
          {persona.learned.reply_length ? <li>回复长度：{persona.learned.reply_length}</li> : null}
          {typeof persona.learned.humor_tolerance === 'number' ? (
            <li>玩笑接受度：{persona.learned.humor_tolerance}</li>
          ) : null}
          {persona.learned.topics?.length ? (
            <li>话题：{persona.learned.topics.join('、')}</li>
          ) : null}
        </ul>
        <button
          type="button"
          className="qq-btn qq-focusable"
          onClick={() => {
            resetLearned()
              .then(() => {
                say('已重置，历史版本仍然留着');
                load();
              })
              .catch((err: unknown) =>
                setError(
                  err instanceof ApiError
                    ? err
                    : new ApiError('reset_failed', String(err), '再点一次')
                )
              );
          }}
        >
          重置相处性格
        </button>
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
