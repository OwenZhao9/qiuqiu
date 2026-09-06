/**
 * 输入条。桌宠的内联输入条与主窗口底部的输入区**行为完全一致**，只有尺寸不同
 * （`design/interaction.md` § 2）。差异只有一条：提交的落点由 `onSubmit` 决定。
 *
 * 头号 bug 来源：**输入法组字期间 `Enter` 绝不发送**——同时看
 * `compositionstart/end` 维护的标志与 `event.isComposing`，两个都要。
 */

import { useCallback, useRef, useState } from 'react';
import { ApiError, postBlob, type Attachment } from '../api.js';
import { VoiceButton } from './VoiceButton.js';
import type { VoicePhase } from '../voice.js';

export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export interface ComposerProps {
  variant: 'main' | 'pet';
  /** 提交一句话。桌宠传 `submitFromPet`，主窗口传 `chat.send`。 */
  onSubmit(text: string, attachments: Attachment[]): void;
  /** 已发过的话，`↑` 往前翻。最新在末尾。 */
  history: readonly string[];
  /** 正在流式输出：主窗口的 `Esc` 与「停止」按钮走它。 */
  streaming?: boolean;
  onStop?(): void;
  /** 桌宠按 `Esc` 收起输入条；文本保留，下次展开还在。 */
  onEscape?(): void;
  autoFocus?: boolean;
  placeholder?: string;
  /** 受控文本。桌宠收起输入条时文本要保留，所以由 `PetApp` 托管。 */
  text?: string;
  onTextChange?(next: string): void;
  /** 实时语音定稿的一句，交给上层塞进对话记录。 */
  onVoiceFinal?(role: 'user' | 'assistant', text: string): void;
  /** 实时语音的播放音量，驱动丘丘的发声脉动。 */
  onVoiceLevel?(rms: number): void;
  /** 语音会话连上 / 断开。 */
  onVoiceActive?(active: boolean): void;
  /** 通话中在听 / 在想 / 在说。 */
  onVoicePhase?(phase: VoicePhase): void;
}

interface Pending {
  key: string;
  name: string;
  url: string;
  blobId: string | null;
  error: string | null;
}

/** 输入区：文字、图片、通话按钮。 */
export function Composer({
  variant,
  onSubmit,
  history,
  streaming = false,
  onStop,
  onEscape,
  autoFocus,
  placeholder,
  text: controlled,
  onTextChange,
  onVoiceFinal,
  onVoiceLevel,
  onVoiceActive,
  onVoicePhase
}: ComposerProps): React.JSX.Element {
  const [own, setOwn] = useState('');
  const text = controlled ?? own;
  const setText = useCallback(
    (next: string) => {
      if (controlled === undefined) setOwn(next);
      onTextChange?.(next);
    },
    [controlled, onTextChange]
  );
  const [pending, setPending] = useState<Pending[]>([]);
  const [dropping, setDropping] = useState(false);
  const [notes, setNotes] = useState<string[]>([]);
  const composing = useRef(false);
  const historyIdx = useRef<number | null>(null);
  const isPet = variant === 'pet';

  const note = useCallback((msg: string) => {
    setNotes((n) => [...n, msg]);
    setTimeout(() => setNotes((n) => n.slice(1)), 4000);
  }, []);

  const submit = useCallback(() => {
    const content = text.trim();
    if (content === '') return; // 空则不发，不报错
    const attachments = pending
      .filter((p) => p.blobId)
      .map<Attachment>((p) => ({ type: 'image', blob_id: p.blobId as string }));
    onSubmit(content, attachments);
    setText('');
    setPending([]);
    historyIdx.current = null;
  }, [text, pending, onSubmit, setText]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      // 中文用户按下的每一次 Enter 有一半是在选词
      const inIme = composing.current || e.nativeEvent.isComposing;

      if (e.key === 'Enter' && !inIme) {
        if (e.shiftKey && !isPet) return; // 换行
        e.preventDefault();
        submit();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (isPet) {
          onEscape?.();
          return;
        }
        if (streaming) onStop?.();
        else setText('');
        return;
      }
      if (e.key === 'ArrowUp' && text === '' && history.length > 0) {
        e.preventDefault();
        const next =
          historyIdx.current === null ? history.length - 1 : Math.max(0, historyIdx.current - 1);
        historyIdx.current = next;
        setText(history[next]);
      }
    },
    [isPet, streaming, onStop, onEscape, submit, text, history, setText]
  );

  const fileRef = useRef<HTMLInputElement | null>(null);

  const upload = useCallback(
    async (files: readonly File[]) => {
      let slots = MAX_IMAGES - pending.length;
      for (const file of files) {
        if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
          note(`${file.name}：目前只支持图片（png / jpeg / webp / gif）`);
          continue;
        }
        if (file.size > MAX_IMAGE_BYTES) {
          note(`${file.name}：单张不能超过 10 MB，先压一下再拖进来`);
          continue;
        }
        if (slots <= 0) {
          note(`${file.name}：一条消息最多 ${MAX_IMAGES} 张，先发出去再加`);
          continue;
        }
        slots -= 1;
        const key = file.name + '_' + Date.now() + '_' + slots;
        const url = URL.createObjectURL(file);
        setPending((p) => [...p, { key, name: file.name, url, blobId: null, error: null }]);
        try {
          const { blob_id } = await postBlob(file, file.name);
          setPending((p) => p.map((x) => (x.key === key ? { ...x, blobId: blob_id } : x)));
        } catch (err) {
          const msg = err instanceof ApiError ? `${err.message}（${err.hint}）` : String(err);
          setPending((p) => p.map((x) => (x.key === key ? { ...x, error: msg } : x)));
        }
      }
    },
    [pending.length, note]
  );

  const inputProps = {
    value: text,
    placeholder:
      placeholder ?? (isPet ? '跟丘丘说点什么' : '说点什么，Enter 发送，Shift+Enter 换行'),
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) =>
      setText(e.target.value),
    onKeyDown,
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: () => {
      composing.current = false;
    },
    autoFocus,
    className: isPet ? 'qq-pet__input qq-focusable' : 'qq-composer__input qq-focusable'
  };

  if (isPet) {
    return (
      <input
        type="text"
        aria-label="跟丘丘说话"
        onPaste={(e) => {
          if (Array.from(e.clipboardData?.items ?? []).some((i) => i.type.startsWith('image/'))) {
            e.preventDefault();
            note('请在主窗口发送图片');
          }
        }}
        {...inputProps}
      />
    );
  }

  return (
    <div
      className="qq-composer"
      onDragEnter={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) setDropping(true);
      }}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDropping(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDropping(false);
        void upload(Array.from(e.dataTransfer.files));
      }}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData?.files ?? []).filter((f) =>
          f.type.startsWith('image/')
        );
        if (files.length > 0) {
          e.preventDefault();
          void upload(files);
        }
      }}
    >
      {dropping ? <div className="qq-dropzone">松开添加图片</div> : null}

      {pending.length > 0 ? (
        <div className="qq-attachments">
          {pending.map((p) => (
            <div className="qq-attachment" key={p.key} title={p.error ?? p.name}>
              <img src={p.url} alt={p.name} />
              <button
                type="button"
                className="qq-attachment__remove"
                aria-label={'移除 ' + p.name}
                onClick={() => setPending((list) => list.filter((x) => x.key !== p.key))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {notes.map((n, i) => (
        <div className="qq-note" key={i}>
          {n}
        </div>
      ))}

      {/* 一个框，字在上、工具在下——微信那个样子。
          原来是「输入框 + 右边并排三颗按钮」：输入框被挤窄，三颗按钮抢主次，
          通话状态那一行还得靠 flex-wrap 兜着，一开通话整排就乱 */}
      <div className="qq-composer__box">
        <textarea aria-label="说点什么" rows={2} {...inputProps} />
        <div className="qq-composer__bar">
          {/* 拖进来和粘贴一直都能发图，但界面上没有任何入口——不告诉你就等于没有 */}
          <button
            type="button"
            className="qq-icon-btn qq-focusable"
            aria-label="发图片"
            title={`发图片。也可以直接拖进来或粘贴，一条最多 ${MAX_IMAGES} 张`}
            onClick={() => fileRef.current?.click()}
          >
            {/* 画法（格子、粗细、端点）全在 `.qq-icon` 里，这里只给形状。
                外框跟着界面的圆角走，不是硬角；山脊收在框里留一道缝——
                贴着底边画的话，18px 下山脚和边框糊成一条粗线 */}
            <svg className="qq-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
              <circle cx="8" cy="9.6" r="1.2" />
              <path d="M5 16.2l3.5-3.3 2.6 2.3 2.3-2 3.6 3.3" />
            </svg>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            multiple
            hidden
            onChange={(e) => {
              void upload(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <VoiceButton
            onFinal={onVoiceFinal}
            onLevel={onVoiceLevel}
            onActiveChange={onVoiceActive}
            onPhase={onVoicePhase}
          />
          <span className="qq-spacer" />
          {streaming ? (
            <button type="button" className="qq-btn qq-focusable" onClick={() => onStop?.()}>
              停止
            </button>
          ) : (
            <button type="button" className="qq-btn qq-btn--primary qq-focusable" onClick={submit}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
