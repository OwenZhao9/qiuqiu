/**
 * 音色选择。契约 v0.1.10 § 1：`GET /voices` 列可选项，`GET/PUT /config/voice` 读写。
 *
 * 只有女声，后端就只给女声，这里不做过滤。
 *
 * 选中即存，不设「保存」按钮——就一个字段，多一次点击没有意义。乐观更新：先亮起来
 * 再发请求，失败了退回原值并把 `hint` 显示出来。
 *
 * `realtime_supported` 为假的音色，端到端链路会回退默认音色。这一点必须在界面上说，
 * 否则用户选了「高冷御姐」却听见 Vivi，会以为是坏了。
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
          setChosen(previous); // 失败退回原值，别让界面骗人
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

  return (
    <div>
      <div className="qq-voices" role="radiogroup" aria-label="音色">
        {(options ?? []).map((voice) => {
          const active = voice.id === chosen;
          return (
            <button
              type="button"
              key={voice.id}
              role="radio"
              aria-checked={active}
              disabled={saving !== null}
              className={'qq-voice' + (active ? ' qq-voice--on' : '')}
              onClick={() => choose(voice.id)}
            >
              <span className="qq-voice__label">{voice.label}</span>
              <span className="qq-voice__blurb">{voice.blurb}</span>
              {voice.realtime_supported ? null : (
                <span className="qq-voice__note" title="实时语音只有四个精品音色">
                  实时语音下用默认音色
                </span>
              )}
            </button>
          );
        })}
      </div>
      {error ? (
        <div className="qq-error">
          {error.message}
          <span className="qq-error__hint">{error.hint}</span>
        </div>
      ) : null}
    </div>
  );
}
