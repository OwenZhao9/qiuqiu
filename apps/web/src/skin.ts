/**
 * 皮肤切换。挂 `<html data-skin>`，`design/tokens.css` 里按这个属性覆盖令牌。
 *
 * 只换令牌，不碰组件：加皮肤不需要动组件代码。
 *
 * 一个例外是丘丘本身：它是 SVG 不是 DOM，CSS 令牌管不到。所以每个皮肤额外
 * 声明一个 `look`，交给 `@qiuqiu/character` 换球的配色与装扮
 * （`packages/character/src/theme.ts` 与 `costume.ts`）。
 *
 * 选择存 `localStorage`，纯本地界面偏好，不占后端的 `settings`
 * （契约 v0.1.10 第 20 条：纯本地 UI 状态不进后端）。
 */

import type { CharacterLook } from '@qiuqiu/character';
import { getBridge } from './bridge.js';

export type Skin = 'default' | 'kawaii' | 'anime';

export interface SkinDef {
  id: Skin;
  label: string;
  blurb: string;
  /** 这个皮肤下丘丘长什么样。 */
  look: CharacterLook;
}

export const SKINS: SkinDef[] = [
  { id: 'default', label: '素净', blurb: '暖棕米色，安静耐看', look: 'warm' },
  { id: 'kawaii', label: '卡哇伊', blurb: '草莓粉，圆角更大', look: 'warm' },
  { id: 'anime', label: '二次元', blurb: '樱粉紫瞳，丘丘会戴蝴蝶结', look: 'anime' }
];

const KEY = 'qiuqiu.skin';

/** 皮肤变了会在 window 上派这个事件，挂着丘丘的组件据此换形象。 */
export const SKIN_EVENT = 'qiuqiu:skin';

function isSkin(v: unknown): v is Skin {
  return SKINS.some((s) => s.id === v);
}

export function readSkin(): Skin {
  try {
    const v = localStorage.getItem(KEY);
    return isSkin(v) ? v : 'default';
  } catch {
    // 无痕窗口或禁了站点数据，退回默认，别让整页挂掉
    return 'default';
  }
}

/** 某个皮肤下丘丘的形象。 */
export function lookOf(skin: Skin): CharacterLook {
  return SKINS.find((s) => s.id === skin)?.look ?? 'warm';
}

/**
 * @param broadcast 是否告诉另一个窗口。收到别人的通知而应用时必须传 `false`，
 *                  否则两个窗口会互相通知，绕不完。
 */
export function applySkin(skin: Skin, broadcast = true): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (skin === 'default') root.removeAttribute('data-skin');
  else root.setAttribute('data-skin', skin);
  try {
    localStorage.setItem(KEY, skin);
  } catch {
    /* 存不下就只在本次生效 */
  }
  // 丘丘不在 DOM 里，CSS 变量传不到它身上，只能在本页广播
  globalThis.dispatchEvent?.(new CustomEvent(SKIN_EVENT, { detail: skin }));
  // 桌面端还要过主进程通知另一个窗口——两个渲染进程互相看不见对方的 localStorage
  if (broadcast) {
    try {
      getBridge().setSkin(skin);
    } catch {
      /* 桥还没装好（模块加载顺序），本页照样生效 */
    }
  }
}

/** 页面一加载就应用，避免先闪一下默认皮肤再跳成二次元。 */
export function initSkin(): void {
  // 初始化不广播：这是在读别人早就存好的值，没有新消息要告诉谁
  applySkin(readSkin(), false);
  getBridge().onSkin((skin) => {
    if (isSkin(skin)) applySkin(skin, false);
  });
}
