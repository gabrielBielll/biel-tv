import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Em dev, o Worker (wrangler dev) roda em 8787 — o proxy deixa o app usar
// URLs relativas (/live, /epg, /media, /admin) igualzinho à produção same-origin.
const worker = 'http://127.0.0.1:8787'

export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
  server: {
    proxy: {
      '/live': worker,
      '/epg': worker,
      '/media': worker,
      // barra no fim: pega a API (/admin/jobs…) sem engolir a página /admin.html
      '/admin/': worker,
      '/health': worker,
    },
  },
})
