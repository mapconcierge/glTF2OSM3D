import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// GitHub Pages（https://<user>.github.io/glTF2OSM3D/）でもローカルでも動くよう相対パス
export default defineConfig({
  base: './',
  // package.json の version を画面に表示（左上タイトル）
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: { chunkSizeWarningLimit: 6000 },
});
