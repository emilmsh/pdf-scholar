// Pure-browser dev server for the renderer (no Electron) — used for quick UI
// preview and automated screenshots. The app falls back to browser APIs when
// window.api is missing.
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { pdfjsAssets } from './vite.pdfjs-assets'

export default defineConfig({
  root: '../src/renderer',
  plugins: [react(), pdfjsAssets()],
  server: { port: Number(process.env.PORT) || 5199, strictPort: true }
})
