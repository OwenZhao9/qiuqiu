/**
 * 路径工具。
 *
 * 测试跑在 jsdom 环境里，`import.meta.url` 会被改写成 `http://localhost/...`，
 * 不能直接喂给 `fs`。这里从 `process.cwd()` 往上找 `pnpm-workspace.yaml` 定位仓库根，
 * 不依赖 `import.meta.url`。
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

let cachedRoot: string | null = null;

/** 仓库根目录。 */
export function repoRoot(): string {
  if (cachedRoot) return cachedRoot;
  let dir = resolve(process.cwd());
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`找不到仓库根（从 ${process.cwd()} 向上没看到 pnpm-workspace.yaml）`);
}

/** 相对仓库根的绝对路径。 */
export function fromRepo(...parts: string[]): string {
  return join(repoRoot(), ...parts);
}

/** 相对 `packages/character` 的绝对路径。 */
export function fromPackage(...parts: string[]): string {
  return join(repoRoot(), 'packages', 'character', ...parts);
}
