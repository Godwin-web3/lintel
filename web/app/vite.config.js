import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'es2022' },
  // The docs pages and landing evidence import ../../docs (Markdown + JSON) from the repo root.
  server: { fs: { allow: ['../..'] } },
});
