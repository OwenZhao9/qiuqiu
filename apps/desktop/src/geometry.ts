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

function sizeOf(expanded: boolean): { width: number; height: number } {
  return expanded ? PET_EXPANDED : PET_COLLAPSED;
}

/**
 * 展开 / 收起后的窗口 bounds，球心保持不动。
 *
 * 收起 → 展开：宽 +136、高 +56，同时 `x -= 68`，`y` 不变。
 * 半个宽度差正好是 68，所以球心的横坐标 `x + width / 2` 前后相等；
 * 丘丘贴着窗口顶部，纵坐标 `y + 100` 也不动。
 */
export function petBounds(current: Rect, expanded: boolean): Rect {
  const next = sizeOf(expanded);
  const dx = (next.width - current.width) / 2;
  return {
    x: Math.round(current.x - dx),
    y: current.y,
    width: next.width,
    height: next.height
  };
}

/** 球心的屏幕坐标。丘丘永远在窗口顶部、水平居中。 */
export function ballCenter(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + PET_COLLAPSED.height / 2 };
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
