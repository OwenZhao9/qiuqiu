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
  onDelta(cb: (sessionId: string, text: string) => void): void;
  onPetState(cb: (state: string, emotionId?: string) => void): void;
}

/**
 * 契约 § 2 之外、界面必须有的几件事。**都是契约缺口**，逐条写进最终报告：
 * `forwardDone` 与 `submitFromPet` 有发无收，透明窗口的鼠标穿透、
 * 桌宠展开时的窗口改尺寸、原生右键菜单、全局快捷键的落点在契约里都没有入口。
 */
export interface QiuqiuBridgeExt extends QiuqiuBridge {
  /** `forwardDone` 的订阅端。桌宠气泡靠它决定什么时候开始 6 s 倒计时。 */
  onDone(cb: (sessionId: string) => void): void;
  /** `submitFromPet` 的订阅端。主窗口靠它接住桌宠发出的那句话。 */
  onSubmitFromPet(cb: (text: string) => void): void;
  /** `callFromPet` 的订阅端。主窗口靠它接住桌宠按的通话和弦。 */
  onCallFromPet(cb: () => void): void;
  /** 指针落在丘丘实心轮廓或输入条上时关掉穿透（`design/interaction.md` § 1）。 */
  setPetPassthrough(ignore: boolean): void;
  /** 输入条展开 / 收起，主进程改窗口 bounds 且保持球心不动。 */
  setPetExpanded(expanded: boolean): void;
  /** 桌宠右键菜单，必须是 Electron 原生菜单——HTML 菜单会被透明窗口边界裁掉。 */
  popupPetMenu(state: { ambientPaused: boolean }): void;
  /** 全局快捷键 `Cmd/Ctrl+Shift+Q` 唤起桌宠时通知渲染进程展开输入条。 */
  onPetFocus(cb: () => void): void;
  /** 托盘 / 右键菜单里的「暂停被动采集」。 */
  onAmbientToggle(cb: (paused: boolean) => void): void;
  /** `'desktop'` 或 `'web'`。**只给适配层与 CSS 用，组件不读**。 */
  platform(): 'desktop' | 'web';
}

type Listener = (...args: unknown[]) => void;

/** 极小的发布订阅，网页端与桌宠共用。 */
function createEmitter() {
  const map = new Map<string, Set<Listener>>();
  return {
    on(topic: string, cb: Listener): void {
      const set = map.get(topic) ?? new Set<Listener>();
      set.add(cb);
      map.set(topic, set);
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
    onDelta(cb) {
      bus.on('delta', cb as Listener);
    },
    onDone(cb) {
      bus.on('done', cb as Listener);
    },
    onPetState(cb) {
      bus.on('pet-state', cb as Listener);
    },
    onSubmitFromPet(cb) {
      bus.on('submit-from-pet', cb as Listener);
    },
    onCallFromPet(cb) {
      bus.on('call-from-pet', cb as Listener);
    },
    onPetFocus(cb) {
      bus.on('pet-focus', cb as Listener);
    },
    onAmbientToggle(cb) {
      bus.on('ambient-toggle', cb as Listener);
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
