/**
 * 输入条。桌宠的内联输入条与主窗口底部的输入区**行为完全一致**，只有尺寸不同
 * （`design/interaction.md` § 2）。差异只有一条：提交的落点由 `onSubmit` 决定。
 *
 * 头号 bug 来源：**输入法组字期间 `Enter` 绝不发送**——同时看
 * `compositionstart/end` 维护的标志与 `event.isComposing`，两个都要。
 */

import { useCallback, useRef, useState } from 'react';
import { ApiError, postBlob, type Attachment } from '../api.js';

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
}

interface Pending {
  key: string;
  name: string;
  url: string;
  blobId: string | null;
  error: string | null;
}

/** 语音输入推迟到 M5：按钮画出来，点了提示。 */
const VOICE_HINT = '按住说话 M5 接入，先用文字';

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
  onTextChange
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

      <div className="qq-composer__row">
        <textarea aria-label="说点什么" rows={2} {...inputProps} />
        <button
          type="button"
          className="qq-btn qq-focusable"
          title={VOICE_HINT}
          onClick={() => note(VOICE_HINT)}
        >
          按住说话
        </button>
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
  );
}
