import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { compression } from 'vite-plugin-compression2'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    // Precompress text assets to .br at build time (brotli only) so the relay serves them with no runtime CPU.
    compression({ include: /\.(js|css|html|svg|json)$/, algorithms: ['brotliCompress', 'gzip'], deleteOriginalAssets: false }),
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, '.') },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        // Only split families the app shell already loads synchronously, plus charts.
        // Grouping @radix-ui / react-hook-form here was measured and reverted: it turned
        // lazy dialog and form code into modulepreloads, adding ~14 kB Brotli to first paint.
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return undefined

          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) {
            return 'vendor-react'
          }

          if (id.includes('/react-router/') || id.includes('/react-router-dom/')) {
            return 'vendor-router'
          }

          if (id.includes('/@visx/') || id.includes('/d3-array/')) {
            return 'vendor-charts'
          }

          return undefined
        },
      },
    },
  },
  // ESM worker (tinyh264.worker imports tinyh264) — 'es' format so the worker chunk
  // can code-split its static imports. Default 'iife' breaks on code-split workers.
  worker: {
    format: 'es',
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/uploads': 'http://localhost:4000',
    },
  },
})
