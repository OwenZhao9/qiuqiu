/**
 * 平台适配层。
 *
 * `design/interaction.md` § 4 的硬约束：网页端必须有一个签名完全一致的实现，
 * 组件永远只面对这一个接口。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryBridge, getBridge, setBridgeForTest, isDesktop } from '../src/bridge.js';

/** 契约 § 2 逐字列出的十二个成员。 */
const CONTRACT_MEMBERS = [
  'openMain',
  'hideMain',
  'hidePet',
  'resetPet',
  'focusPet',
  'quit',
  'dragPet',
  'forwardDelta',
  'forwardDone',
  'setPetState',
  'submitFromPet',
  'onDelta',
  'onPetState'
] as const;

afterEach(() => {
  setBridgeForTest(null);
  delete (globalThis as { qiuqiu?: unknown }).qiuqiu;
});

describe('createMemoryBridge', () => {
  it('契约 § 2 的每个成员都有，且都是函数', () => {
    const b = createMemoryBridge() as unknown as Record<string, unknown>;
    for (const key of CONTRACT_MEMBERS) {
      expect(typeof b[key], key).toBe('function');
    }
  });

  it('forwardDelta / forwardDone 走内存总线，同页订阅者收得到', () => {
    const b = createMemoryBridge();
    const deltas: Array<[string, string]> = [];
    const dones: string[] = [];
    b.onDelta((s, t) => deltas.push([s, t]));
    b.onDone((s) => dones.push(s));
    b.forwardDelta('s1', '你');
    b.forwardDelta('s1', '好');
    b.forwardDone('s1');
    expect(deltas).toEqual([
      ['s1', '你'],
      ['s1', '好']
    ]);
    expect(dones).toEqual(['s1']);
  });

  it('setPetState 与 submitFromPet 也在总线上', () => {
    const b = createMemoryBridge();
    const states: Array<[string, string | undefined]> = [];
    const texts: string[] = [];
    b.onPetState((s, e) => states.push([s, e]));
    b.onSubmitFromPet((t) => texts.push(t));
    b.setPetState('thinking');
    b.setPetState('speaking', '39');
    b.submitFromPet('从桌宠发的');
    expect(states).toEqual([
      ['thinking', undefined],
      ['speaking', '39']
    ]);
    expect(texts).toEqual(['从桌宠发的']);
  });

  it('窗口相关的方法在网页端是 no-op，不抛', () => {
    const b = createMemoryBridge();
    expect(() => {
      b.openMain();
      b.hideMain();
      b.hidePet();
      b.resetPet();
      b.focusPet();
      b.quit();
      b.dragPet(3, 4);
      b.setPetPassthrough(true);
      b.setPetExpanded(true);
      b.popupPetMenu({ ambientPaused: false });
    }).not.toThrow();
  });
});

describe('getBridge', () => {
  it('没有 window.qiuqiu 时退到内存总线，platform 是 web', () => {
    expect(getBridge().platform()).toBe('web');
    expect(isDesktop()).toBe(false);
  });

  it('有 window.qiuqiu 时用它，缺的扩展方法补成 no-op', () => {
    const setPetState = vi.fn();
    const forwardDelta = vi.fn();
    // 只实现契约 § 2 的一部分，扩展方法一个都不给
    (globalThis as { qiuqiu?: unknown }).qiuqiu = { setPetState, forwardDelta };
    const b = getBridge();
    expect(b.platform()).toBe('desktop');
    b.setPetState('idle');
    b.forwardDelta('s', 'x');
    expect(setPetState).toHaveBeenCalledWith('idle');
    expect(forwardDelta).toHaveBeenCalledWith('s', 'x');
    expect(() => b.setPetPassthrough(false)).not.toThrow();
  });
});
