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

/** 听筒。挂断状态转 135 度——各家电话应用都是这么画的，不用另学。 */
function PhoneIcon({ hangUp }: { hangUp: boolean }): React.JSX.Element {
  return (
    <svg
      className={'qq-call__icon' + (hangUp ? ' qq-call__icon--hangup' : '')}
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="currentColor"
        d="M6.6 10.8c1.6 3.1 4.1 5.6 7.2 7.2l2.4-2.4c.3-.3.7-.4 1.1-.3 1.2.4 2.4.6 3.7.6.6 0 1 .4 1 1V21c0 .6-.4 1-1 1C10.7 22 2 13.3 2 2.5c0-.6.4-1 1-1h4.1c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.7.1.4 0 .8-.3 1.1L6.6 10.8z"
      />
    </svg>
  );
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
        className={'qq-call qq-focusable' + (active ? ' qq-call--on' : '')}
        aria-pressed={active}
        aria-label={active ? '挂断' : '打给丘丘'}
        title={active ? '挂断' : '打给丘丘，说话就行，随时可以打断'}
        onClick={() => (active ? stop() : void start())}
      >
        <PhoneIcon hangUp={active} />
        <span className="qq-call__text">{active ? '挂断' : '通话'}</span>
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
