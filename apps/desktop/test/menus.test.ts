/** 托盘四项与桌宠右键菜单，对着 `design/interaction.md` § 1 与任务书。 */

import { describe, expect, it } from 'vitest';
import { FOCUS_PET_ACCELERATOR, petContextMenu, trayMenu } from '../src/menus.js';

describe('petContextMenu', () => {
  const menu = petContextMenu({ ambientPaused: false });
  const labels = menu.filter((m) => m.type !== 'separator').map((m) => m.label);

  it('五个可点项与两条分隔线，顺序与设计一致', () => {
    expect(labels).toEqual(['打开主窗口', '收起丘丘', '回到默认位置', '暂停被动采集', '退出丘丘']);
    expect(menu.filter((m) => m.type === 'separator')).toHaveLength(2);
  });

  it('「打开主窗口」是默认项，加粗', () => {
    expect(menu[0]).toMatchObject({ action: 'open-main', bold: true });
  });

  it('「暂停被动采集」是勾选项，跟着当前状态走', () => {
    const paused = petContextMenu({ ambientPaused: true }).find(
      (m) => m.action === 'toggle-ambient'
    );
    expect(paused).toMatchObject({ type: 'checkbox', checked: true });
    expect(menu.find((m) => m.action === 'toggle-ambient')).toMatchObject({ checked: false });
  });

  it('每个可点项都挂了动作', () => {
    for (const item of menu.filter((m) => m.type !== 'separator')) {
      expect(item.action, item.label).toBeTruthy();
    }
  });
});

describe('trayMenu', () => {
  it('托盘四项：打开主窗口 / 显示隐藏丘丘 / 重置位置 / 退出', () => {
    const labels = trayMenu({ petVisible: true })
      .filter((m) => m.type !== 'separator')
      .map((m) => m.label);
    expect(labels).toEqual(['打开主窗口', '隐藏丘丘', '重置位置', '退出丘丘']);
  });

  it('桌宠藏起来时那一项变成「显示丘丘」', () => {
    const item = trayMenu({ petVisible: false }).find((m) => m.action === 'toggle-pet');
    expect(item?.label).toBe('显示丘丘');
  });
});

describe('全局快捷键', () => {
  it('是 Cmd/Ctrl + Shift + Q，两个平台一套写法', () => {
    expect(FOCUS_PET_ACCELERATOR).toBe('CommandOrControl+Shift+Q');
  });
});
