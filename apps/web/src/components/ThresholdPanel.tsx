/**
 * 阈值面板，按 `design/memory-panel.md` § 5。
 *
 * 拖动过程中**不发请求**，只做本地预演（重新着色 + 数差异 + 色带同步）；
 * 松手后 debounce 300 ms 才 `PUT /config/thresholds`。失败回弹到请求前的值。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, putThresholds, type MemoryEventEnvelope, type Thresholds } from '../api.js';
import {
  clampThresholds,
  compactLabel,
  previewDiff,
  STEP,
  trackGradient
} from '../store/thresholds.js';

export const COMMIT_DEBOUNCE_MS = 300;

export interface ThresholdPanelProps {
  expanded: boolean;
  value: Thresholds;
  /** 提交成功后把新值写回上层。 */
  onCommitted(next: Thresholds): void;
  /** 预演值变化时通知侧栏重新着色；`null` 表示回到已保存的值。 */
  onPreview(next: Thresholds | null): void;
  events: readonly MemoryEventEnvelope[];
}

export function ThresholdPanel({
  expanded,
  value,
  onCommitted,
  onPreview,
  events
}: ThresholdPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState<Thresholds>(value);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committed = useRef<Thresholds>(value);

  useEffect(() => {
    committed.current = value;
    setDraft(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const diff = useMemo(() => previewDiff(events, draft), [events, draft]);

  const commit = useCallback(
    (next: Thresholds) => {
      const before = committed.current;
      putThresholds(next)
        .then((saved) => {
          committed.current = saved ?? next;
          onCommitted(saved ?? next);
          onPreview(null);
          setError(null);
          setNote('已生效，只影响之后的采集');
          setTimeout(() => setNote(null), 3000);
        })
        .catch((err: unknown) => {
          // 失败：滑块回弹到请求前的值，卡片颜色一并还原
          setDraft(before);
          onPreview(null);
          setNote(null);
          setError(
            err instanceof ApiError
              ? err
              : new ApiError('threshold_failed', String(err), '检查后端是否还活着，再拖一次')
          );
        });
    },
    [onCommitted, onPreview]
  );

  const change = useCallback(
    (which: 'accept' | 'uncertain', raw: number) => {
      const next = clampThresholds({ ...draft, [which]: raw }, which);
      setDraft(next);
      onPreview(next);
      setNote(null);
      setError(null);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => commit(next), COMMIT_DEBOUNCE_MS);
    },
    [draft, onPreview, commit]
  );

  return (
    <div
      className={
        'qq-thresholds ' + (expanded ? 'qq-thresholds--expanded' : 'qq-thresholds--collapsed')
      }
      aria-hidden={!expanded}
    >
      <div className="qq-thresholds__inner">
        <div className="qq-track" style={{ background: trackGradient(draft) }} aria-hidden="true" />

        <label className="qq-slider-row">
          <span className="qq-slider-row__name">保留线</span>
          <input
            type="range"
            className="qq-focusable"
            min={0}
            max={1}
            step={STEP}
            value={draft.accept}
            aria-label="保留线"
            onChange={(e) => change('accept', Number(e.target.value))}
          />
          <span className="qq-slider-row__value">{draft.accept.toFixed(2)}</span>
        </label>

        <label className="qq-slider-row">
          <span className="qq-slider-row__name">丢弃线</span>
          <input
            type="range"
            className="qq-focusable"
            min={0}
            max={1}
            step={STEP}
            value={draft.uncertain}
            aria-label="丢弃线"
            onChange={(e) => change('uncertain', Number(e.target.value))}
          />
          <span className="qq-slider-row__value">{draft.uncertain.toFixed(2)}</span>
        </label>

        <div className="qq-note">{diff.text}</div>
        {note ? <div className="qq-note">{note}</div> : null}
        {error ? (
          <div className="qq-error">
            {error.message}
            <span className="qq-error__hint">{error.hint}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 折叠时「采集阈值」按钮上带的两个数。 */
export function ThresholdBadge({ value }: { value: Thresholds }): React.JSX.Element {
  return <span className="qq-mono qq-btn__meta">{compactLabel(value)}</span>;
}
