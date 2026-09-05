/**
 * 桌宠先说话、主窗口还没起来的那种情况。
 *
 * 这是「在气泡里打的字，网页上什么也没出现」的成因：`ensureMain()` 把窗口建
 * 出来了，但渲染进程要几百毫秒后才挂上监听，那之前 `webContents.send` 是丢的
 * ——不报错、不排队，两边都看不出发生过什么。
 */

import { describe, expect, it } from 'vitest';
import { createPetInbox } from '../src/pet-inbox.js';

describe('createPetInbox', () => {
  it('没就绪就攒着，报到之后按顺序全吐出来', () => {
    const box = createPetInbox();
    expect(box.hold('第一句'), '没就绪，调用方不该直接发').toBe(true);
    expect(box.hold('第二句')).toBe(true);
    expect(box.size()).toBe(2);
    expect(box.ready()).toEqual(['第一句', '第二句']);
    expect(box.size(), '吐完要清空，不然会重复发').toBe(0);
  });

  it('就绪之后不再拦，调用方直接发', () => {
    const box = createPetInbox();
    box.ready();
    expect(box.hold('直接发')).toBe(false);
    expect(box.size()).toBe(0);
  });

  it('渲染进程重新加载要回到未就绪', () => {
    const box = createPetInbox();
    box.ready();
    box.reset();
    expect(box.isReady()).toBe(false);
    expect(box.hold('热重载之后这句还得攒着')).toBe(true);
    expect(box.ready()).toEqual(['热重载之后这句还得攒着']);
  });

  it('报到两次不会把同一句发两遍', () => {
    const box = createPetInbox();
    box.hold('只发一次');
    expect(box.ready()).toEqual(['只发一次']);
    expect(box.ready()).toEqual([]);
  });

  it('攒满了丢最旧的，保住最近的几句', () => {
    const box = createPetInbox(3);
    for (const t of ['a', 'b', 'c', 'd', 'e']) box.hold(t);
    expect(box.ready()).toEqual(['c', 'd', 'e']);
  });
});
