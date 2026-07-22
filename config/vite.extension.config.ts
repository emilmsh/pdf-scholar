// Build the browser-extension target into dist-extension/ as a loadable
// unpacked extension. Two entries: the viewer page (React, shares the whole
// renderer) and the background service worker. manifest.json is copied verbatim.
//
// Load the result via edge://extensions or chrome://extensions → "Load unpacked"
// → pick dist-extension/. See docs/BROWSER-EXTENSION.md.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { pdfjsAssets } from './vite.pdfjs-assets'

const extensionDir = resolve(__dirname, '../src/extension')
const outDir = resolve(__dirname, '../dist-extension')

// Copy the static manifest + the extension icons (icons/*.png, shared with the
// desktop app — regenerate via scripts/render-extension-icons.cjs) into the
// build output after the bundle is written. The manifest version is stamped
// from package.json so the extension can never drift from the app version.
function copyManifest(): Plugin {
  return {
    name: 'pdfx-copy-manifest',
    writeBundle() {
      const manifest = JSON.parse(readFileSync(resolve(extensionDir, 'manifest.json'), 'utf8'))
      manifest.version = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')).version
      writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
      const iconsSrc = resolve(extensionDir, 'icons')
      const iconsOut = resolve(outDir, 'icons')
      mkdirSync(iconsOut, { recursive: true })
      // Ship ONLY the manifest-referenced PNGs — never brand/design sources
      // (svg/pdf) that may sit alongside them in the source folder.
      for (const file of readdirSync(iconsSrc)) {
        if (!/^icon-\d+\.png$/.test(file)) continue
        copyFileSync(resolve(iconsSrc, file), resolve(iconsOut, file))
      }
    }
  }
}

export default defineConfig({
  root: extensionDir,
  base: './',
  plugins: [react(), copyManifest(), pdfjsAssets()],
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    // Extension pages have a strict CSP (script-src 'self'); the module-preload
    // polyfill injects an inline script, so turn it off.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        viewer: resolve(extensionDir, 'viewer.html'),
        background: resolve(extensionDir, 'background.ts')
      },
      output: {
        // Stable name for the service worker so manifest.json can reference it;
        // everything else lands in assets/ (declared web-accessible).
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  }
})
