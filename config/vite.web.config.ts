// Pure-browser dev server for the renderer (no Electron) — used for quick UI
// preview and automated screenshots. The app falls back to browser APIs when
// window.api is missing.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { pdfjsAssets } from './vite.pdfjs-assets'

export default defineConfig({
  // Relative roots resolve against the process CWD, not this file — anchor it
  // here so `npm run dev:web` works from the project root (same pattern as
  // vite.extension.config.ts).
  root: resolve(__dirname, '../src/renderer'),
  plugins: [react(), pdfjsAssets()],
  server: { port: Number(process.env.PORT) || 5199, strictPort: true }
})
