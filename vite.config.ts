import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true },
  build: {
    target: 'es2022',
    rolldownOptions: {
      // 島 1 つの「つくる・飛ぶ」と、群島の試作。
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        archipelago: resolve(import.meta.dirname, 'archipelago.html'),
      },
    },
  },
});
