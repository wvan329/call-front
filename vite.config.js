import { fileURLToPath, URL } from 'node:url'
import fs from 'fs'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
  ],

  server: {
    proxy: {
      '/api': {
        target: 'http://59.110.35.198', // 你的后端地址（或容器地址）
        changeOrigin: true,
        ws: true, // ✅ 开启 WebSocket 代理
        rewrite: path => path.replace(/^\/api/, '')
      }
    }
  },

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  },
})
