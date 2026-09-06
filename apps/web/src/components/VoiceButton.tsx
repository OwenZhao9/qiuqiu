/**
 * 实时语音按钮。按一下开说，再按一下挂断。
 *
 * 端到端链路是**全双工**的：说话的同时模型也在说，服务端自己判断你什么时候说完。
 * 所以这里不做「按住不放」——那是级联链路的交互（客户端告诉服务端音频结束）。
 * 端到端下按住不放会挡掉随时插话。
 *
 * 状态只有三种：没连、连着、出错。连着的时候显示对方正在说什么。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { startVoice, type VoicePhase, type VoiceSession } from '../voice.js';
import { useChord } from '../useChord.js';
import { getBridge } from '../bridge.js';

export interface VoiceButtonProps {
  /** 定稿的一句话，交给上层塞进对话记录。 */
  onFinal?(role: 'user' | 'assistant', text: string): void;
  /** 播放音量，驱动丘丘的发声脉动。 */
  onLevel?(rms: number): void;
  /** 连上 / 断开，上层据此切状态机。 */
  onActiveChange?(active: boolean): void;
  /** 通话中在听 / 在想 / 在说。上层据此换表情——一通电话不能只有一个表情。 */
  onPhase?(phase: VoicePhase): void;
}

/** 听筒。挂断状态转 135 度——各家电话应用都是这么画的，不用另学。 */
function PhoneIcon({ hangUp }: { hangUp: boolean }): React.JSX.Element {
  return (
    // 线稿，跟隔壁那颗图片按钮同一套画法（`.qq-icon`）。原来这只听筒是实心色块，
    // 界面里实心只留给主按钮，一颗次要图标做成色块会比「发送」还抢眼
    <svg
      className={'qq-icon qq-call__icon' + (hangUp ? ' qq-call__icon--hangup' : '')}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7.4 10.5c1.5 2.9 3.9 5.3 6.7 6.8l2.1-2.1a1 1 0 0 1 1-.25c1.05.35 2.2.54 3.35.54a1 1 0 0 1 1 1v3.35a1 1 0 0 1-1 1C11.3 20.84 3.5 13.04 3.5 3.5a1 1 0 0 1 1-1h3.35a1 1 0 0 1 1 1c0 1.16.19 2.3.54 3.35a1 1 0 0 1-.25 1L7.4 10.5z" />
    </svg>
  );
}

/** 拨号和弦：同时按住 C 与 A。 */
const CALL_CHORD = ['KeyC', 'KeyA'] as const;

export function VoiceButton({
  onFinal,
  onLevel,
  onActiveChange,
  onPhase
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
        onPhase,
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
  }, [onFinal, onLevel, onActiveChange, onPhase]);

  const toggle = useCallback(() => {
    if (active) stop();
    else void start();
  }, [active, start, stop]);

  // 同时按住 C 和 A 拨出 / 挂断。用 code 不用 key，切输入法与大写锁定都不影响；
  // 焦点在输入框里时不触发——拼音打「擦」「猜」都会让这两个键短暂同按
  useChord(CALL_CHORD, toggle, { disabled: startingRef.current });

  // 桌宠上按的和弦经主进程转到这里。会话只跑在主窗口，两个窗口各开一个会抢麦克风。
  // 订阅只挂一次、卸载时退订：`Composer` 会随页面切换反复重挂，
  // 每挂一份不退的话桌宠按一次和弦要 toggle 好多次，等于按了个寂寞
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => getBridge().onCallFromPet(() => toggleRef.current()), []);

  return (
    <>
      <button
        type="button"
        className={'qq-icon-btn qq-call qq-focusable' + (active ? ' qq-call--on' : '')}
        aria-pressed={active}
        aria-label={active ? '挂断' : '打给丘丘'}
        title={active ? '挂断（C+A）' : '打给丘丘，同时按住 C 和 A 也行。说话就行，随时可以打断'}
        onClick={() => (active ? stop() : void start())}
      >
        <PhoneIcon hangUp={active} />
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
