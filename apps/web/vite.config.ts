import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

/** Emotion Ball 的四个 IIFE 脚本在 packages/character/vendor 下，不复制进仓库，构建时搬过去。 */
const VENDOR_SRC = resolve(repoRoot, 'packages/character/vendor/emotion-ball/js');
const VENDOR_URL = '/vendor/emotion-ball/js';

/**
 * `loadEngine()` 的第 2 种接法（见 packages/character/src/load.ts 的注释）：
 * 宿主把 vendor 的四个脚本放进自己的静态目录，再用 baseUrl 指过去。
 * 开发时走中间件直读，构建时拷进 dist，两端路径一致。
 */
function emotionBallVendor(): Plugin {
  return {
    name: 'qiuqiu-emotion-ball-vendor',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        if (!url.startsWith(VENDOR_URL + '/')) return next();
        const file = join(VENDOR_SRC, url.slice(VENDOR_URL.length + 1));
        if (!file.startsWith(VENDOR_SRC) || !existsSync(file)) return next();
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(readFileSync(file));
      });
    },
    closeBundle() {
      if (!existsSync(VENDOR_SRC)) {
        this.warn(
          `找不到 Emotion Ball vendor 目录 ${VENDOR_SRC}，丘丘将无法渲染。` +
            '确认 packages/character 已经检出。'
        );
        return;
      }
      cpSync(VENDOR_SRC, resolve(here, 'dist/vendor/emotion-ball/js'), { recursive: true });
    }
  };
}

export default defineConfig({
  // Electron 用 file:// 加载 dist/index.html，资源必须是相对路径。
  base: './',
  plugins: [react(), emotionBallVendor()],
  server: {
    port: 5173,
    fs: { allow: [repoRoot] }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(here, 'index.html'),
        pet: resolve(here, 'pet.html')
      }
    }
  }
});
