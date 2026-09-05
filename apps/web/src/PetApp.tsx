/**
 * 桌宠窗口。几何、手势、气泡、键盘全部按 `design/interaction.md` § 1。
 *
 * **AD-5：桌宠窗口不自己连 SSE，也不发任何 HTTP 请求。**
 * 回复流来自主窗口的 `forwardDelta` / `forwardDone`，状态来自 `setPetState`，
 * 自己发出去的话交 `submitFromPet`，由主窗口 `POST /chat`。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getBridge } from './bridge.js';
import { Composer } from './components/Composer.js';
import { useChord } from './useChord.js';
import { QiuqiuBall } from './components/QiuqiuBall.js';
import type { CharacterState, QiuqiuInstance } from '@qiuqiu/character';

/** 单击判定：`pointerup` 距 `pointerdown` ≤ 400 ms 且位移 ≤ 4 px。 */
export const CLICK_MS = 400;
export const DRAG_SLOP_PX = 4;
/** `done` 之后气泡停留 6 s 再淡出；鼠标悬停在气泡上则不淡出。 */
export const BUBBLE_LINGER_MS = 6000;

export function PetApp(): React.JSX.Element {
  // 桌宠上也能按 C+A 拨通话，但会话跑在主窗口（AD-5：桌宠不自己发请求）
  useChord(['KeyC', 'KeyA'], () => bridge.callFromPet());

  const bridge = getBridge();
  const qiuqiuRef = useRef<QiuqiuInstance | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [bubble, setBubble] = useState('');
  const [fading, setFading] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  /** 输入条收起时文本要保留，所以草稿托管在这里，不放 Composer 内部。 */
  const [draft, setDraft] = useState('');
  const hovering = useRef(false);
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- 主窗口转发过来的流 ---- */
  useEffect(() => {
    bridge.onDelta((_sessionId: string, text: string) => {
      if (linger.current) clearTimeout(linger.current);
      setFading(false);
      setBubble((b) => b + text);
    });
    bridge.onDone(() => {
      if (linger.current) clearTimeout(linger.current);
      linger.current = setTimeout(() => {
        if (hovering.current) return; // 悬停在气泡上就不淡出
        setFading(true);
        setTimeout(() => {
          setBubble('');
          setFading(false);
        }, 400);
      }, BUBBLE_LINGER_MS);
    });
    bridge.onPetState((state: string, emotionId?: string) => {
      const q = qiuqiuRef.current;
      if (!q) return;
      q.setState(state as CharacterState);
      if (emotionId) q.setEmotion(emotionId);
    });
    bridge.onPetFocus(() => setExpanded(true));
  }, [bridge]);

  /* ---- 展开 / 收起要改窗口尺寸，且球心不动 ---- */
  useEffect(() => {
    bridge.setPetExpanded(expanded);
  }, [bridge, expanded]);

  /* ---- 鼠标穿透：指针落在实心轮廓或输入条上才收事件，rAF 节流 ---- */
  useEffect(() => {
    let pending = false;
    let ignoring = true;
    const onMove = (e: PointerEvent | MouseEvent): void => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const solid = Boolean(el?.closest('.qq-pet__ball, .qq-pet__input, .qq-pet__bubble'));
        if (solid === !ignoring) return;
        ignoring = !solid;
        bridge.setPetPassthrough(ignoring);
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, [bridge]);

  /* ---- 指针手势：单击切输入条、超过 4 px 进拖动 ---- */
  const gesture = useRef<{ t: number; x: number; y: number; dragging: boolean } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    gesture.current = { t: Date.now(), x: e.clientX, y: e.clientY, dragging: false };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      const dx = e.clientX - g.x;
      const dy = e.clientY - g.y;
      if (!g.dragging && Math.hypot(dx, dy) <= DRAG_SLOP_PX) return;
      g.dragging = true;
      // 增量是相对上一次 move，不是相对起点
      bridge.dragPet(dx, dy);
      g.x = e.clientX;
      g.y = e.clientY;
    },
    [bridge]
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    const moved = Math.hypot(e.clientX - g.x, e.clientY - g.y);
    if (!g.dragging && Date.now() - g.t <= CLICK_MS && moved <= DRAG_SLOP_PX) {
      setExpanded((v) => !v);
    }
  }, []);

  return (
    <div className="qq-pet" data-expanded={expanded ? 'true' : 'false'}>
      {bubble ? (
        <div
          className={'qq-pet__bubble' + (fading ? ' qq-pet__bubble--fading' : '')}
          onMouseEnter={() => {
            hovering.current = true;
          }}
          onMouseLeave={() => {
            hovering.current = false;
          }}
          onClick={() => bridge.openMain()}
          role="status"
        >
          {bubble}
        </div>
      ) : null}

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => {
          e.preventDefault();
          bridge.popupPetMenu({ ambientPaused: false });
        }}
      >
        <QiuqiuBall
          preset="pet"
          gaze="pointer"
          onReady={(q) => {
            qiuqiuRef.current = q;
          }}
        />
      </div>

      {expanded ? (
        <Composer
          variant="pet"
          autoFocus
          history={history}
          text={draft}
          onTextChange={setDraft}
          onEscape={() => setExpanded(false)}
          onSubmit={(text) => {
            setHistory((h) => [...h, text]);
            setBubble('');
            // 桌宠不直接 POST /chat，交主窗口发（AD-5）
            bridge.submitFromPet(text);
          }}
        />
      ) : null}
    </div>
  );
}
