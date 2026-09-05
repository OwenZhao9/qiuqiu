/**
 * 记忆库页。按稳定度三层分组显示（契约 § 1：L0 身份 / L1 偏好 / L2 近况）。
 *
 * 删除走 `DELETE /memories/{id}`，后端落到 `edit_visible(mid, deleted=True)`——
 * **AD-9：不删行**，只置 `enabled` 为否并级联作废对应事实。界面要把这点说出来。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  deleteMemory,
  getMemories,
  patchMemory,
  type MemoryLayer,
  type VisibleMemory
} from '../api.js';
import { LAYER_CN, formatDay } from '../format.js';

const LAYERS: MemoryLayer[] = ['L0', 'L1', 'L2'];

export function MemoryLibrary(): React.JSX.Element {
  const [items, setItems] = useState<VisibleMemory[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(() => {
    getMemories()
      .then((list) => {
        setItems(list);
        setError(null);
      })
      .catch((err: unknown) =>
        setError(
          err instanceof ApiError
            ? err
            : new ApiError('memories_failed', String(err), '确认后端已经起来，再刷新这一页')
        )
      );
  }, []);

  useEffect(load, [load]);

  const save = useCallback(
    (m: VisibleMemory, patch: Partial<VisibleMemory>) => {
      setItems((list) => list?.map((x) => (x.id === m.id ? { ...x, ...patch } : x)) ?? list);
      patchMemory(m.id, patch).catch((err: unknown) => {
        load();
        setError(
          err instanceof ApiError ? err : new ApiError('patch_failed', String(err), '再改一次')
        );
      });
    },
    [load]
  );

  if (error && !items) {
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

  if (!items) return <div className="qq-page qq-muted">读取记忆库…</div>;

  return (
    <div className="qq-page">
      <h1 className="qq-page__title">记忆库</h1>
      <p className="qq-note">
        三层是稳定度，不是重要度也不是时间。删掉一条只会让它失效，历史不会被抹掉。
      </p>

      {LAYERS.map((layer) => {
        const group = items.filter((m) => m.layer === layer);
        return (
          <section key={layer}>
            <h2 className="qq-section__title">
              {layer} · {LAYER_CN[layer].title}
              <span className="qq-note"> {LAYER_CN[layer].hint}</span>
            </h2>
            {group.length === 0 ? (
              <p className="qq-note">这一层还是空的</p>
            ) : (
              <div className="qq-memories">
                {group.map((m) => (
                  <div
                    className={'qq-memory' + (m.enabled ? '' : ' qq-memory--disabled')}
                    key={m.id}
                    data-memory-id={m.id}
                  >
                    <input
                      type="checkbox"
                      className="qq-focusable"
                      aria-label={'启用 ' + m.content}
                      checked={m.enabled}
                      onChange={(e) => save(m, { enabled: e.target.checked })}
                    />
                    <div className="qq-memory__content">
                      {editing === m.id ? (
                        <textarea
                          className="qq-composer__input qq-focusable"
                          aria-label="编辑记忆"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onBlur={() => {
                            if (draft.trim() && draft !== m.content)
                              save(m, { content: draft.trim() });
                            setEditing(null);
                          }}
                        />
                      ) : (
                        <div>{m.content}</div>
                      )}
                      <div className="qq-memory__meta">
                        {m.source === 'auto' ? '自动记的' : '手动加的'} · 更新于{' '}
                        {formatDay(m.updated_at)} · {m.fact_ids.length} 条事实
                      </div>
                    </div>
                    <button
                      type="button"
                      className="qq-btn qq-btn--ghost qq-focusable"
                      onClick={() => {
                        setEditing(m.id);
                        setDraft(m.content);
                      }}
                    >
                      改
                    </button>
                    <button
                      type="button"
                      className="qq-btn qq-btn--ghost qq-focusable"
                      onClick={() => {
                        deleteMemory(m.id)
                          .then(load)
                          .catch((err: unknown) =>
                            setError(
                              err instanceof ApiError
                                ? err
                                : new ApiError('delete_failed', String(err), '再点一次')
                            )
                          );
                      }}
                    >
                      删
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}

      {error ? (
        <div className="qq-error">
          {error.message}
          <span className="qq-error__hint">{error.hint}</span>
        </div>
      ) : null}
    </div>
  );
}
