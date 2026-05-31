import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../static',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/ws': {
        target: 'http://127.0.0.1:8000',
        ws: true,
        changeOrigin: true,
      },
      '/profile': 'http://127.0.0.1:8000',
      '/coach': 'http://127.0.0.1:8000',
      '/session': 'http://127.0.0.1:8000',
    },
    // Move Vite's own HMR websocket off /ws to avoid collision
    hmr: {
      path: '/__vite_hmr',
    },
  },
})
