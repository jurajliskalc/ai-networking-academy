import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
        manualChunks: { react: ['react', 'react-dom', 'react-router-dom'], markdown: ['react-markdown', 'remark-gfm', 'rehype-highlight'] },
      },
    },
  },
});
