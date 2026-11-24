import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

import path from 'path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/storage': { target: 'http://localhost:3001', changeOrigin: true },
      '/health': { target: 'http://localhost:3001', changeOrigin: true },
      '/ready': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (!normalized.includes('/node_modules/')) {
            return;
          }
          if (
            normalized.includes('/node_modules/react/') ||
            normalized.includes('/node_modules/react-dom/') ||
            normalized.includes('/node_modules/react-router') ||
            normalized.includes('/node_modules/@remix-run/router/') ||
            normalized.includes('/node_modules/scheduler/')
          ) {
            return 'react-vendor';
          }
          if (normalized.includes('/node_modules/@radix-ui/')) {
            return 'radix-ui';
          }
          if (
            normalized.includes('/node_modules/recharts/') ||
            normalized.includes('/node_modules/d3-') ||
            normalized.includes('/node_modules/victory-vendor/')
          ) {
            return 'recharts';
          }
          if (normalized.includes('/node_modules/lucide-react/')) {
            return 'lucide';
          }
          if (normalized.includes('/node_modules/framer-motion/')) {
            return 'framer-motion';
          }
          if (normalized.includes('/node_modules/@tanstack/react-query/')) {
            return 'query-vendor';
          }
        },
      },
    },
  },
});
