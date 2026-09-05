/**
 * 皮肤切换。挂 `<html data-skin>`，`design/tokens.css` 里按这个属性覆盖令牌。
 *
 * **只换令牌，不碰组件**——所以加皮肤不需要动任何组件代码，
 * 这就是把颜色圆角抽成令牌的意义。
 *
 * 选择存 `localStorage`，纯本地界面偏好，不占后端的 `settings`
 * （契约 v0.1.10 第 20 条：纯本地 UI 状态不进后端）。
 */

export type Skin = 'default' | 'kawaii';

export const SKINS: { id: Skin; label: string; blurb: string }[] = [
  { id: 'default', label: '素净', blurb: '暖棕米色，安静耐看' },
  { id: 'kawaii', label: '卡哇伊', blurb: '草莓粉，圆角更大' }
];

const KEY = 'qiuqiu.skin';

export function readSkin(): Skin {
  try {
    return localStorage.getItem(KEY) === 'kawaii' ? 'kawaii' : 'default';
  } catch {
    // 无痕窗口或禁了站点数据，退回默认，别让整页挂掉
    return 'default';
  }
}

export function applySkin(skin: Skin): void {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  if (skin === 'default') root.removeAttribute('data-skin');
  else root.setAttribute('data-skin', skin);
  try {
    localStorage.setItem(KEY, skin);
  } catch {
    /* 存不下就只在本次生效 */
  }
}

/** 页面一加载就应用，避免先闪一下默认皮肤再跳成卡哇伊。 */
export function initSkin(): void {
  applySkin(readSkin());
}
