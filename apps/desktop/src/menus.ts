/**
 * 托盘菜单与桌宠右键菜单的**内容**，纯数据。
 *
 * 主进程拿这份规格去拼 Electron 的 `Menu.buildFromTemplate`，vitest 直接断言这份规格。
 * 条目与 `design/interaction.md` § 1 和任务书的托盘四项逐条对上。
 *
 * 右键菜单必须是 Electron 原生菜单，不是 HTML 菜单——HTML 菜单在透明窗口里会被窗口边界裁掉。
 */

export type MenuAction =
  'open-main' | 'hide-pet' | 'toggle-pet' | 'reset-pet' | 'toggle-ambient' | 'quit';

export interface MenuItemSpec {
  label?: string;
  action?: MenuAction;
  type?: 'separator' | 'checkbox';
  checked?: boolean;
  /** 默认项，加粗。 */
  bold?: boolean;
}

const SEPARATOR: MenuItemSpec = { type: 'separator' };

/** 桌宠右键菜单，`design/interaction.md` § 1「右键菜单」那张表。 */
export function petContextMenu(state: { ambientPaused: boolean }): MenuItemSpec[] {
  return [
    { label: '打开主窗口', action: 'open-main', bold: true },
    { label: '收起丘丘', action: 'hide-pet' },
    { label: '回到默认位置', action: 'reset-pet' },
    SEPARATOR,
    {
      label: '暂停被动采集',
      action: 'toggle-ambient',
      type: 'checkbox',
      checked: state.ambientPaused
    },
    SEPARATOR,
    { label: '退出丘丘', action: 'quit' }
  ];
}

/** 托盘四项。 */
export function trayMenu(state: { petVisible: boolean }): MenuItemSpec[] {
  return [
    { label: '打开主窗口', action: 'open-main', bold: true },
    { label: state.petVisible ? '隐藏丘丘' : '显示丘丘', action: 'toggle-pet' },
    { label: '重置位置', action: 'reset-pet' },
    SEPARATOR,
    { label: '退出丘丘', action: 'quit' }
  ];
}

/** 全局快捷键：唤起桌宠并展开输入条。 */
/**
 * 唤起桌宠并展开输入条。
 *
 * **原来定的是 `Cmd/Ctrl+Shift+Q`，换掉了**：在 macOS 上那是系统的「退出登录」。
 * Electron 抢得到的时候没事，抢不到就静默失效，而用户按下去是真的退出登录
 * ——一个快捷键不该有这种后果。
 */
export const FOCUS_PET_ACCELERATOR = 'CommandOrControl+Shift+K';
