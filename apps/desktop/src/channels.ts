/**
 * IPC 通道名。主进程与 preload 共用这一份，避免两边各写一遍字符串。
 *
 * 语义对着 `docs/CONTRACTS.md` § 2 的 `QiuqiuBridge`：
 * 渲染进程 → 主进程用 `send`，主进程 → 渲染进程用 `on`。
 */

/** 渲染进程发给主进程的。 */
export const TO_MAIN = {
  openMain: 'qq:open-main',
  hideMain: 'qq:hide-main',
  hidePet: 'qq:hide-pet',
  resetPet: 'qq:reset-pet',
  focusPet: 'qq:focus-pet',
  quit: 'qq:quit',
  dragPet: 'qq:drag-pet',
  forwardReply: 'qq:forward-reply',
  forwardDone: 'qq:forward-done',
  setPetState: 'qq:set-pet-state',
  submitFromPet: 'qq:submit-from-pet',
  callFromPet: 'qq:call-from-pet',
  // 契约 § 2 之外、界面必须有的四件事，见 apps/web/src/bridge.ts 的注释
  setPetPassthrough: 'qq:set-pet-passthrough',
  setPetExpanded: 'qq:set-pet-expanded',
  popupPetMenu: 'qq:popup-pet-menu',
  setSkin: 'qq:set-skin',
  setPetBubble: 'qq:set-pet-bubble',
  mainReady: 'qq:main-ready'
} as const;

/** 主进程推给渲染进程的。 */
export const TO_RENDERER = {
  reply: 'qq:on-reply',
  done: 'qq:on-done',
  petState: 'qq:on-pet-state',
  submitFromPet: 'qq:on-submit-from-pet',
  callFromPet: 'qq:on-call-from-pet',
  petFocus: 'qq:on-pet-focus',
  ambientToggle: 'qq:on-ambient-toggle',
  skin: 'qq:on-skin',
  petGaze: 'qq:on-pet-gaze'
} as const;

export type ToMainChannel = (typeof TO_MAIN)[keyof typeof TO_MAIN];
export type ToRendererChannel = (typeof TO_RENDERER)[keyof typeof TO_RENDERER];
