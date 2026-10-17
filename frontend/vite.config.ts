import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': loadEnv(mode, '.', 'AUCTION_').AUCTION_API_TARGET || 'http://127.0.0.1:5000',
    },
  },
}))
