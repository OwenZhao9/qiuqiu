/** 桌宠窗口的几何。数值逐条对着 `design/interaction.md` § 1。 */

import { describe, expect, it } from 'vitest';
import {
  ballCenter,
  clampToWorkArea,
  defaultPetBounds,
  DEFAULT_MARGIN_PX,
  MIN_VISIBLE_PX,
  moveBy,
  gazeDelta,
  petBounds,
  petSize,
  PET_BALL,
  PET_BLEED,
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
  it('收起 256 × 256：丘丘 200 加四周各 28 的投影与倾斜余量', () => {
    // 窗口不能跟丘丘一样大——透明窗口 overflow: hidden，落地投影会被四条边
    // 裁成直线；而把投影删掉丘丘又变成一张贴纸。所以留地方，不删投影
    expect(PET_BALL).toBe(200);
    expect(PET_BLEED).toBe(28);
    expect(PET_COLLAPSED).toEqual({ width: 256, height: 256 });
  });

  it('展开 336 × 304：高度多出间隙 8 加输入条 40', () => {
    expect(PET_EXPANDED).toEqual({ width: 336, height: 304 });
    expect(PET_EXPANDED.height - PET_COLLAPSED.height).toBe(48);
  });
});

describe('petBounds · 球心不动', () => {
  const collapsed = { x: 400, y: 300, ...PET_COLLAPSED };
  const shut = { expanded: false, bubble: 0 };
  const open = { expanded: true, bubble: 0 };

  it('收起 → 展开：宽 256 → 336、高 +48（间隙 + 输入条），球心不动', () => {
    const out = petBounds(collapsed, shut, open);
    expect(out.width).toBe(336);
    expect(out.height - collapsed.height).toBe(48);
    expect(out.x).toBe(collapsed.x - (336 - 256) / 2);
    expect(out.y, '往下长，y 不动').toBe(collapsed.y);
  });

  it('展开 → 收起是反向的，回到原来的位置', () => {
    const expanded = petBounds(collapsed, shut, open);
    expect(petBounds(expanded, open, shut)).toEqual(collapsed);
  });

  it('球心在两个状态下是同一个点', () => {
    const expanded = petBounds(collapsed, shut, open);
    expect(ballCenter(expanded, open)).toEqual(ballCenter(collapsed, shut));
  });

  it('反复展开收起不会漂移', () => {
    let rect: Rect = collapsed;
    let at = shut;
    for (let i = 0; i < 20; i += 1) {
      const to = i % 2 === 0 ? open : shut;
      rect = petBounds(rect, at, to);
      at = to;
    }
    expect(ballCenter(rect, at)).toEqual(ballCenter(collapsed, shut));
  });

  it('气泡出现时窗口往上长，球心还是不动', () => {
    // 这是气泡看不见的那个 bug：窗口只有 200 高、丘丘占满，
    // 气泡钉在丘丘上方就整块在窗口外，只在顶边露出一条
    const withBubble = { expanded: false, bubble: 44 };
    const out = petBounds(collapsed, shut, withBubble);
    expect(out.height, '高度要长出气泡加 8 px 间隙').toBe(256 + 44 + 8);
    expect(out.y, '往上长，所以 y 要减掉同样多').toBe(collapsed.y - 52);
    expect(ballCenter(out, withBubble)).toEqual(ballCenter(collapsed, shut));
  });

  it('气泡换行数变了跟着改，球心仍然不动', () => {
    const one = { expanded: false, bubble: 22 };
    const three = { expanded: false, bubble: 66 };
    const a = petBounds(collapsed, shut, one);
    const b = petBounds(a, one, three);
    expect(b.height - a.height).toBe(44);
    expect(ballCenter(b, three)).toEqual(ballCenter(collapsed, shut));
  });

  it('气泡没了就把那块地方收回去', () => {
    const withBubble = { expanded: false, bubble: 44 };
    const grown = petBounds(collapsed, shut, withBubble);
    expect(petBounds(grown, withBubble, shut)).toEqual(collapsed);
  });

  it('气泡与输入条同时在，两块都算上', () => {
    const both = { expanded: true, bubble: 44 };
    const out = petBounds(collapsed, shut, both);
    expect(out.height).toBe(304 + 44 + 8);
    expect(ballCenter(out, both)).toEqual(ballCenter(collapsed, shut));
  });
});

describe('petSize', () => {
  it('没气泡就不留那 8 px 间隙', () => {
    expect(petSize({ expanded: false, bubble: 0 })).toEqual({
      width: 256,
      height: 256,
      above: 0
    });
  });

  it('有气泡才加间隙，高度向上取整', () => {
    expect(petSize({ expanded: false, bubble: 43.2 })).toEqual({
      width: 256,
      height: 308,
      above: 52
    });
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
  it('拖出屏幕外松手：先钳回来留 48 px，再不吸附', () => {
    const out = settle({ x: -3000, y: 400, ...PET_COLLAPSED }, WORK);
    expect(out.x + PET_COLLAPSED.width).toBe(WORK.x + MIN_VISIBLE_PX);
    expect(out.x).toBe(MIN_VISIBLE_PX - PET_COLLAPSED.width);
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

describe('gazeDelta · 眼神跟随', () => {
  const rect = { x: 400, y: 300, ...PET_COLLAPSED };
  const shut = { expanded: false, bubble: 0 };
  // 球心 **不是窗口中心**：窗口上边有 PET_BLEED 的投影余量
  const cx = 400 + PET_COLLAPSED.width / 2;
  const cy = 300 + PET_BLEED + PET_BALL / 2;

  it('光标正压在球心时偏移是 0', () => {
    expect(gazeDelta(rect, shut, { x: cx, y: cy })).toEqual({ dx: 0, dy: 0 });
  });

  it('右下方的光标给出正的 dx / dy', () => {
    expect(gazeDelta(rect, shut, { x: cx + 400, y: cy + 300 })).toEqual({ dx: 400, dy: 300 });
  });

  it('左上方的光标给出负的', () => {
    expect(gazeDelta(rect, shut, { x: cx - 400, y: cy - 300 })).toEqual({ dx: -400, dy: -300 });
  });

  it('气泡把窗口撑高之后，球心跟着走，偏移仍然对着球', () => {
    // 这一条是气泡那个 bug 的连带：球在窗口里的位置随气泡变，
    // 用窗口中心算注视就会越偏越多
    const withBubble = { expanded: false, bubble: 44 };
    const grown = petBounds(rect, shut, withBubble);
    expect(gazeDelta(grown, withBubble, { x: cx, y: cy })).toEqual({ dx: 0, dy: 0 });
  });

  it('展开输入条不影响球心，注视也不受影响', () => {
    const open = { expanded: true, bubble: 0 };
    const wide = petBounds(rect, shut, open);
    expect(gazeDelta(wide, open, { x: cx, y: cy })).toEqual({ dx: 0, dy: 0 });
  });
});
