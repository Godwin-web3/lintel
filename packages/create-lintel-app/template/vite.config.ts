import { defineConfig } from 'vite';

export default defineConfig({
  // lintel-sdk loads its WASM and proving parameters relative to its own
  // files (new URL(..., import.meta.url)); pre-bundling would move them.
  optimizeDeps: { exclude: ['lintel-sdk'] },
  build: { target: 'es2022' },
});
