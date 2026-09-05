/**
 * 装扮层：在 Emotion Ball 画好的 SVG 里加一层二次元少女的零件。
 *
 * **不改 `vendor/emotion-ball/` 任何文件**，也不改引擎的任何逻辑——只是往它
 * 已经建好的 SVG 里插几个自己的节点。插的位置分三层，靠 z 序解决遮挡：
 *
 *     bodyG
 *       ├─ back   呆毛                 ← 在身体之前，只露出头顶那一截
 *       ├─ head   （引擎的身体）
 *       ├─ mid    泽面高光 · 蝴蝶结 · 腮红   ← 压在身体上、眼睛下
 *       ├─ eyeL   （引擎的左眼）
 *       ├─ eyeR   （引擎的右眼）
 *       └─ front  眼高光 · 闪光          ← 压在眼睛上
 *
 * 插在 `bodyG` 里面而不是 SVG 根上，是为了**白拿身体的整体变换**：呼吸、点头、
 * 生气时的抖动都写在 `bodyG` 的 `transform` 上，当子节点就自动跟着动，一帧 JS 都不用跑。
 *
 * 只有跟眼睛走的两件（眼高光、腮红）需要每帧同步。丘丘的眼睛不是固定在脸上的，
 * 它会在整个身体上游走（`02` 待机就在 `EXPRESSIONS[0]` 与 `[8]` 之间来回，
 * 一个在右上一个在中左），所以腮红不能钉死在「脸颊」——那会飘到没有脸的地方。
 * 做法是每帧读眼睛节点的 `transform`：
 *
 *     translate(ex ey) [rotate(r)] scale(sx sy) translate(-bx -by)
 *
 * - **眼高光**整条照抄，于是高光跟着眼睛一起缩放、旋转、眨眼时压扁，永远贴在瞳上
 * - **腮红**只取头一个 `translate` 的平移量，往下偏 30，于是跟着眼睛走位却
 *   不吃 `scale`——不然眨眼那一瞬间腮红会跟着压成一条线
 *
 * 每帧的开销是两次 `getAttribute` 加几次 `setAttribute`，不读布局，不触发重排。
 */

import type { CharacterLook } from './types.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/** 身体中心，与 `vendor/emotion-ball/js/rings.js` 的 `HEAD_C` 同值。 */
export const HEAD_C = 114.2705;

/** 眼睛局部坐标系里的半高，与 vendor 的 `EYE_HALF` 同值。高光尺寸按它取。 */
export const EYE_HALF = 21;

/** 腮红相对眼睛中心往下偏多少（身体坐标系单位）。 */
export const BLUSH_DROP = 30;

/** 腮红相对眼睛中心往外偏多少。左眼往左、右眼往右。 */
export const BLUSH_SPREAD = 6;

let seq = 0;

function el<K extends string>(tag: K, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** 页面要求减少动效时，闪光不闪、呆毛不飘。 */
function prefersReducedMotion(view: Window | null): boolean {
  try {
    return view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

/**
 * 从引擎写的 eye `transform` 里取出平移量与「基准点」。
 *
 * 引擎每帧写的串固定是
 * `translate(ex ey) [rotate(r)] scale(sx sy) translate(-bx -by)`，
 * 头一个 `translate` 是眼睛在身体坐标系里的落点，末一个 `translate` 的相反数
 * 是这只眼在自己局部坐标系里的中心（引擎管它叫 `base`，取自当前眼环的质心）。
 *
 * 取不到就返回 `null`，调用方跳过这一帧——宁可高光不动，也不要瞎猜位置。
 */
export function parseEyeTransform(
  t: string | null
): { at: [number, number]; base: [number, number] } | null {
  if (!t) return null;
  const head = /^\s*translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)/.exec(t);
  const tail = /translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)\s*$/.exec(t);
  // 两个 translate 必须是不同的两段。只有一个 `translate(a b)` 时首尾正则会
  // 咬到同一段，算出 base = -at 这种明显不对的结果，那不是引擎写的串，直接不认
  if (!head || !tail || tail.index < head[0].length) return null;
  const at: [number, number] = [Number(head[1]), Number(head[2])];
  const base: [number, number] = [-Number(tail[1]), -Number(tail[2])];
  if (![...at, ...base].every(Number.isFinite)) return null;
  return { at, base };
}

/** 四角星。二次元的闪光是尖的，不是圆点。 */
function starPath(r: number): string {
  const w = r * 0.16;
  return (
    `M 0 ${-r} C ${w} ${-w} ${w} ${-w} ${r} 0 ` +
    `C ${w} ${w} ${w} ${w} 0 ${r} ` +
    `C ${-w} ${w} ${-w} ${w} ${-r} 0 ` +
    `C ${-w} ${-w} ${-w} ${-w} 0 ${-r} Z`
  );
}

/** 挂上去的一层装扮。`destroy` 之后引擎的 SVG 回到原样。 */
export interface Costume {
  /** 这层是哪个形象的。 */
  readonly look: CharacterLook;
  /** 手动跑一帧同步。正常由内部 rAF 驱动，测试里直接调。 */
  sync(): void;
  /** 摘掉：停 rAF、把插进去的节点全部移除。 */
  destroy(): void;
}

/** 找 `bodyG`：引擎建的三个直接子 `<g>` 里，只有它没有 `pointer-events="none"`。 */
export function findBodyGroup(svg: SVGElement): SVGElement | null {
  const groups = Array.from(svg.children).filter(
    (n): n is SVGElement => n.tagName.toLowerCase() === 'g'
  );
  return groups.find((g) => !g.hasAttribute('pointer-events')) ?? null;
}

export interface MountCostumeOptions {
  /** 注入 rAF，测试里换成手动步进。 */
  raf?: (cb: () => void) => number;
  cancel?: (handle: number) => void;
  /** 强制开 / 关动效，缺省读 `prefers-reduced-motion`。 */
  animate?: boolean;
}

/**
 * 给 `mount` 里那只球挂上装扮。
 *
 * `look` 不是 `'anime'`、或者 `mount` 里根本没有引擎画的 SVG（测试替身就不画），
 * 都返回 `null`——**没挂上就说没挂上**，不返回一个假的空壳假装成功。
 */
export function mountCostume(
  mount: HTMLElement,
  look: CharacterLook,
  opts: MountCostumeOptions = {}
): Costume | null {
  if (look !== 'anime') return null;
  const svg = mount.querySelector('svg');
  if (!svg) return null;
  const body = findBodyGroup(svg as unknown as SVGElement);
  if (!body) return null;

  const paths = Array.from(body.children).filter(
    (n): n is SVGElement => n.tagName.toLowerCase() === 'path'
  );
  const [head, eyeL, eyeR] = paths;
  if (!head || !eyeL || !eyeR) return null;

  const uid = `qqc${++seq}`;
  const view = mount.ownerDocument?.defaultView ?? null;
  const animate = opts.animate ?? !prefersReducedMotion(view);

  /* ---------------- defs：腮红与泽面的柔边渐变 ---------------- */

  const defs = el('defs', {});
  const blushGrad = el('radialGradient', { id: `${uid}-blush` });
  blushGrad.appendChild(
    el('stop', { offset: '0%', 'stop-color': '#FF6FA3', 'stop-opacity': '0.62' })
  );
  blushGrad.appendChild(
    el('stop', { offset: '55%', 'stop-color': '#FF8AB6', 'stop-opacity': '0.4' })
  );
  blushGrad.appendChild(
    el('stop', { offset: '100%', 'stop-color': '#FFB3CE', 'stop-opacity': '0' })
  );
  defs.appendChild(blushGrad);

  const glossGrad = el('linearGradient', {
    id: `${uid}-gloss`,
    x1: '0',
    y1: '0',
    x2: '0.4',
    y2: '1'
  });
  glossGrad.appendChild(
    el('stop', { offset: '0%', 'stop-color': '#FFFFFF', 'stop-opacity': '0.55' })
  );
  glossGrad.appendChild(
    el('stop', { offset: '100%', 'stop-color': '#FFFFFF', 'stop-opacity': '0' })
  );
  defs.appendChild(glossGrad);
  svg.appendChild(defs);

  /* ---------------- back：呆毛 ---------------- */
  // 呆毛整根画出来，但根部埋在身体里（身体在它之后绘制，会盖住），
  // 露出来的只有头顶那一撮。所以形状可以放心往下延伸，不用对齐轮廓。

  const back = el('g', { class: 'qq-costume qq-costume--back', 'pointer-events': 'none' });
  const ahoge = el('path', {
    class: 'qq-costume__ahoge',
    // 根埋在身体里（身体在它之后画，会盖住），露出来的只有头顶这一撮
    d: 'M 112 34 C 108 8 122 -12 148 -14 C 132 -4 128 8 132 34 Z',
    fill: '#F7C9DC',
    stroke: '#E7A6C2',
    'stroke-width': 1.8,
    'stroke-linejoin': 'round'
  });
  back.appendChild(ahoge);
  body.insertBefore(back, head);

  /* ---------------- mid：泽面高光 · 蝴蝶结 · 腮红 ---------------- */
  // 压在身体上、眼睛下。眼睛游走时会从蝴蝶结和腮红上面过去，
  // 这个顺序保证「眼睛永远在最上面」——五官被装饰盖住就不成脸了。

  const mid = el('g', { class: 'qq-costume qq-costume--mid', 'pointer-events': 'none' });

  // 泽面：左上一道斜光。方向跟引擎自带的径向渐变一致（光心在 38% / 32%），
  // 加一道硬边高光把哑光的球面推成瓷面
  mid.appendChild(
    el('ellipse', {
      class: 'qq-costume__gloss',
      cx: 0,
      cy: 0,
      rx: 34,
      ry: 21,
      fill: `url(#${uid}-gloss)`,
      transform: 'translate(64 54) rotate(-32)'
    })
  );

  // 蝴蝶结：戴在头顶偏左，避开眼睛能游走到的高度
  const bow = el('g', {
    class: 'qq-costume__bow',
    transform: 'translate(70 28) rotate(-16) scale(1.15)'
  });
  const bowFill = '#FF8FB6';
  const bowLine = '#E2618F';
  for (const s of [-1, 1] as const) {
    bow.appendChild(
      el('path', {
        d: `M 0 0 C ${s * 8} -13 ${s * 27} -15 ${s * 32} -6 ` + `C ${s * 36} 3 ${s * 19} 13 0 0 Z`,
        fill: bowFill,
        stroke: bowLine,
        'stroke-width': 2,
        'stroke-linejoin': 'round'
      })
    );
  }
  bow.appendChild(
    el('ellipse', {
      cx: 0,
      cy: 0,
      rx: 6.4,
      ry: 5.4,
      fill: '#F2739F',
      stroke: bowLine,
      'stroke-width': 1.6
    })
  );
  mid.appendChild(bow);

  // 腮红：两片，每帧跟着对应那只眼睛走位
  function makeBlush(side: -1 | 1): SVGElement {
    const g = el('g', { class: 'qq-costume__blush' });
    g.appendChild(el('ellipse', { cx: 0, cy: 0, rx: 27, ry: 16, fill: `url(#${uid}-blush)` }));
    // 少女漫的斜线腮红。三道，中间那道长一点
    for (const [i, len] of [8, 11, 8].entries()) {
      g.appendChild(
        el('line', {
          x1: (i - 1) * 8 - len * 0.32,
          y1: len * 0.42,
          x2: (i - 1) * 8 + len * 0.32,
          y2: -len * 0.42,
          stroke: '#FF6FA3',
          'stroke-opacity': 0.5,
          'stroke-width': 2.2,
          'stroke-linecap': 'round'
        })
      );
    }
    g.setAttribute('transform', `translate(${HEAD_C + side * 50} ${HEAD_C + BLUSH_DROP})`);
    return g;
  }
  const blushL = makeBlush(-1);
  const blushR = makeBlush(1);
  mid.appendChild(blushL);
  mid.appendChild(blushR);
  body.insertBefore(mid, eyeL);

  /* ---------------- front：眼高光 · 闪光 ---------------- */

  const front = el('g', { class: 'qq-costume qq-costume--front', 'pointer-events': 'none' });

  /**
   * 一只眼上的两点高光。大点在左上（跟身体渐变的光向一致），小点在右下。
   *
   * 两点都**裁进眼睛自己的形状里**：丘丘的眼睛不是圆的，`02` 待机时是两根斜置的胶囊，
   * 别的表情有月牙、有横线。按固定偏移画的圆点在窄形状上必然探出去，
   * 看着像脸上粘了两粒白米。裁完溢出的部分自动没了，剩下的是一牙月形高光
   * ——这正好是二次元画眼睛的画法。
   *
   * 裁剪路径的 `d` 直接抄眼睛的 `d`。两者都活在眼睛的局部坐标系里
   * （`<g clip-path>` 自己不带变换，用的就是外层那条抄来的 eye transform），
   * 所以不用做任何换算。
   */
  function makeShine(key: string): {
    g: SVGElement;
    clip: SVGElement;
    big: SVGElement;
    small: SVGElement;
  } {
    const clipId = `${uid}-eye-${key}`;
    const clipPath = el('clipPath', { id: clipId });
    const clip = el('path', { d: '' });
    clipPath.appendChild(clip);
    defs.appendChild(clipPath);

    const g = el('g', { class: 'qq-costume__shine' });
    const inner = el('g', { 'clip-path': `url(#${clipId})` });
    const big = el('circle', { r: EYE_HALF * 0.36, fill: '#FFFFFF', 'fill-opacity': 0.95 });
    const small = el('circle', { r: EYE_HALF * 0.16, fill: '#FFFFFF', 'fill-opacity': 0.72 });
    inner.appendChild(big);
    inner.appendChild(small);
    g.appendChild(inner);
    return { g, clip, big, small };
  }
  const shineL = makeShine('l');
  const shineR = makeShine('r');
  front.appendChild(shineL.g);
  front.appendChild(shineR.g);

  // 闪光：三颗，全在轮廓之外的留白里，不压在身上（压在身上像脏点）
  const sparkSpots: [number, number, number, number][] = [
    [16, 26, 8, 0],
    [231, 60, 5.6, 0.9],
    [237, 130, 4.2, 1.7]
  ];
  for (const [x, y, r, delay] of sparkSpots) {
    const s = el('path', {
      class: 'qq-costume__spark',
      d: starPath(r),
      fill: '#FFC94D',
      transform: `translate(${x} ${y})`,
      opacity: animate ? 0 : 0.85
    });
    if (animate) {
      s.appendChild(
        el('animate', {
          attributeName: 'opacity',
          values: '0;0.95;0.2;0.9;0',
          keyTimes: '0;0.18;0.4;0.62;1',
          dur: '2.8s',
          begin: `${delay}s`,
          repeatCount: 'indefinite'
        })
      );
    }
    front.appendChild(s);
  }
  body.appendChild(front);

  /* ---------------- 每帧：跟着眼睛走 ---------------- */

  const pairs = [
    { eye: eyeL, shine: shineL, blush: blushL, side: -1 as const },
    { eye: eyeR, shine: shineR, blush: blushR, side: 1 as const }
  ];
  const lastT = new Map<SVGElement, string>();

  function sync(): void {
    for (const p of pairs) {
      const t = p.eye.getAttribute('transform');
      // 眼睛转到球背面时引擎会把它 display:none，高光和腮红一起收起来
      const hidden =
        (p.eye as unknown as SVGElement & { style: CSSStyleDeclaration }).style.display === 'none';
      p.shine.g.setAttribute('opacity', hidden ? '0' : '1');
      p.blush.setAttribute('opacity', hidden ? '0' : '1');
      if (hidden || !t || lastT.get(p.eye) === t) continue;
      lastT.set(p.eye, t);
      const parsed = parseEyeTransform(t);
      if (!parsed) continue;

      // 高光：整条变换照抄，于是它活在眼睛自己的局部坐标系里，
      // 眨眼、旋转、缩放全部白拿
      p.shine.g.setAttribute('transform', t);
      const [bx, by] = parsed.base;
      p.shine.big.setAttribute('cx', String(bx - EYE_HALF * 0.3));
      p.shine.big.setAttribute('cy', String(by - EYE_HALF * 0.34));
      p.shine.small.setAttribute('cx', String(bx + EYE_HALF * 0.28));
      p.shine.small.setAttribute('cy', String(by + EYE_HALF * 0.3));

      // 裁剪路径跟着眼睛换形。表情切换时 `d` 每帧都在变（引擎在插值两个眼环），
      // 定住之后就不动了，所以比一次也不缓存便宜得多
      const d = p.eye.getAttribute('d');
      if (d && p.shine.clip.getAttribute('d') !== d) p.shine.clip.setAttribute('d', d);

      // 腮红：只跟平移，不跟缩放。跟了缩放的话眨眼时腮红会一起压成线
      const [ex, ey] = parsed.at;
      p.blush.setAttribute(
        'transform',
        `translate(${ex + p.side * BLUSH_SPREAD} ${ey + BLUSH_DROP})`
      );
    }
  }
  sync();

  /* ---------------- rAF ---------------- */

  const raf =
    opts.raf ??
    (typeof requestAnimationFrame === 'function'
      ? (cb: () => void) => requestAnimationFrame(() => cb())
      : (cb: () => void) => setTimeout(cb, 16) as unknown as number);
  const cancel =
    opts.cancel ??
    (typeof cancelAnimationFrame === 'function'
      ? (h: number) => cancelAnimationFrame(h)
      : (h: number) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));

  let handle = 0;
  let alive = true;
  function loop(): void {
    if (!alive) return;
    sync();
    handle = raf(loop);
  }
  handle = raf(loop);

  return {
    look,
    sync,
    destroy() {
      if (!alive) return;
      alive = false;
      if (handle) cancel(handle);
      handle = 0;
      for (const n of [back, mid, front, defs]) n.parentNode?.removeChild(n);
    }
  };
}
