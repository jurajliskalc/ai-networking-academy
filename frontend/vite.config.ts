import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const NOTICE = '/*! AI Networking Academy © 2026 Juraj Liska. Noncommercial use only (code: PolyForm Noncommercial 1.0.0; content: CC BY-NC-SA 4.0). Commercial use needs a license from the author. https://github.com/jurajliskalc/ai-networking-academy */';

// base './' plus a hash router lets the same build run from GitHub Pages, any sub-path, or `vite preview`.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: { port: 8740 },
  preview: { port: 8740 },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        banner: NOTICE,
        manualChunks: { react: ['react', 'react-dom', 'react-router-dom'], markdown: ['react-markdown', 'remark-gfm', 'rehype-highlight'] },
      },
    },
  },
});
