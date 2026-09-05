/** 桌宠窗口的几何。数值逐条对着 `design/interaction.md` § 1。 */

import { describe, expect, it } from 'vitest';
import {
  ballCenter,
  clampToWorkArea,
  defaultPetBounds,
  DEFAULT_MARGIN_PX,
  MIN_VISIBLE_PX,
  moveBy,
  petBounds,
  PET_COLLAPSED,
  PET_EXPANDED,
  restorePetBounds,
  settle,
  snapToEdges,
  SNAP_PX,
  type Area,
  type Rect
} from '../src/geometry.js';

const WORK: Area = { x: 0, y: 25, width: 1440, height: 875 };

describe('尺寸', () => {
  it('收起 200 × 200，展开 336 × 256', () => {
    expect(PET_COLLAPSED).toEqual({ width: 200, height: 200 });
    expect(PET_EXPANDED).toEqual({ width: 336, height: 256 });
  });
});

describe('petBounds · 球心不动', () => {
  const collapsed = { x: 400, y: 300, ...PET_COLLAPSED };

  it('收起 → 展开：宽 +136、高 +56，x -= 68，y 不变', () => {
    const out = petBounds(collapsed, true);
    expect(out.width - collapsed.width).toBe(136);
    expect(out.height - collapsed.height).toBe(56);
    expect(out.x).toBe(collapsed.x - 68);
    expect(out.y).toBe(collapsed.y);
  });

  it('展开 → 收起是反向的，回到原来的位置', () => {
    const expanded = petBounds(collapsed, true);
    expect(petBounds(expanded, false)).toEqual(collapsed);
  });

  it('球心在两个状态下是同一个点', () => {
    const expanded = petBounds(collapsed, true);
    expect(ballCenter(expanded)).toEqual(ballCenter(collapsed));
  });

  it('反复展开收起不会漂移', () => {
    let rect: Rect = collapsed;
    for (let i = 0; i < 20; i += 1) rect = petBounds(rect, i % 2 === 0);
    expect(ballCenter(rect)).toEqual(ballCenter(collapsed));
  });
});

describe('moveBy', () => {
  it('增量累加到窗口位置，尺寸不变', () => {
    const out = moveBy({ x: 100, y: 100, ...PET_COLLAPSED }, -7, 13);
    expect(out).toEqual({ x: 93, y: 113, ...PET_COLLAPSED });
  });
});

describe('snapToEdges', () => {
  it('阈值是 16 px', () => {
    expect(SNAP_PX).toBe(16);
  });

  it('左边距 ≤ 16 px 时贴左', () => {
    expect(snapToEdges({ x: 12, y: 400, ...PET_COLLAPSED }, WORK).x).toBe(WORK.x);
  });

  it('右边距 ≤ 16 px 时贴右', () => {
    const x = WORK.x + WORK.width - PET_COLLAPSED.width - 10;
    expect(snapToEdges({ x, y: 400, ...PET_COLLAPSED }, WORK).x).toBe(
      WORK.x + WORK.width - PET_COLLAPSED.width
    );
  });

  it('上下两边同理，且工作区不是从 0 开始也对', () => {
    expect(snapToEdges({ x: 400, y: 30, ...PET_COLLAPSED }, WORK).y).toBe(WORK.y);
    const y = WORK.y + WORK.height - PET_COLLAPSED.height - 3;
    expect(snapToEdges({ x: 400, y, ...PET_COLLAPSED }, WORK).y).toBe(
      WORK.y + WORK.height - PET_COLLAPSED.height
    );
  });

  it('离边缘超过 16 px 就不动它', () => {
    const rect = { x: 400, y: 400, ...PET_COLLAPSED };
    expect(snapToEdges(rect, WORK)).toEqual(rect);
  });
});

describe('clampToWorkArea', () => {
  it('至少 48 px 留在屏幕内', () => {
    expect(MIN_VISIBLE_PX).toBe(48);
    const left = clampToWorkArea({ x: -5000, y: 400, ...PET_COLLAPSED }, WORK);
    expect(left.x + PET_COLLAPSED.width).toBe(WORK.x + MIN_VISIBLE_PX);

    const right = clampToWorkArea({ x: 99999, y: 400, ...PET_COLLAPSED }, WORK);
    expect(right.x).toBe(WORK.x + WORK.width - MIN_VISIBLE_PX);
  });

  it('上下同理', () => {
    const up = clampToWorkArea({ x: 400, y: -9999, ...PET_COLLAPSED }, WORK);
    expect(up.y + PET_COLLAPSED.height).toBe(WORK.y + MIN_VISIBLE_PX);
    const down = clampToWorkArea({ x: 400, y: 99999, ...PET_COLLAPSED }, WORK);
    expect(down.y).toBe(WORK.y + WORK.height - MIN_VISIBLE_PX);
  });

  it('在工作区内的原样放行', () => {
    const rect = { x: 400, y: 400, ...PET_COLLAPSED };
    expect(clampToWorkArea(rect, WORK)).toEqual(rect);
  });
});

describe('settle', () => {
  it('拖出屏幕外松手：先钳回来留 48 px，钳回后离边还有 152 px，不再吸附', () => {
    const out = settle({ x: -3000, y: 400, ...PET_COLLAPSED }, WORK);
    expect(out.x + PET_COLLAPSED.width).toBe(WORK.x + MIN_VISIBLE_PX);
    expect(out.x).toBe(-152);
  });

  it('拖到差一点点贴边时吸附生效', () => {
    const out = settle({ x: WORK.x + 9, y: WORK.y + 9, ...PET_COLLAPSED }, WORK);
    expect(out).toMatchObject({ x: WORK.x, y: WORK.y });
  });
});

describe('defaultPetBounds', () => {
  it('右下角，距工作区右边与下边各 24 px', () => {
    expect(DEFAULT_MARGIN_PX).toBe(24);
    const out = defaultPetBounds(WORK);
    expect(out.x + out.width).toBe(WORK.x + WORK.width - 24);
    expect(out.y + out.height).toBe(WORK.y + WORK.height - 24);
    expect(out.width).toBe(PET_COLLAPSED.width);
  });

  it('展开态下用展开后的尺寸算', () => {
    const out = defaultPetBounds(WORK, true);
    expect(out.width).toBe(PET_EXPANDED.width);
    expect(out.x + out.width).toBe(WORK.x + WORK.width - 24);
  });
});

describe('restorePetBounds', () => {
  it('没存过位置时用默认位置', () => {
    expect(restorePetBounds(null, WORK)).toEqual(defaultPetBounds(WORK));
  });

  it('存过的位置照用', () => {
    expect(restorePetBounds({ x: 300, y: 200 }, WORK)).toMatchObject({ x: 300, y: 200 });
  });

  it('换了显示器、旧位置落在屏幕外时钳回来', () => {
    const out = restorePetBounds({ x: 9999, y: 9999 }, WORK);
    expect(out.x).toBe(WORK.x + WORK.width - MIN_VISIBLE_PX);
    expect(out.y).toBe(WORK.y + WORK.height - MIN_VISIBLE_PX);
  });
});
