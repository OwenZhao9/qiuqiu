/**
 * 记忆框图的连接层。
 *
 * **为什么单独一层。** 方块用 HTML 排版（真文字、栏窄了自己换行、字号不变），
 * 但 HTML 画不了「从这个盒子拐几个弯连到那个盒子」——尤其是跨列的那几根，
 * 上一版就是因为画不了直接漏掉了，三个大区之间一根箭头都没有。
 * 反过来整张图钉死坐标画成一块 SVG 也不行，塞进窄栏只能整体缩放，字跟着糊。
 *
 * 所以：盒子归 HTML，线归这一层。运行时量出每个锚点实际落在哪，再在一张
 * 覆盖全图的透明 SVG 上把线画出来；`viewBox` 与容器像素 1:1，一个单位就是
 * 一个像素，线宽和箭头大小不会被拉伸。盒子挪了、窗口变了、紧凑档换了列数，
 * `ResizeObserver` 重量一遍重画，不用手算任何坐标。
 *
 * 两种锚点：
 *   `gap`  流式布局里占着位置的那个空档，箭头在它自己的矩形内从头画到尾。
 *          竖向连接与模态那几根横向箭头都是这一类。
 *   `span` 跨区连接，只知道起点盒子和终点盒子，走哪条路由这里算。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** 线的色调，对应三个分区。 */
export type WireTone = 1 | 2 | 3;

interface WireBase {
  id: string;
  tone: WireTone;
  dashed?: boolean;
  /**
   * 主干上的第几段。待机时这几段依次亮一道很淡的光，说明这是一条数据通路——
   * 没有它整张图平时是死的，只有真发生一轮对话的那一两秒才动一下。
   */
  trunk?: number;
}

export type Wire =
  | (WireBase & { kind: 'gap'; dir: 'v' | 'h' })
  | (WireBase & {
      kind: 'span';
      from: string;
      to: string;
      /** 线上标一句话，画在回环那一段的正中间。 */
      label?: string;
      /**
       * 三段竖着叠起来时怎么办：`zones` 改连下面那两个锚点，`skip` 干脆不画
       * （回环那根在叠起来的版面里会变成一条上千像素的长线，贴着整栏跑）。
       */
      whenStacked?: 'zones' | 'skip';
      /**
       * 三段竖着叠起来时改连这两个锚点。
       *
       * 并排时线走两列之间的空档，压不到东西；叠起来之后「上一段的某个盒子」到
       * 「下一段的某个盒子」中间隔着好几屏内容，直着连过去等于一条竖线把中间
       * 每个方块都划一道。叠起来时改成连两段本身，在它们之间那道缝里走一小段。
       */
      stackedFrom?: string;
      stackedTo?: string;
    });

/** 量位置只用得到这几个字段；这样纯算路径的部分不依赖 DOM，能单独测。 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** 拐角圆角半径。太大在窄空档里会把直线段吃光。 */
const CORNER = 6;

/**
 * 回环那条底道，落在两端下边多少像素。
 *
 * 从容器下沿倒推是错的：三段等高之后分区底边离容器下沿只剩几像素，
 * 底道会落在两端**上面**，最后一段变成往下走，箭头戳在地上。
 * 所以按两端里更低的那个往下推，保证「下去 → 往左 → 上来」这个方向永远成立。
 *
 * 取 26 而不是 12：拐角要吃掉 `CORNER`，箭头本身又有 8 px 高，
 * 12 的时候进目标那一段只剩 6 px 可见，整个箭头糊在横线上，看不出是从下面上来的。
 * 26 留下二十来像素的直段，方向一眼看得出。
 */
const LOOP_DROP = 26;

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * 空档里的一根直箭头：竖的从上边中点到下边中点，横的从左边中点到右边中点。
 *
 * 末端留出箭头本身的长度，不然三角尖会顶到下一个盒子的边框上。
 */
export function straight(r: Rect, base: Rect, dir: 'v' | 'h'): string {
  const x0 = r.left - base.left;
  const y0 = r.top - base.top;
  if (dir === 'v') {
    const x = round(x0 + r.width / 2);
    return `M${x} ${round(y0)} V${round(y0 + r.height)}`;
  }
  const y = round(y0 + r.height / 2);
  return `M${round(x0)} ${y} H${round(x0 + r.width)}`;
}

/**
 * b 相对 a 在哪边，决定走哪套路由。
 *
 * `down` 是「既不在左也不在右」——两块横向叠在一起，只能上下连。
 * 三段并排时不会出现，栏窄到三段竖着叠起来时全是这种。
 */
export function side(a: Rect, b: Rect): 'right' | 'left' | 'down' {
  if (b.left >= a.right - 4) return 'right';
  if (b.right <= a.left + 4) return 'left';
  return 'down';
}

/** 一个 90° 拐角：从当前点拐到另一个方向，圆角半径 r。 */
function corner(x: number, y: number, r: number, sweep: 0 | 1): string {
  return `A${r} ${r} 0 0 ${sweep} ${round(x)} ${round(y)}`;
}

/**
 * 跨区连接。两块的相对位置决定从哪条边出、从哪条边进：
 *
 * - b 在 a 右边（三列并排时）：从 a 右边出来，在两列之间的空档里上下走一段，
 *   再从左边进 b。竖直那一段走在两列正中间，压不到任何一列的内容。
 * - b 在 a 下面（栏太窄、三段竖着叠起来时）：从 a 下边出来往下走，从上边进 b。
 *
 * 少了第二种会出事：叠起来的时候仍按「从右边出、从左边进」算，线会从右边缘
 * 一路倒扫回左边缘，横穿整栏。完整档在 600 px 宽的中栏里正是叠起来的。
 */
export function elbow(a: Rect, b: Rect, base: Rect): string {
  const L = base.left;
  const T = base.top;

  const where = side(a, b);

  // b 在右边：横着走
  if (where === 'right') {
    const x0 = round(a.right - L);
    const y0 = round(a.top - T + a.height / 2);
    const x1 = round(b.left - L);
    const y1 = round(b.top - T + b.height / 2);
    if (Math.abs(y1 - y0) < 2) return `M${x0} ${y0} H${x1}`;
    const xm = round((x0 + x1) / 2);
    const down = y1 > y0;
    const r = Math.min(CORNER, Math.abs(xm - x0), Math.abs(x1 - xm), Math.abs(y1 - y0) / 2);
    const dir = down ? 1 : -1;
    return [
      `M${x0} ${y0}`,
      `H${round(xm - r)}`,
      corner(xm, y0 + r * dir, r, down ? 1 : 0),
      `V${round(y1 - r * dir)}`,
      corner(xm + r, y1, r, down ? 0 : 1),
      `H${x1}`
    ].join(' ');
  }

  // b 在左边：回环。从 a 下边出来，走底道往左，再从下边**往上**进 b
  if (where === 'left') {
    const x0 = round(a.left - L + a.width / 2);
    const y0 = round(a.bottom - T);
    const x1 = round(b.left - L + b.width / 2);
    const y1 = round(b.bottom - T);
    const lane = round(Math.max(y0, y1) + LOOP_DROP);
    const r = Math.min(CORNER, lane - y0, lane - y1, Math.abs(x0 - x1) / 2);
    return [
      `M${x0} ${y0}`,
      `V${round(lane - r)}`,
      corner(x0 - r, lane, r, 1),
      `H${round(x1 + r)}`,
      corner(x1, round(lane - r), r, 1),
      `V${y1}`
    ].join(' ');
  }

  // 否则当作 b 在下面：竖着走
  const x0 = round(a.left - L + a.width / 2);
  const y0 = round(a.bottom - T);
  const x1 = round(b.left - L + b.width / 2);
  const y1 = round(b.top - T);
  if (Math.abs(x1 - x0) < 2) return `M${x0} ${y0} V${y1}`;
  const ym = round((y0 + y1) / 2);
  const right = x1 > x0;
  const r = Math.min(CORNER, Math.abs(ym - y0), Math.abs(y1 - ym), Math.abs(x1 - x0) / 2);
  const dir = right ? 1 : -1;
  return [
    `M${x0} ${y0}`,
    `V${round(ym - r)}`,
    corner(x0 + r * dir, ym, r, right ? 0 : 1),
    `H${round(x1 - r * dir)}`,
    corner(x1, ym + r, r, right ? 1 : 0),
    `V${y1}`
  ].join(' ');
}

interface Geom {
  w: number;
  h: number;
  paths: Record<string, string>;
  /** 线上那句话画在哪。 */
  labels: Record<string, [number, number]>;
}

const EMPTY: Geom = { w: 0, h: 0, paths: {}, labels: {} };

function same(a: Geom, b: Geom): boolean {
  if (a.w !== b.w || a.h !== b.h) return false;
  const ka = Object.keys(a.paths);
  const kb = Object.keys(b.paths);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a.paths[k] === b.paths[k]);
}

/**
 * 量出这一组线各自该走哪条路径。
 *
 * `wires` 是拓扑，整张图的拓扑是固定的，所以放在模块常量里传进来——
 * 每次渲染新建一个数组会让下面这个 effect 每帧重挂一遍。
 */
export function useWireGeom(
  host: React.RefObject<HTMLElement | null>,
  wires: readonly Wire[]
): Geom {
  const [geom, setGeom] = useState<Geom>(EMPTY);
  const geomRef = useRef(geom);
  geomRef.current = geom;

  const measure = useCallback(() => {
    const el = host.current;
    if (!el) return;
    const base = el.getBoundingClientRect();
    if (base.width === 0) return; // 收起来的时候不量，量出来全是 0
    const paths: Record<string, string> = {};
    const labels: Record<string, [number, number]> = {};
    for (const w of wires) {
      if (w.kind === 'gap') {
        const g = el.querySelector(`[data-wire="${w.id}"]`);
        if (g) paths[w.id] = straight(g.getBoundingClientRect(), base, w.dir);
        continue;
      }
      let a = el.querySelector(`[data-node="${w.from}"]`);
      let b = el.querySelector(`[data-node="${w.to}"]`);
      if (!a || !b) continue;
      // 横向叠在一起才算「叠起来了」；目标在左边是回环，不是叠
      const stacked = side(a.getBoundingClientRect(), b.getBoundingClientRect()) === 'down';
      if (stacked) {
        if (w.whenStacked === 'skip') continue;
        if (w.stackedFrom && w.stackedTo) {
          a = el.querySelector(`[data-node="${w.stackedFrom}"]`) ?? a;
          b = el.querySelector(`[data-node="${w.stackedTo}"]`) ?? b;
        }
      }
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      paths[w.id] = elbow(ra, rb, base);
      if (w.label) {
        labels[w.id] = [
          round((ra.left + ra.width / 2 + rb.left + rb.width / 2) / 2 - base.left),
          round(base.height - 9)
        ];
      }
    }
    const next: Geom = { w: round(base.width), h: round(base.height), paths, labels };
    if (!same(geomRef.current, next)) setGeom(next);
  }, [host, wires]);

  useEffect(() => {
    measure();
    const el = host.current;
    if (!el) return;
    // 盒子自己变大变小（文字换行、内容变了）也要重量，光看容器不够
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    for (const n of el.querySelectorAll('[data-wire],[data-node]')) ro.observe(n);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [host, measure]);

  return geom;
}

/** 一个空档：在流式布局里占住位置，线由连接层画在它的矩形里。 */
export function Gap({
  id,
  dir = 'v',
  label
}: {
  id: string;
  dir?: 'v' | 'h';
  label?: string;
}): React.JSX.Element {
  return (
    <div className={dir === 'v' ? 'qq-map__gap' : 'qq-map__gap qq-map__gap--h'} data-wire={id}>
      {label ? <span className="qq-map__gap-label">{label}</span> : null}
    </div>
  );
}

/**
 * 连接层本体。
 *
 * 箭头用 marker，`markerUnits="userSpaceOnUse"` 让它按像素定尺寸——跟着线宽缩放
 * 的话，细线上的箭头会小到看不出是箭头。四个 marker 是三个分区色 + 走过的路那一个。
 */
export function Wires({
  geom,
  wires,
  lit
}: {
  geom: Geom;
  wires: readonly Wire[];
  lit: Readonly<Record<string, boolean>>;
}): React.JSX.Element | null {
  if (geom.w === 0) return null;
  return (
    <svg
      className="qq-map__wires"
      viewBox={`0 0 ${geom.w} ${geom.h}`}
      width={geom.w}
      height={geom.h}
      aria-hidden="true"
    >
      <defs>
        {([1, 2, 3, 'on'] as const).map((t) => (
          <marker
            key={t}
            id={`qq-wire-tip-${t}`}
            viewBox="0 0 10 8"
            markerWidth="10"
            markerHeight="8"
            markerUnits="userSpaceOnUse"
            refX="9"
            refY="4"
            orient="auto"
          >
            <path className={`qq-map__wire-tip qq-map__wire-tip--${t}`} d="M0 0 L10 4 L0 8 Z" />
          </marker>
        ))}
      </defs>
      {wires.map((w) => {
        const d = geom.paths[w.id];
        if (!d) return null;
        const on = lit[w.id] === true;
        const tip = on ? 'on' : w.tone;
        return (
          <g key={w.id} className={'qq-map__wire' + (on ? ' qq-map--on' : '')} data-tone={w.tone}>
            <path
              className="qq-map__wire-line"
              d={d}
              strokeDasharray={w.dashed ? '4 4' : undefined}
              markerEnd={`url(#qq-wire-tip-${tip})`}
            />
            {/* 走过的那条路上叠一段跑动的虚线：静态箭头只说明连通，
                跑起来才说明此刻数据正在这里过，而且看得出方向 */}
            {on ? <path className="qq-map__wire-flow" d={d} /> : null}
            {!on && w.trunk !== undefined ? (
              <path
                className="qq-map__wire-idle"
                d={d}
                /* 把路径长度归一成 100，那道光就按「百分之几」走，
                   长线短线都是从头走到尾。按真实长度算的话，短的那几段一闪而过，
                   长的那根只挪一小截就没了 */
                pathLength={100}
                style={{ animationDelay: `${w.trunk * 0.34}s` }}
              />
            ) : null}
            {geom.labels[w.id] ? (
              <text
                className="qq-map__wire-label"
                x={geom.labels[w.id][0]}
                y={geom.labels[w.id][1]}
              >
                {w.kind === 'span' ? w.label : null}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
