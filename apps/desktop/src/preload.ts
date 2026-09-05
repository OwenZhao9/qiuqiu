/**
 * preload：把 `window.qiuqiu` 与 `window.__QIUQIU_API__` 递给渲染进程。
 *
 * 只做暴露这一件事，逻辑在 `bridge-factory.ts` 里，方便契约测试。
 * `contextIsolation` 开着，渲染进程拿不到 `require`，也拿不到 `ipcRenderer` 本体。
 */

import { contextBridge, ipcRenderer } from 'electron';
import { createQiuqiuBridge } from './bridge-factory.js';

/** 后端地址。契约 § 2 写死 `http://127.0.0.1:8000`，用环境变量能换（联调时指向别的端口）。 */
const API_BASE = process.env.QIUQIU_API ?? 'http://127.0.0.1:8000';

contextBridge.exposeInMainWorld('qiuqiu', createQiuqiuBridge(ipcRenderer));
contextBridge.exposeInMainWorld('__QIUQIU_API__', API_BASE);
