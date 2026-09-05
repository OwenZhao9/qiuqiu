/**
 * 音色选择。契约 v0.1.10 § 1：`GET /voices` 列可选项，`GET/PUT /config/voice` 读写。
 *
 * 只有女声，后端就只给女声，这里不做过滤。
 *
 * 选中即存，不设「保存」按钮：只有一个字段。乐观更新：先亮起来
 * 再发请求，失败了退回原值并把 `hint` 显示出来。
 *
 * 端到端实时语音只支持豆包的四个精品音色，女声两个（Vivi、小何）。其余音色
 * `realtime_supported` 为假，通话时回退成 Vivi。列表按这一点分成两组，
 * 避免选了「高冷御姐」通话里却是 Vivi。
 */

import { useCallback, useEffect, useState } from 'react';
import { ApiError, getVoice, getVoices, putVoice, type VoiceOption } from '../api.js';

export function VoicePicker(): React.JSX.Element {
  const [options, setOptions] = useState<VoiceOption[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    Promise.all([getVoices(), getVoice()])
      .then(([list, current]) => {
        setOptions(list);
        setChosen(current.voice);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(
          err instanceof ApiError
            ? err
            : new ApiError('voices_failed', String(err), '确认后端已经起来，再刷新这一页')
        )
      );
  }, []);

  const choose = useCallback(
    (id: string) => {
      if (id === chosen || saving !== null) return;
      const previous = chosen;
      setChosen(id); // 乐观更新：先亮起来
      setSaving(id);
      setError(null);
      putVoice(id)
        .then((body) => setChosen(body.voice))
        .catch((err: unknown) => {
          setChosen(previous); // 失败退回原值，界面与后端保持一致
          setError(
            err instanceof ApiError
              ? err
              : new ApiError('voice_save_failed', String(err), '再点一次；持续失败就看后端日志')
          );
        })
        .finally(() => setSaving(null));
    },
    [chosen, saving]
  );

  if (options === null && error === null) {
    return <p className="qq-muted">读取中…</p>;
  }

  const all = options ?? [];
  const groups: Array<{ key: string; title: string; note: string; list: VoiceOption[] }> = [
    {
      key: 'both',
      title: '通话与朗读通用',
      note: '端到端实时语音支持的音色，通话里听到的就是它。',
      list: all.filter((v) => v.realtime_supported)
    },
    {
      key: 'tts',
      title: '仅朗读',
      note: '端到端实时语音不支持这些音色，通话时会回退成默认音色（Vivi）。',
      list: all.filter((v) => !v.realtime_supported)
    }
  ].filter((g) => g.list.length > 0);

  return (
    <div>
      {groups.map((group) => (
        <section key={group.key}>
          <h3 className="qq-voices__group">{group.title}</h3>
          <p className="qq-note">{group.note}</p>
          <div className="qq-voices" role="radiogroup" aria-label={'音色 · ' + group.title}>
            {group.list.map((voice) => {
              const active = voice.id === chosen;
              return (
                <button
                  type="button"
                  key={voice.id}
                  role="radio"
                  aria-checked={active}
                  disabled={saving !== null}
                  className={
                    'qq-voice' +
                    (active ? ' qq-voice--on' : '') +
                    (voice.realtime_supported ? '' : ' qq-voice--tts')
                  }
                  onClick={() => choose(voice.id)}
                >
                  <span className="qq-voice__label">{voice.label}</span>
                  <span className="qq-voice__blurb">{voice.blurb}</span>
                  {voice.realtime_supported ? null : (
                    <span className="qq-voice__note">通话时回退成默认音色</span>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ))}
      {error ? (
        <div className="qq-error">
          {error.message}
          <span className="qq-error__hint">{error.hint}</span>
        </div>
      ) : null}
    </div>
  );
}
