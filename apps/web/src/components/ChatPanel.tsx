/**
 * 对话面板：流式渲染 + 回复下方的「参考了 N 条记忆」。
 *
 * 记忆条目的文本只来自 `recall` 事件的 `hits[].text`（**AD-14**，事件是唯一数据源），
 * 条目 id 来自 `/chat` 的 `meta.recall_ids`。两边对不上时只显示 id。
 */

import { useState } from 'react';
import { blobUrl } from '../api.js';
import type { ChatMessage } from '../store/chat.js';
import { shortId } from '../format.js';

export interface ChatPanelProps {
  messages: readonly ChatMessage[];
  /** `fact_id` → 文本，来自侧栏收到的 `recall` 事件。 */
  recallTexts: ReadonlyMap<string, string>;
}

function RecallNote({
  ids,
  texts
}: {
  ids: readonly string[];
  texts: ReadonlyMap<string, string>;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (ids.length === 0) return null;
  return (
    <div className="qq-recall">
      <button
        type="button"
        className="qq-recall__toggle qq-focusable"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        参考了 {ids.length} 条记忆
      </button>
      {open ? (
        <ul className="qq-recall__list">
          {ids.map((id) => (
            <li key={id}>{texts.get(id) ?? shortId(id)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ChatPanel({ messages, recallTexts }: ChatPanelProps): React.JSX.Element {
  if (messages.length === 0) {
    return (
      <div className="qq-thread">
        <div className="qq-empty">
          <div className="qq-empty__title">还没聊过</div>
          <div className="qq-empty__hint">说点什么，丘丘会一边听一边记</div>
        </div>
      </div>
    );
  }

  return (
    <div className="qq-thread" data-testid="thread">
      {messages.map((m) => (
        // 外面这层是「一行」，占满阅读栏并决定左右；气泡在里面，按内容自己收窄。
        // 少了这层的话，`.qq-thread > *` 的 width: 100% 会直接落在气泡上，
        // 一句「Hello.」也被撑成一整条
        <div key={m.id} className={'qq-msg-row qq-msg-row--' + m.role}>
          <div
            className={'qq-msg qq-msg--' + m.role}
            data-testid={'msg-' + m.role}
            data-streaming={m.streaming ? 'true' : undefined}
          >
            {m.content}
            {m.streaming && m.content === '' ? <span className="qq-muted">丘丘在想…</span> : null}
            {m.streaming && m.content !== '' ? (
              <span className="qq-msg__caret" aria-hidden="true" />
            ) : null}
            {m.attachments.length > 0 ? (
              // 发出去的图要看得见。`blob_id` 是内容寻址的，同一份字节永远同一个
              // 地址，重开窗口也还在——`createObjectURL` 那种临时地址活不过刷新
              <div className="qq-msg__shots">
                {m.attachments.map((a) => (
                  <img
                    key={a.blob_id}
                    className="qq-msg__shot"
                    src={blobUrl(a.blob_id)}
                    alt="发出去的图"
                    loading="lazy"
                  />
                ))}
              </div>
            ) : null}
            {m.error ? (
              <div className="qq-error">
                {m.error.message}
                <span className="qq-error__hint">{m.error.hint}</span>
              </div>
            ) : null}
            {m.role === 'assistant' ? <RecallNote ids={m.recallIds} texts={recallTexts} /> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
