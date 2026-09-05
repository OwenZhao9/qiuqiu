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
  /** 退订。`ipcRenderer` 本来就有，之前没用上——于是监听只增不减。 */
  removeListener?(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** 订阅返回的退订函数。组件在 effect 的清理里调它。 */
export type Unsubscribe = () => void;

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
  forwardReply(sessionId: string, text: string): void;
  forwardDone(sessionId: string): void;
  setPetState(state: PetState, emotionId?: string): void;
  submitFromPet(text: string): void;
  callFromPet(): void;
  onReply(cb: (sessionId: string, text: string) => void): Unsubscribe;
  onPetState(cb: (state: string, emotionId?: string) => void): Unsubscribe;
}

/**
 * 契约 § 2 之外、界面必须有的六件事。逐条写进最终报告的缺口清单：
 * `forwardDone` 与 `submitFromPet` 在契约里有发无收，而透明窗口的鼠标穿透、
 * 桌宠展开时改窗口 bounds、原生右键菜单、全局快捷键的落点根本没有入口。
 */
export interface QiuqiuBridgeExt extends QiuqiuBridge {
  onDone(cb: (sessionId: string) => void): Unsubscribe;
  onSubmitFromPet(cb: (text: string) => void): Unsubscribe;
  /** 主窗口接住桌宠按的通话和弦。会话只跑在主窗口。 */
  onCallFromPet(cb: () => void): Unsubscribe;
  /** 换皮肤。两个窗口是两个渲染进程，各有各的 localStorage 事件，只能过主进程同步。 */
  setSkin(skin: string): void;
  /**
   * 气泡量出来有多高。窗口是透明无边框的，画在窗口外面的一律被裁掉，
   * 所以气泡出现时窗口得先在丘丘上方长出这么一块。0 表示没有气泡。
   */
  setPetBubble(height: number): void;
  /**
   * 主窗口的渲染进程已经挂好监听、可以收消息了。
   *
   * 桌宠发话时主窗口可能刚被 `ensureMain()` 建出来，渲染进程还没跑起来，
   * 这时候 `webContents.send` 是丢的。主进程攒着，等这一声再发。
   */
  mainReady(): void;
  /**
   * 用户动了桌宠（点、拖、展开输入条）。
   *
   * 闲置计时开在主窗口（AD-5b），主窗口看不见这些动作——不报的话，人正玩着
   * 桌宠，丘丘却按主窗口的计时器睡过去了。
   */
  pokePet(): void;
  /** `setSkin` 的订阅端。**收到之后只应用不再广播**，否则两个窗口会来回弹。 */
  onSkin(cb: (skin: string) => void): Unsubscribe;
  /**
   * 光标相对球心的偏移，屏幕像素，由主进程轮询系统光标推下来。
   *
   * 桌宠窗口鼠标穿透且只有 200 px，渲染进程只在光标压在丘丘身上时才收得到
   * `pointermove`，所以「眼神跟随」这件事桌宠自己做不到。
   */
  onPetGaze(cb: (dx: number, dy: number) => void): Unsubscribe;
  /** `pokePet` 的订阅端。主窗口收到就复位自己那只丘丘的闲置计时。 */
  onPoke(cb: () => void): Unsubscribe;
  setPetPassthrough(ignore: boolean): void;
  setPetExpanded(expanded: boolean): void;
  popupPetMenu(state: { ambientPaused: boolean }): void;
  onPetFocus(cb: () => void): Unsubscribe;
  onAmbientToggle(cb: (paused: boolean) => void): Unsubscribe;
  platform(): 'desktop';
}

export function createQiuqiuBridge(ipc: IpcLike): QiuqiuBridgeExt {
  const send =
    (channel: string) =>
    (...args: unknown[]): void => {
      ipc.send(channel, ...args);
    };

  /**
   * 订一条通道，返回退订函数。
   *
   * **必须能退订。** React 的 effect 在开发模式（StrictMode）下会跑两遍，
   * 组件重挂也会再订一次；只订不退的话监听越攒越多，一条 delta 被拼进气泡
   * 好几遍——桌宠的回复就变成「好好问题问题！！」那样每个字重复。
   */
  const sub =
    (channel: string) =>
    (handler: (...args: unknown[]) => void): Unsubscribe => {
      const listener = (_e: unknown, ...args: unknown[]): void => handler(...args);
      ipc.on(channel, listener);
      return () => void ipc.removeListener?.(channel, listener);
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
    forwardReply(sessionId, text) {
      ipc.send(TO_MAIN.forwardReply, sessionId, text);
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
    setPetBubble(height) {
      ipc.send(TO_MAIN.setPetBubble, height);
    },
    mainReady() {
      ipc.send(TO_MAIN.mainReady);
    },
    pokePet() {
      ipc.send(TO_MAIN.pokePet);
    },

    onReply(cb) {
      return sub(TO_RENDERER.reply)((sessionId, text) => cb(String(sessionId), String(text)));
    },
    onDone(cb) {
      return sub(TO_RENDERER.done)((sessionId) => cb(String(sessionId)));
    },
    onPetState(cb) {
      return sub(TO_RENDERER.petState)((state, emotionId) =>
        cb(String(state), emotionId === undefined ? undefined : String(emotionId))
      );
    },
    onSubmitFromPet(cb) {
      return sub(TO_RENDERER.submitFromPet)((text) => cb(String(text)));
    },
    onCallFromPet(cb) {
      return sub(TO_RENDERER.callFromPet)(() => cb());
    },
    onPetFocus(cb) {
      return sub(TO_RENDERER.petFocus)(() => cb());
    },
    onAmbientToggle(cb) {
      return sub(TO_RENDERER.ambientToggle)((paused) => cb(Boolean(paused)));
    },
    onSkin(cb) {
      return sub(TO_RENDERER.skin)((skin) => cb(String(skin)));
    },
    onPetGaze(cb) {
      return sub(TO_RENDERER.petGaze)((dx, dy) => cb(Number(dx), Number(dy)));
    },
    onPoke(cb) {
      return sub(TO_RENDERER.poke)(() => cb());
    },

    platform: () => 'desktop'
  };
}
