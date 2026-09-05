/**
 * 实时语音按钮。按一下开说，再按一下挂断。
 *
 * 端到端链路是**全双工**的：说话的同时模型也在说，服务端自己判断你什么时候说完。
 * 所以这里不做「按住不放」——那是级联链路的交互（客户端告诉服务端音频结束）。
 * 端到端下按住不放反而会让人不敢插话，把这条链路最值钱的「能打断」浪费掉。
 *
 * 状态只有三种：没连、连着、出错。连着的时候显示对方正在说什么。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { startVoice, type VoiceSession } from '../voice.js';

export interface VoiceButtonProps {
  /** 定稿的一句话，交给上层塞进对话记录。 */
  onFinal?(role: 'user' | 'assistant', text: string): void;
  /** 播放音量，驱动丘丘的发声脉动。 */
  onLevel?(rms: number): void;
  /** 连上 / 断开，上层据此切状态机。 */
  onActiveChange?(active: boolean): void;
}

export function VoiceButton({
  onFinal,
  onLevel,
  onActiveChange
}: VoiceButtonProps): React.JSX.Element {
  const [active, setActive] = useState(false);
  const [partial, setPartial] = useState('');
  const [error, setError] = useState<{ message: string; hint: string } | null>(null);
  const sessionRef = useRef<VoiceSession | null>(null);
  const startingRef = useRef(false);

  // 组件卸载时一定要挂断，不然麦克风一直亮着
  useEffect(() => {
    return () => {
      sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setActive(false);
    setPartial('');
    onActiveChange?.(false);
  }, [onActiveChange]);

  const start = useCallback(async () => {
    if (startingRef.current || sessionRef.current) return;
    startingRef.current = true;
    setError(null);
    try {
      const session = await startVoice({
        onPartial: setPartial,
        onFinal: (role, text) => {
          if (role === 'user') setPartial('');
          onFinal?.(role, text);
        },
        onLevel,
        onError: (_code, message, hint) => setError({ message, hint }),
        onClosed: () => {
          sessionRef.current = null;
          setActive(false);
          setPartial('');
          onActiveChange?.(false);
        }
      });
      sessionRef.current = session;
      setActive(true);
      onActiveChange?.(true);
    } finally {
      startingRef.current = false;
    }
  }, [onFinal, onLevel, onActiveChange]);

  return (
    <>
      <button
        type="button"
        className={'qq-btn qq-focusable' + (active ? ' qq-btn--voice-on' : '')}
        aria-pressed={active}
        title={active ? '挂断' : '开始实时语音对话'}
        onClick={() => (active ? stop() : void start())}
      >
        {active ? '挂断' : '说话'}
      </button>
      {active || partial || error ? (
        <div className="qq-voice-status" role="status">
          {error ? (
            <span className="qq-voice-status__error">
              {error.message}
              <span className="qq-voice-status__hint">{error.hint}</span>
            </span>
          ) : partial ? (
            <span className="qq-voice-status__partial">{partial}</span>
          ) : (
            <span className="qq-voice-status__on">在听着，随时可以打断</span>
          )}
        </div>
      ) : null}
    </>
  );
}
