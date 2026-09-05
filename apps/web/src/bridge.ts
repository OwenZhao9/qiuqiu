/**
 * 平台适配层：把 `window.qiuqiu` 与网页端的内存事件总线抹平成同一个接口。
 *
 * `docs/CONTRACTS.md` § 2 定义了 `QiuqiuBridge`；`design/interaction.md` § 4 要求
 * 「网页端必须有一个签名完全一致的实现，哪怕方法体是空的」，且
 * 「组件不做平台判断，不允许出现 `if (isElectron)` 分支」。
 *
 * 于是：组件永远只面对 `getBridge()` 返回的这一个对象。
 */

import type { CharacterState } from '@qiuqiu/character';

/**
 * 订阅返回的退订函数。组件在 effect 的清理里调它。
 *
 * **不能只订不退。** React 的 effect 在开发模式（StrictMode）下会跑两遍，
 * 组件重挂也会再订一次；监听越攒越多，一条 delta 会被拼进气泡好几遍
 * ——桌宠的回复就变成每个字重复的样子。
 */
export type Unsubscribe = () => void;

/** 契约 § 2 逐字一致的十二个成员。 */
export interface QiuqiuBridge {
  openMain(): void;
  hideMain(): void;
  hidePet(): void;
  resetPet(): void;
  focusPet(): void;
  quit(): void;
  dragPet(dx: number, dy: number): void;
  /** 主窗口 → 桌宠：回复流转发（AD-5，主窗口是唯一 SSE 持有者）。 */
  forwardDelta(sessionId: string, text: string): void;
  forwardDone(sessionId: string): void;
  setPetState(state: CharacterState, emotionId?: string): void;
  /** 桌宠 → 主窗口：内联输入条提交。 */
  submitFromPet(text: string): void;
  /** 桌宠请求开 / 挂通话。桌宠不自己跑语音会话，交主窗口（AD-5）。 */
  callFromPet(): void;
  onDelta(cb: (sessionId: string, text: string) => void): Unsubscribe;
  onPetState(cb: (state: string, emotionId?: string) => void): Unsubscribe;
}

/**
 * 契约 § 2 之外、界面必须有的几件事。**都是契约缺口**，逐条写进最终报告：
 * `forwardDone` 与 `submitFromPet` 有发无收，透明窗口的鼠标穿透、
 * 桌宠展开时的窗口改尺寸、原生右键菜单、全局快捷键的落点在契约里都没有入口。
 */
export interface QiuqiuBridgeExt extends QiuqiuBridge {
  /** `forwardDone` 的订阅端。桌宠气泡靠它决定什么时候开始 6 s 倒计时。 */
  onDone(cb: (sessionId: string) => void): Unsubscribe;
  /** `submitFromPet` 的订阅端。主窗口靠它接住桌宠发出的那句话。 */
  onSubmitFromPet(cb: (text: string) => void): Unsubscribe;
  /** `callFromPet` 的订阅端。主窗口靠它接住桌宠按的通话和弦。 */
  onCallFromPet(cb: () => void): Unsubscribe;
  /** 指针落在丘丘实心轮廓或输入条上时关掉穿透（`design/interaction.md` § 1）。 */
  setPetPassthrough(ignore: boolean): void;
  /** 输入条展开 / 收起，主进程改窗口 bounds 且保持球心不动。 */
  setPetExpanded(expanded: boolean): void;
  /** 桌宠右键菜单，必须是 Electron 原生菜单——HTML 菜单会被透明窗口边界裁掉。 */
  popupPetMenu(state: { ambientPaused: boolean }): void;
  /** 全局快捷键 `Cmd/Ctrl+Shift+Q` 唤起桌宠时通知渲染进程展开输入条。 */
  onPetFocus(cb: () => void): Unsubscribe;
  /** 托盘 / 右键菜单里的「暂停被动采集」。 */
  onAmbientToggle(cb: (paused: boolean) => void): Unsubscribe;
  /**
   * 换皮肤。桌宠和主窗口是两个渲染进程，各自一份 `localStorage` 监听，
   * 只能过主进程同步，不然主窗口换了皮肤桌宠还是旧样子。
   */
  setSkin(skin: string): void;
  /** `setSkin` 的订阅端。**收到之后只应用不再广播**，否则两个窗口会来回弹。 */
  onSkin(cb: (skin: string) => void): Unsubscribe;
  /**
   * 气泡量出来有多高。透明窗口画在窗口外面的一律被裁掉，
   * 气泡出现时窗口得先在丘丘上方长出这么一块。0 表示没有气泡。
   */
  setPetBubble(height: number): void;
  /** 主窗口的渲染进程已经挂好监听。桌宠先发的话主进程攒着，等这一声再送。 */
  mainReady(): void;
  /**
   * 光标相对球心的偏移，屏幕像素，由主进程轮询系统光标推下来。
   *
   * 桌宠窗口鼠标穿透且只有 200 px，渲染进程只在光标压在丘丘身上时才收得到
   * `pointermove`——所以桌面上的「眼神跟随」桌宠自己做不到，只能这样喂。
   */
  onPetGaze(cb: (dx: number, dy: number) => void): Unsubscribe;
  /** `'desktop'` 或 `'web'`。**只给适配层与 CSS 用，组件不读**。 */
  platform(): 'desktop' | 'web';
}

type Listener = (...args: unknown[]) => void;

/** 极小的发布订阅，网页端与桌宠共用。 */
function createEmitter() {
  const map = new Map<string, Set<Listener>>();
  return {
    on(topic: string, cb: Listener): Unsubscribe {
      const set = map.get(topic) ?? new Set<Listener>();
      set.add(cb);
      map.set(topic, set);
      return () => void set.delete(cb);
    },
    emit(topic: string, ...args: unknown[]): void {
      const set = map.get(topic);
      if (!set) return;
      for (const cb of [...set]) cb(...args);
    },
    clear(): void {
      map.clear();
    }
  };
}

/**
 * 网页端的内存事件总线实现。
 *
 * 桌面端 `forwardDelta` 跨进程，网页端在同一个页面里，直接把消息投回给
 * 同页的订阅者——同一份状态机代码、同一条数据通路，只是搬运工换了人。
 */
export function createMemoryBridge(): QiuqiuBridgeExt {
  const bus = createEmitter();
  const noop = (): void => {};
  return {
    openMain: noop,
    hideMain: noop,
    hidePet: noop,
    resetPet: noop,
    focusPet: noop,
    quit: noop,
    dragPet: noop,
    setPetPassthrough: noop,
    setPetExpanded: noop,
    popupPetMenu: noop,
    forwardDelta(sessionId, text) {
      bus.emit('delta', sessionId, text);
    },
    forwardDone(sessionId) {
      bus.emit('done', sessionId);
    },
    setPetState(state, emotionId) {
      bus.emit('pet-state', state, emotionId);
    },
    submitFromPet(text) {
      bus.emit('submit-from-pet', text);
    },
    callFromPet() {
      bus.emit('call-from-pet');
    },
    setSkin(skin) {
      // 网页端只有一个页面，没有第二个窗口要同步，投回自己反而会绕回去
      void skin;
    },
    setPetBubble(height) {
      // 网页端丘丘嵌在页面里，气泡跟着页面排版走，没有窗口要改尺寸
      void height;
    },
    mainReady() {
      // 网页端只有一个页面，不存在「另一个窗口还没起来」
    },
    onDelta(cb) {
      return bus.on('delta', cb as Listener);
    },
    onDone(cb) {
      return bus.on('done', cb as Listener);
    },
    onPetState(cb) {
      return bus.on('pet-state', cb as Listener);
    },
    onSubmitFromPet(cb) {
      return bus.on('submit-from-pet', cb as Listener);
    },
    onCallFromPet(cb) {
      return bus.on('call-from-pet', cb as Listener);
    },
    onPetFocus(cb) {
      return bus.on('pet-focus', cb as Listener);
    },
    onAmbientToggle(cb) {
      return bus.on('ambient-toggle', cb as Listener);
    },
    onSkin(cb) {
      return bus.on('skin', cb as Listener);
    },
    onPetGaze(cb) {
      // 网页端丘丘嵌在页面里，document 上的 pointermove 就够，不需要这条
      return bus.on('pet-gaze', cb as Listener);
    },
    platform: () => 'web'
  };
}

declare global {
  // eslint-disable-next-line no-var
  var qiuqiu: Partial<QiuqiuBridgeExt> | undefined;
}

let cached: QiuqiuBridgeExt | null = null;

/** 缺失的扩展方法补成 no-op，组件调到不会炸。 */
function harden(raw: Partial<QiuqiuBridgeExt>): QiuqiuBridgeExt {
  const fallback = createMemoryBridge();
  const out = { ...fallback } as Record<string, unknown>;
  for (const key of Object.keys(fallback) as Array<keyof QiuqiuBridgeExt>) {
    const fn = raw[key];
    if (typeof fn === 'function') out[key] = (fn as (...a: unknown[]) => unknown).bind(raw);
  }
  if (typeof raw.platform !== 'function') out.platform = () => 'desktop';
  return out as unknown as QiuqiuBridgeExt;
}

/**
 * 拿到桥。有 `window.qiuqiu` 就用它（Electron），没有就退到内存总线（网页端）。
 * 同一个页面只解析一次。
 */
export function getBridge(): QiuqiuBridgeExt {
  if (cached) return cached;
  const raw = (globalThis as { qiuqiu?: Partial<QiuqiuBridgeExt> }).qiuqiu;
  cached = raw && typeof raw.setPetState === 'function' ? harden(raw) : createMemoryBridge();
  return cached;
}

/** 仅供测试：换掉当前的桥。 */
export function setBridgeForTest(bridge: QiuqiuBridgeExt | null): void {
  cached = bridge;
}

/** 桌面端还是网页端。**只有适配层与布局能读它，组件不读**（`design/interaction.md` § 4）。 */
export function isDesktop(): boolean {
  return getBridge().platform() === 'desktop';
}
