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
import { gazeFromDelta, type CharacterState, type QiuqiuInstance } from '@qiuqiu/character';
import { createLean } from './lean.js';

/** 单击判定：`pointerup` 距 `pointerdown` ≤ 400 ms 且位移 ≤ 4 px。 */
export const CLICK_MS = 400;
export const DRAG_SLOP_PX = 4;
/** `done` 之后气泡停留 6 s 再淡出；鼠标悬停在气泡上则不淡出。 */
export const BUBBLE_LINGER_MS = 6000;

/**
 * 眼神跟随的饱和半径，屏幕像素。光标离球心这么远时眼睛看到头。
 *
 * 比网页端那个 320 大一截：桌面上光标动辄离丘丘上千像素，半径太小的话
 * 眼睛几乎永远是「看到头」的状态，反而没有跟随感。
 */
export const PET_GAZE_RADIUS_PX = 560;

export function PetApp(): React.JSX.Element {
  // 桌宠上也能按 C+A 拨通话，但会话跑在主窗口（AD-5：桌宠不自己发请求）
  useChord(['KeyC', 'KeyA'], () => bridge.callFromPet());

  const bridge = getBridge();
  const qiuqiuRef = useRef<QiuqiuInstance | null>(null);
  const [expanded, setExpanded] = useState(false);
  /** 主窗口镜像过来的状态。表情引擎自己会用，这一份是给样式用的体态。 */
  const [petState, setPetState] = useState<CharacterState>('idle');
  const [bubble, setBubble] = useState('');
  const [fading, setFading] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  /** 输入条收起时文本要保留，所以草稿托管在这里，不放 Composer 内部。 */
  const [draft, setDraft] = useState('');
  const hovering = useRef(false);
  const linger = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* ---- 主窗口转发过来的流 ----
     四条都要退订。不退的话开发模式下 effect 跑两遍就订两份，
     一条 delta 被拼进气泡两次，回复会变成每个字都重复。 */
  useEffect(() => {
    const off = [
      // 主窗口推的是**这一轮到此为止的全文**，直接显示，不自己拼字。
      // 拼字就等于第二套消息处理：漏一条、顺序错一次，两个窗口显示的就不一样了
      bridge.onReply((_sessionId: string, text: string) => {
        if (linger.current) clearTimeout(linger.current);
        setFading(false);
        setBubble(text);
      }),
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
      }),
      bridge.onPetState((state: string, emotionId?: string) => {
        setPetState(state as CharacterState);
        const q = qiuqiuRef.current;
        if (!q) return;
        q.setState(state as CharacterState);
        if (emotionId) q.setEmotion(emotionId);
      }),
      bridge.onPetFocus(() => setExpanded(true)),
      // 眼神跟随。桌宠窗口鼠标穿透且只有 200 px，渲染进程只在光标压在丘丘身上时
      // 才收得到 pointermove，所以偏移由主进程轮询系统光标算好推下来
      bridge.onPetGaze((dx: number, dy: number) => {
        const q = qiuqiuRef.current;
        if (!q) return;
        const { nx, ny } = gazeFromDelta(dx, dy, PET_GAZE_RADIUS_PX);
        q.setGaze(nx, ny);
        // 光标当光源：球面高光跟着挪。钉死的高光是「这是一张图」最明显的破绽
        q.setLight(nx, ny);
      })
    ];
    return () => {
      for (const f of off) f();
    };
  }, [bridge]);

  /* ---- 展开 / 收起要改窗口尺寸，且球心不动 ---- */
  useEffect(() => {
    bridge.setPetExpanded(expanded);
    if (expanded) bridge.pokePet();
  }, [bridge, expanded]);

  /* ---- 气泡有多高要报给主进程 ----
     桌宠窗口是透明无边框的，画在窗口外面的一律被裁掉。气泡在丘丘上方，
     而收起态窗口只有 200 px 高、丘丘就占满了，所以气泡整块都在窗口外，
     只在顶边露出一条——看着就是丘丘头上多了一小块方的东西。
     窗口得先在丘丘上方长出这块地方来，所以量一下报上去。
     换行数（流式回复一个字一个字长）也要跟着报，用 ResizeObserver 盯着。 */
  const bubbleRef = useRef<HTMLDivElement>(null);
  const hasBubble = bubble.length > 0;
  useEffect(() => {
    const el = bubbleRef.current;
    if (!hasBubble || !el) {
      bridge.setPetBubble(0);
      return;
    }
    // 只在气泡出现 / 消失时重装监听。挂在文字上的话，流式回复每来一段就要
    // 拆一次装一次，还顺带量一次布局——回复会一段一段地爬
    let last = -1;
    let raf = 0;
    const report = (): void => {
      raf = 0;
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h === last) return; // 行数没变就别惊动主进程去 resize 窗口
      last = h;
      bridge.setPetBubble(h);
    };
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(report);
    };
    report();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [bridge, hasBubble]);

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
        const solid = Boolean(el?.closest('.qq-pet__ball, .qq-pet__input, .qq-pet__balloon'));
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

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      gesture.current = { t: Date.now(), x: e.screenX, y: e.screenY, dragging: false };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      // 闲置计时开在主窗口，它看不见这一下（AD-5b）
      bridge.pokePet();
    },
    [bridge]
  );

  /**
   * 拖动的增量攒在这里，一帧只发一次 IPC。
   *
   * 指针事件在 macOS 上一秒能来 100+ 次，每次都发一条 IPC 让主进程搬一次窗口，
   * 主进程那边就排起队来，手已经停了窗口还在追——看着就是跟不上手。
   * 攒到一帧发一次之后，发送频率与屏幕刷新对齐，多余的中间点本来也画不出来。
   *
   * 增量必须用 **`screenX/screenY`**，不能用 `clientX/clientY`。
   * `clientX` 是相对窗口的，而拖动搬的正是这个窗口：窗口跟着走一步，
   * 指针的 `clientX` 就退回原处，下一次算出来的增量接近 0，
   * 于是只有手甩得比窗口快时窗口才动——那正是「跟不上手、一顿一顿」的来源。
   * 屏幕坐标不随窗口动，算出来的才是手真正走了多少。
   */
  const pending = useRef<{ dx: number; dy: number } | null>(null);
  const flushing = useRef(0);

  /* ---- 拖动时的滞后与回弹 ----
     窗口是刚体，说到哪就到哪；软乎乎的球被拽着走该稍微落在后面、身子往后倾，
     松手晃一下才停。物理在 lean.ts，这里只负责把姿态写进 CSS 变量。 */
  // 姿态写在外层这个 div 上，CSS 自定义属性会继承下去给 `.qq-pet__ball`
  // ——`QiuqiuBall` 那个 div 的 ref 已经被引擎占了，塞不进第二个
  const ballRef = useRef<HTMLDivElement>(null);
  const lean = useRef(createLean()).current;
  const leanRaf = useRef(0);
  const leanAt = useRef(0);

  const tickLean = useCallback(() => {
    const now = performance.now();
    const dt = leanAt.current ? (now - leanAt.current) / 1000 : 1 / 60;
    leanAt.current = now;
    const p = lean.step(dt);
    const el = ballRef.current;
    if (el) {
      el.style.setProperty('--qq-lean-x', `${p.x.toFixed(2)}px`);
      el.style.setProperty('--qq-lean-y', `${p.y.toFixed(2)}px`);
      el.style.setProperty('--qq-lean-r', `${p.rotate.toFixed(2)}deg`);
    }
    if (lean.atRest()) {
      leanRaf.current = 0;
      leanAt.current = 0;
      return;
    }
    leanRaf.current = requestAnimationFrame(tickLean);
  }, [lean]);

  const wakeLean = useCallback(() => {
    if (leanRaf.current) return;
    leanAt.current = 0;
    leanRaf.current = requestAnimationFrame(tickLean);
  }, [tickLean]);

  useEffect(() => {
    return () => {
      if (leanRaf.current) cancelAnimationFrame(leanRaf.current);
    };
  }, []);

  const flush = useCallback(() => {
    flushing.current = 0;
    const d = pending.current;
    pending.current = null;
    if (d && (d.dx !== 0 || d.dy !== 0)) {
      bridge.dragPet(d.dx, d.dy);
      // 这一帧走了多少，就是丘丘该往后落多少
      lean.push(d.dx, d.dy);
      wakeLean();
    }
  }, [bridge, lean, wakeLean]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      const dx = e.screenX - g.x;
      const dy = e.screenY - g.y;
      if (!g.dragging && Math.hypot(dx, dy) <= DRAG_SLOP_PX) return;
      g.dragging = true;
      // 增量是相对上一次 move，不是相对起点
      const acc = pending.current ?? { dx: 0, dy: 0 };
      acc.dx += dx;
      acc.dy += dy;
      pending.current = acc;
      if (!flushing.current) flushing.current = requestAnimationFrame(flush);
      g.x = e.screenX;
      g.y = e.screenY;
    },
    [flush]
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const g = gesture.current;
      gesture.current = null;
      // 松手时把攒着的最后一点增量补发出去，否则窗口会停在差几像素的地方
      if (flushing.current) {
        cancelAnimationFrame(flushing.current);
        flush();
      }
      lean.release();
      wakeLean();
      if (!g) return;
      const moved = Math.hypot(e.screenX - g.x, e.screenY - g.y);
      if (!g.dragging && Date.now() - g.t <= CLICK_MS && moved <= DRAG_SLOP_PX) {
        setExpanded((v) => !v);
      }
    },
    [flush, lean, wakeLean]
  );

  return (
    <div className="qq-pet" data-expanded={expanded ? 'true' : 'false'}>
      {bubble ? (
        // 两层：外层是对话框本身（描边、底色、尖角），内层负责超长时滚动。
        // 合成一层的话，`overflow-y: auto` 会把尖角那两个伪元素一起裁掉
        <div
          ref={bubbleRef}
          className={'qq-pet__balloon' + (fading ? ' qq-pet__balloon--fading' : '')}
          onMouseEnter={() => {
            hovering.current = true;
          }}
          onMouseLeave={() => {
            hovering.current = false;
          }}
          onClick={() => bridge.openMain()}
          role="status"
        >
          <div className="qq-pet__bubble">{bubble}</div>
        </div>
      ) : null}

      <div
        className="qq-pet__anchor"
        ref={ballRef}
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
          state={petState}
          // 本地那条 pointermove 注视关掉：桌宠窗口穿透，它只在光标压在丘丘
          // 身上时才有事件，且坐标是窗口内的。全局那条（onPetGaze）已经覆盖，
          // 两条一起开会互相打架
          gaze={false}
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
