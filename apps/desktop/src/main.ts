/**
 * Electron 主进程。
 *
 * 两个窗口：主窗口（三栏）与桌宠窗口（透明、无边框、置顶）。
 *
 * **AD-5：主窗口是唯一 SSE 持有者。** 主进程在这里只当搬运工——
 * 主窗口来的 `forwardDelta` / `forwardDone` / `setPetState` 原样转给桌宠窗口，
 * 桌宠来的 `submitFromPet` 原样转给主窗口。主进程自己不发任何 HTTP 请求。
 *
 * 窗口几何、菜单内容都在 `geometry.ts` 与 `menus.ts` 里，是纯函数，另有单测。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
  type MenuItemConstructorOptions
} from 'electron';
import { TO_MAIN, TO_RENDERER } from './channels.js';
import {
  defaultPetBounds,
  MAIN_WINDOW,
  moveBy,
  petBounds,
  restorePetBounds,
  settle,
  type Area,
  type Rect
} from './geometry.js';
import { FOCUS_PET_ACCELERATOR, petContextMenu, trayMenu, type MenuItemSpec } from './menus.js';
import { TRAY_ICON_DATA_URL } from './tray-icon.js';

/** 开发时连 vite 的开发服务器，打包后加载 `apps/web/dist` 的产物。 */
const DEV_SERVER = process.env.QIUQIU_DEV_SERVER ?? '';
const WEB_DIST = join(__dirname, '../../web/dist');

let mainWindow: BrowserWindow | null = null;
let petWindow: BrowserWindow | null = null;

/**
 * 拖动时窗口的落点，自己记着，不每帧回头问系统。
 *
 * `getBounds()` 是一次同步的窗口查询，`setBounds()` 走的是带尺寸的完整重排；
 * 一秒上百次地这么来回，手已经停了窗口还在追。改成只记位置、只调
 * `setPosition`，一次移动一次系统调用。位置被别的路径改了（吸附、复位、
 * 展开输入条）就清空，下次拖动重新问一次。
 */
let dragAt: { x: number; y: number } | null = null;

/** `moved` 停下来多久算一次拖动结束。Electron 没有拖动结束事件，只能等它安静。 */
const SETTLE_DEBOUNCE_MS = 120;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let tray: Tray | null = null;
let petExpanded = false;
let ambientPaused = false;
let quitting = false;

/* ------------------------------------------------------------------ *
 * 桌宠位置的持久化
 *
 * 契约 § 1 里没有「存桌宠窗口位置」的路由，SQLite 的 settings 表归后端管，
 * 前端够不着（见报告的缺口清单）。本轮先写 userData 下的一个小 JSON。
 * ------------------------------------------------------------------ */

function statePath(): string {
  return join(app.getPath('userData'), 'pet-window.json');
}

function loadPetPosition(): { x: number; y: number } | null {
  try {
    const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as { x?: number; y?: number };
    if (typeof raw.x === 'number' && typeof raw.y === 'number') return { x: raw.x, y: raw.y };
  } catch {
    /* 第一次启动，没有这个文件 */
  }
  return null;
}

function savePetPosition(rect: Rect): void {
  try {
    writeFileSync(statePath(), JSON.stringify({ x: rect.x, y: rect.y }), 'utf8');
  } catch (err) {
    console.warn('[qiuqiu] 桌宠位置没存下来：', err);
  }
}

function workArea(): Area {
  return screen.getPrimaryDisplay().workArea;
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

function pageUrl(page: 'index' | 'pet'): string {
  return DEV_SERVER ? `${DEV_SERVER}/${page}.html` : join(WEB_DIST, `${page}.html`);
}

function loadPage(win: BrowserWindow, page: 'index' | 'pet'): void {
  const target = pageUrl(page);
  if (DEV_SERVER) void win.loadURL(target);
  else void win.loadFile(target);
}

const PRELOAD = join(__dirname, 'preload.js');

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: MAIN_WINDOW.width,
    height: MAIN_WINDOW.height,
    minWidth: MAIN_WINDOW.minWidth,
    minHeight: MAIN_WINDOW.minHeight,
    show: false,
    frame: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#FBF7F0',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: false }
  });
  loadPage(win, 'index');
  win.once('ready-to-show', () => win.show());
  // 托盘点击显隐：关窗只是藏起来，进程留着继续采集
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });
  return win;
}

function createPetWindow(): BrowserWindow {
  const bounds = restorePetBounds(loadPetPosition(), workArea(), petExpanded);
  const win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: false }
  });
  // screen-saver 层级：盖住普通窗口，也盖住全屏应用之外的一切
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 默认穿透，渲染进程判断指针落在实心轮廓上时再关掉（design/interaction.md § 1）
  win.setIgnoreMouseEvents(true, { forward: true });
  loadPage(win, 'pet');
  return win;
}

function showMain(): void {
  ensureMain();
  mainWindow?.show();
  mainWindow?.focus();
}

/**
 * 保证主窗口**存在**，但不弹出来、不抢焦点。
 *
 * 对话与语音会话都跑在主窗口（AD-5），所以桌宠说话时它必须活着；但那时候
 * 用户看的是桌宠气泡，把整个界面推到脸上是打断，不是帮忙。
 */
function ensureMain(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow();
    // 新建的窗口默认会显示，这里立刻藏起来——它只是需要在后台跑着
    mainWindow.once('ready-to-show', () => mainWindow?.hide());
    mainWindow.hide();
  }
}

function togglePet(): void {
  if (!petWindow || petWindow.isDestroyed()) {
    petWindow = createPetWindow();
    return;
  }
  if (petWindow.isVisible()) petWindow.hide();
  else petWindow.show();
}

function resetPet(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = defaultPetBounds(workArea(), petExpanded);
  petWindow.setBounds(bounds);
  savePetPosition(bounds);
}

/* ------------------------------------------------------------------ *
 * 菜单：把纯数据的规格翻成 Electron 的模板
 * ------------------------------------------------------------------ */

function runAction(action: string): void {
  switch (action) {
    case 'open-main':
      showMain();
      break;
    case 'hide-pet':
      petWindow?.hide();
      break;
    case 'toggle-pet':
      togglePet();
      break;
    case 'reset-pet':
      resetPet();
      break;
    case 'toggle-ambient':
      ambientPaused = !ambientPaused;
      // 被动采集的开关是前端本地的，两个渲染进程都要知道
      for (const win of [mainWindow, petWindow]) {
        win?.webContents.send(TO_RENDERER.ambientToggle, ambientPaused);
      }
      refreshTray();
      break;
    case 'quit':
      quitting = true;
      app.quit();
      break;
    default:
      break;
  }
}

function toTemplate(spec: MenuItemSpec[]): MenuItemConstructorOptions[] {
  return spec.map((item) => {
    if (item.type === 'separator') return { type: 'separator' };
    return {
      label: item.label,
      type: item.type === 'checkbox' ? 'checkbox' : 'normal',
      checked: item.checked,
      click: () => runAction(item.action ?? '')
    };
  });
}

function refreshTray(): void {
  if (!tray) return;
  const visible = Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible());
  tray.setContextMenu(Menu.buildFromTemplate(toTemplate(trayMenu({ petVisible: visible }))));
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  icon.setTemplateImage(false);
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('丘丘');
  tray.on('click', showMain);
  refreshTray();
}

/* ------------------------------------------------------------------ *
 * IPC：主进程只当搬运工
 * ------------------------------------------------------------------ */

function wireIpc(): void {
  ipcMain.on(TO_MAIN.openMain, showMain);
  ipcMain.on(TO_MAIN.hideMain, () => mainWindow?.hide());
  ipcMain.on(TO_MAIN.hidePet, () => petWindow?.hide());
  ipcMain.on(TO_MAIN.resetPet, resetPet);
  ipcMain.on(TO_MAIN.quit, () => {
    quitting = true;
    app.quit();
  });

  ipcMain.on(TO_MAIN.focusPet, () => {
    if (!petWindow || petWindow.isDestroyed()) petWindow = createPetWindow();
    petWindow.show();
    petWindow.focus();
    petWindow.webContents.send(TO_RENDERER.petFocus);
  });

  ipcMain.on(TO_MAIN.dragPet, (_e, dx: number, dy: number) => {
    if (!petWindow || petWindow.isDestroyed()) return;
    if (!dragAt) {
      const b = petWindow.getBounds();
      dragAt = { x: b.x, y: b.y };
    }
    const next = moveBy({ ...dragAt, width: 0, height: 0 }, dx, dy);
    dragAt = { x: next.x, y: next.y };
    petWindow.setPosition(next.x, next.y, false);
  });

  ipcMain.on(TO_MAIN.setPetExpanded, (_e, expanded: boolean) => {
    petExpanded = Boolean(expanded);
    if (!petWindow || petWindow.isDestroyed()) return;
    // 球心必须不动：宽度差的一半从 x 上补回来（geometry.petBounds）
    petWindow.setBounds(petBounds(petWindow.getBounds(), petExpanded));
  });

  ipcMain.on(TO_MAIN.setPetPassthrough, (_e, ignore: boolean) => {
    petWindow?.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  });

  ipcMain.on(TO_MAIN.popupPetMenu, (_e, state: { ambientPaused?: boolean }) => {
    if (!petWindow || petWindow.isDestroyed()) return;
    const spec = petContextMenu({ ambientPaused: state?.ambientPaused ?? ambientPaused });
    Menu.buildFromTemplate(toTemplate(spec)).popup({ window: petWindow });
  });

  // AD-5：主窗口 → 桌宠
  ipcMain.on(TO_MAIN.forwardDelta, (_e, sessionId: string, text: string) => {
    petWindow?.webContents.send(TO_RENDERER.delta, sessionId, text);
  });
  ipcMain.on(TO_MAIN.forwardDone, (_e, sessionId: string) => {
    petWindow?.webContents.send(TO_RENDERER.done, sessionId);
  });
  ipcMain.on(TO_MAIN.setPetState, (_e, state: string, emotionId?: string) => {
    petWindow?.webContents.send(TO_RENDERER.petState, state, emotionId);
  });

  // AD-5：桌宠 → 主窗口。桌宠自己不发任何 HTTP 请求
  ipcMain.on(TO_MAIN.submitFromPet, (_e, text: string) => {
    // 只保证主窗口在后台活着，**不弹出来**：用户看的是桌宠气泡，
    // 把整个界面推到脸上是打断
    ensureMain();
    mainWindow?.webContents.send(TO_RENDERER.submitFromPet, text);
  });

  // 桌宠按了通话和弦。语音会话跑在主窗口——麦克风与音频播放只该有一份，
  // 两个窗口各开一个会互相抢
  // 换皮肤：转给**除发送方之外**的窗口。带上发送方会转回去，那边再广播一次就绕不完了
  ipcMain.on(TO_MAIN.setSkin, (e, skin: string) => {
    for (const win of [mainWindow, petWindow]) {
      if (!win || win.isDestroyed()) continue;
      if (win.webContents.id === (e as { sender?: { id?: number } }).sender?.id) continue;
      win.webContents.send(TO_RENDERER.skin, skin);
    }
  });

  ipcMain.on(TO_MAIN.callFromPet, () => {
    ensureMain();
    mainWindow?.webContents.send(TO_RENDERER.callFromPet);
  });
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);

  void app.whenReady().then(() => {
    wireIpc();
    mainWindow = createMainWindow();
    petWindow = createPetWindow();
    createTray();

    // 松手后的吸附与位置持久化。
    //
    // `moved` 在拖动**过程中**每移动一次就来一发，直接在里面吸附有两个后果：
    // 一是拖到边上时窗口自己跳过去，手还没松就被吸走；二是 `setBounds` 又触发
    // 一次 `moved`，一路自己喂自己，拖动就顿。所以等它安静下来再收尾
    // ——Electron 没有「拖动结束」事件，只能这么判。
    petWindow.on('moved', () => {
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        dragAt = null; // 位置已经不是拖动时那个了，缓存作废
        if (!petWindow || petWindow.isDestroyed()) return;
        const now = petWindow.getBounds();
        const next = settle(now, workArea());
        // 没变就别写回去，写回去又是一次 `moved`，会自己转起来
        if (next.x !== now.x || next.y !== now.y) petWindow.setBounds(next);
        savePetPosition(next);
      }, SETTLE_DEBOUNCE_MS);
    });

    globalShortcut.register(FOCUS_PET_ACCELERATOR, () => {
      if (!petWindow || petWindow.isDestroyed()) petWindow = createPetWindow();
      petWindow.show();
      petWindow.focus();
      petWindow.webContents.send(TO_RENDERER.petFocus);
    });

    app.on('activate', showMain);
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', () => {
    quitting = true;
  });
  // 桌宠常驻，关掉所有窗口不退出进程（托盘还在）
  app.on('window-all-closed', () => {
    /* 刻意留空 */
  });
}
