/**
 * `window.qiuqiu` 的实现，签名严格按 `docs/CONTRACTS.md` § 2。
 *
 * 抽成工厂是为了能在 vitest 里喂一个假的 ipcRenderer 做契约测试——
 * `preload.ts` 只负责把真的 `ipcRenderer` 递进来再 `contextBridge.exposeInMainWorld`。
 */

import { TO_MAIN, TO_RENDERER } from './channels.js';

export interface IpcLike {
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

export type PetState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** 契约 § 2 的十三个成员，逐字一致。 */
export interface QiuqiuBridge {
  openMain(): void;
  hideMain(): void;
  hidePet(): void;
  resetPet(): void;
  focusPet(): void;
  quit(): void;
  dragPet(dx: number, dy: number): void;
  forwardDelta(sessionId: string, text: string): void;
  forwardDone(sessionId: string): void;
  setPetState(state: PetState, emotionId?: string): void;
  submitFromPet(text: string): void;
  callFromPet(): void;
  onDelta(cb: (sessionId: string, text: string) => void): void;
  onPetState(cb: (state: string, emotionId?: string) => void): void;
}

/**
 * 契约 § 2 之外、界面必须有的六件事。逐条写进最终报告的缺口清单：
 * `forwardDone` 与 `submitFromPet` 在契约里有发无收，而透明窗口的鼠标穿透、
 * 桌宠展开时改窗口 bounds、原生右键菜单、全局快捷键的落点根本没有入口。
 */
export interface QiuqiuBridgeExt extends QiuqiuBridge {
  onDone(cb: (sessionId: string) => void): void;
  onSubmitFromPet(cb: (text: string) => void): void;
  /** 主窗口接住桌宠按的通话和弦。会话只跑在主窗口。 */
  onCallFromPet(cb: () => void): void;
  /** 换皮肤。两个窗口是两个渲染进程，各有各的 localStorage 事件，只能过主进程同步。 */
  setSkin(skin: string): void;
  /** `setSkin` 的订阅端。**收到之后只应用不再广播**，否则两个窗口会来回弹。 */
  onSkin(cb: (skin: string) => void): void;
  setPetPassthrough(ignore: boolean): void;
  setPetExpanded(expanded: boolean): void;
  popupPetMenu(state: { ambientPaused: boolean }): void;
  onPetFocus(cb: () => void): void;
  onAmbientToggle(cb: (paused: boolean) => void): void;
  platform(): 'desktop';
}

export function createQiuqiuBridge(ipc: IpcLike): QiuqiuBridgeExt {
  const send =
    (channel: string) =>
    (...args: unknown[]): void => {
      ipc.send(channel, ...args);
    };

  return {
    openMain: send(TO_MAIN.openMain),
    hideMain: send(TO_MAIN.hideMain),
    hidePet: send(TO_MAIN.hidePet),
    resetPet: send(TO_MAIN.resetPet),
    focusPet: send(TO_MAIN.focusPet),
    quit: send(TO_MAIN.quit),

    dragPet(dx, dy) {
      ipc.send(TO_MAIN.dragPet, dx, dy);
    },
    forwardDelta(sessionId, text) {
      ipc.send(TO_MAIN.forwardDelta, sessionId, text);
    },
    forwardDone(sessionId) {
      ipc.send(TO_MAIN.forwardDone, sessionId);
    },
    setPetState(state, emotionId) {
      ipc.send(TO_MAIN.setPetState, state, emotionId);
    },
    submitFromPet(text) {
      ipc.send(TO_MAIN.submitFromPet, text);
    },
    callFromPet() {
      ipc.send(TO_MAIN.callFromPet);
    },
    setPetPassthrough(ignore) {
      ipc.send(TO_MAIN.setPetPassthrough, ignore);
    },
    setPetExpanded(expanded) {
      ipc.send(TO_MAIN.setPetExpanded, expanded);
    },
    popupPetMenu(state) {
      ipc.send(TO_MAIN.popupPetMenu, state);
    },
    setSkin(skin) {
      ipc.send(TO_MAIN.setSkin, skin);
    },

    onDelta(cb) {
      ipc.on(TO_RENDERER.delta, (_e, sessionId, text) => cb(String(sessionId), String(text)));
    },
    onDone(cb) {
      ipc.on(TO_RENDERER.done, (_e, sessionId) => cb(String(sessionId)));
    },
    onPetState(cb) {
      ipc.on(TO_RENDERER.petState, (_e, state, emotionId) =>
        cb(String(state), emotionId === undefined ? undefined : String(emotionId))
      );
    },
    onSubmitFromPet(cb) {
      ipc.on(TO_RENDERER.submitFromPet, (_e, text) => cb(String(text)));
    },
    onCallFromPet(cb) {
      ipc.on(TO_RENDERER.callFromPet, () => cb());
    },
    onPetFocus(cb) {
      ipc.on(TO_RENDERER.petFocus, () => cb());
    },
    onAmbientToggle(cb) {
      ipc.on(TO_RENDERER.ambientToggle, (_e, paused) => cb(Boolean(paused)));
    },
    onSkin(cb) {
      ipc.on(TO_RENDERER.skin, (_e, skin) => cb(String(skin)));
    },

    platform: () => 'desktop'
  };
}
