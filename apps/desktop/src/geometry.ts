/**
 * 桌宠窗口的几何。数值逐条来自 `design/interaction.md` § 1。
 *
 * 纯函数，不 import electron——主进程调它，vitest 也调它。
 *
 * 最要紧的一条：**展开与收起时球心必须不动**。
 * 球心跳一下是桌宠最招人烦的毛病，这条不能商量。
 */

/** 收起态 200 × 200，丘丘铺满。 */
export const PET_COLLAPSED = { width: 200, height: 200 } as const;

/** 展开态 336 × 256：丘丘 200 居中在上，下方 8 px 间隙，再下是 320 × 40 的输入条，底部 8 px。 */
export const PET_EXPANDED = { width: 336, height: 256 } as const;

/** 输入条那一块（间隙 + 输入条 + 底部间隙）在窗口高度里占多少。 */
export const PET_INPUT_BLOCK = PET_EXPANDED.height - PET_COLLAPSED.height;

/** 气泡与丘丘之间的间隙。 */
export const PET_BUBBLE_GAP = 8;

/** 松手时任一边距工作区边缘不超过这个数就贴齐。 */
export const SNAP_PX = 16;

/** 窗口至少留这么多像素在屏幕内。 */
export const MIN_VISIBLE_PX = 48;

/** 「回到默认位置」：右下角，距工作区右边与下边各 24 px。 */
export const DEFAULT_MARGIN_PX = 24;

/** 主窗口：最小 640 × 480，默认 1200 × 800。 */
export const MAIN_WINDOW = {
  width: 1200,
  height: 800,
  minWidth: 640,
  minHeight: 480
} as const;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Area = Rect;

/**
 * 桌宠窗口此刻要装的东西。
 *
 * `bubble` 是气泡**渲染出来的高度**，0 表示没有气泡。窗口是透明无边框的，
 * 画在窗口外面的东西一律被裁掉——气泡原来钉在丘丘上方 208 px，
 * 而收起态窗口只有 200 px 高，于是整块都在窗口外，只在顶边露出一条。
 * 所以有气泡时窗口必须先长出这块地方来。
 */
export interface PetLayout {
  /** 输入条展开了没有。 */
  expanded: boolean;
  /** 气泡高度，px。0 = 没有气泡。 */
  bubble: number;
}

/** 丘丘上方要留多少地方给气泡。没气泡就是 0，连间隙一起省掉。 */
export function bubbleBlock(bubble: number): number {
  return bubble > 0 ? Math.ceil(bubble) + PET_BUBBLE_GAP : 0;
}

/** 这套布局下窗口多大，以及丘丘上方留了多少。 */
export function petSize(layout: PetLayout): {
  width: number;
  height: number;
  above: number;
} {
  const above = bubbleBlock(layout.bubble);
  const base = layout.expanded ? PET_EXPANDED : PET_COLLAPSED;
  return { width: base.width, height: above + base.height, above };
}

function sizeOf(expanded: boolean): { width: number; height: number } {
  return expanded ? PET_EXPANDED : PET_COLLAPSED;
}

/**
 * 换一套布局之后的窗口 bounds，**球心保持不动**。
 *
 * 三件事都会改窗口尺寸：展开输入条（高 +56、宽 +136）、气泡出现或换行数
 * （丘丘上方长出一块）。球心跳一下是桌宠最招人烦的毛病，所以统一在这里算：
 * 宽度差的一半从 `x` 补回来，丘丘上方那块的差从 `y` 补回来。
 *
 * `from` 是当前 bounds 对应的布局——只有知道现在丘丘上方留了多少，
 * 才算得出球心在哪。
 */
export function petBounds(current: Rect, from: PetLayout, to: PetLayout): Rect {
  const center = ballCenter(current, from);
  const next = petSize(to);
  return {
    x: Math.round(center.x - next.width / 2),
    y: Math.round(center.y - next.above - PET_COLLAPSED.height / 2),
    width: next.width,
    height: next.height
  };
}

/** 球心的屏幕坐标。丘丘水平居中，纵向在气泡那一块的下面。 */
export function ballCenter(
  rect: Rect,
  layout: PetLayout = { expanded: false, bubble: 0 }
): {
  x: number;
  y: number;
} {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + bubbleBlock(layout.bubble) + PET_COLLAPSED.height / 2
  };
}

/** 拖动：增量是相对上一次 move，主进程累加到窗口位置。 */
export function moveBy(rect: Rect, dx: number, dy: number): Rect {
  return { ...rect, x: Math.round(rect.x + dx), y: Math.round(rect.y + dy) };
}

/** 松手时的边缘吸附：任一边距工作区边缘 ≤ 16 px 就贴齐该边。 */
export function snapToEdges(rect: Rect, work: Area): Rect {
  let { x, y } = rect;
  const right = work.x + work.width;
  const bottom = work.y + work.height;

  if (Math.abs(x - work.x) <= SNAP_PX) x = work.x;
  else if (Math.abs(x + rect.width - right) <= SNAP_PX) x = right - rect.width;

  if (Math.abs(y - work.y) <= SNAP_PX) y = work.y;
  else if (Math.abs(y + rect.height - bottom) <= SNAP_PX) y = bottom - rect.height;

  return { ...rect, x, y };
}

/** 不允许被拖出工作区：至少 48 px 留在屏幕内，超出时钳回。 */
export function clampToWorkArea(rect: Rect, work: Area): Rect {
  const minX = work.x - (rect.width - MIN_VISIBLE_PX);
  const maxX = work.x + work.width - MIN_VISIBLE_PX;
  const minY = work.y - (rect.height - MIN_VISIBLE_PX);
  const maxY = work.y + work.height - MIN_VISIBLE_PX;
  return {
    ...rect,
    x: Math.min(maxX, Math.max(minX, rect.x)),
    y: Math.min(maxY, Math.max(minY, rect.y))
  };
}

/** 松手时走这一遍：先钳回工作区，再吸附。 */
export function settle(rect: Rect, work: Area): Rect {
  return snapToEdges(clampToWorkArea(rect, work), work);
}

/** 右下角，距工作区右边与下边各 24 px。 */
export function defaultPetBounds(work: Area, expanded = false): Rect {
  const size = sizeOf(expanded);
  return {
    x: work.x + work.width - size.width - DEFAULT_MARGIN_PX,
    y: work.y + work.height - size.height - DEFAULT_MARGIN_PX,
    width: size.width,
    height: size.height
  };
}

/** 恢复上次的位置：尺寸以当前展开态为准，位置钳回当前工作区（换了显示器也不会跑丢）。 */
export function restorePetBounds(
  saved: { x: number; y: number } | null,
  work: Area,
  expanded = false
): Rect {
  if (!saved) return defaultPetBounds(work, expanded);
  const size = sizeOf(expanded);
  return clampToWorkArea({ x: saved.x, y: saved.y, ...size }, work);
}
