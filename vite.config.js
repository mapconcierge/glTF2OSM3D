import { defineConfig } from 'vite';

// GitHub Pages（https://<user>.github.io/glTF2OSM3D/）でもローカルでも動くよう相対パス
export default defineConfig({
  base: './',
  build: { chunkSizeWarningLimit: 2000 },
});
