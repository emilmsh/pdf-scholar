// Build the browser-extension target as a loadable unpacked extension.
//
// One shared build, two output flavours selected by `target`:
//   • 'chromium' → dist-extension/          (Edge/Chrome, MV3 service worker + DNR)
//   • 'firefox'  → dist-extension-firefox/   (MV3 event page + blocking webRequest)
//
// The renderer, background source, viewer.html and icons are identical for both;
// only manifest.json differs, and it is derived from ONE base file
// (src/extension/manifest.json, the Chromium manifest) with a small Firefox
// override applied at write time — so the two never drift (see makeManifest).
//
//   npm run build:ext           → chromium   (default export)
//   npm run build:ext:firefox   → firefox    (vite.extension.firefox.config.ts)
//
// Load the result via edge://extensions / chrome://extensions ("Load unpacked")
// or, for Firefox, about:debugging ("Load Temporary Add-on"). See
// docs/BROWSER-EXTENSION.md.
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { pdfjsAssets } from './vite.pdfjs-assets'

export type ExtensionTarget = 'chromium' | 'firefox'

const extensionDir = resolve(__dirname, 'src/extension')

function outDirFor(target: ExtensionTarget): string {
  return resolve(__dirname, target === 'firefox' ? 'dist-extension-firefox' : 'dist-extension')
}

// Firefox add-on id — required for AMO signing and for web-ext sign. Stable, so
// the signed XPI keeps its identity across releases.
const GECKO_ID = 'pdf-scholar@emilmsh.github.io'
// Floor chosen for the features we rely on: MV3 event pages, blocking webRequest
// in MV3, `wasm-unsafe-eval` CSP, MV3 web_accessible_resources, and Firefox for
// Android general add-on support. 128 is a widely-deployed ESR by 2026.
const FIREFOX_MIN_VERSION = '128.0'

/** Turn the Chromium (base) manifest into the Firefox manifest. Firefox uses an
 *  event page instead of a service worker, blocking webRequest instead of DNR,
 *  and requires an explicit add-on id + min versions (desktop + Android). */
function toFirefoxManifest(base: Record<string, unknown>): Record<string, unknown> {
  const m: Record<string, unknown> = { ...base }
  delete m.minimum_chrome_version // Chromium-only hint
  m.background = { scripts: ['background.js'], type: 'module' }
  m.permissions = ['webRequest', 'webRequestBlocking', 'storage', 'tabs']
  m.browser_specific_settings = {
    gecko: { id: GECKO_ID, strict_min_version: FIREFOX_MIN_VERSION },
    gecko_android: { strict_min_version: FIREFOX_MIN_VERSION }
  }
  return m
}

// Copy the manifest (version-stamped from package.json, per-target transformed)
// + the extension icons (icons/*.png, shared with the desktop app — regenerate
// via scripts/render-extension-icons.cjs) into the build output.
function copyManifest(target: ExtensionTarget): Plugin {
  const outDir = outDirFor(target)
  return {
    name: 'pdfx-copy-manifest',
    writeBundle() {
      const base = JSON.parse(readFileSync(resolve(extensionDir, 'manifest.json'), 'utf8'))
      base.version = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8')).version
      const manifest = target === 'firefox' ? toFirefoxManifest(base) : base
      writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
      const iconsSrc = resolve(extensionDir, 'icons')
      const iconsOut = resolve(outDir, 'icons')
      mkdirSync(iconsOut, { recursive: true })
      for (const file of readdirSync(iconsSrc)) {
        copyFileSync(resolve(iconsSrc, file), resolve(iconsOut, file))
      }
    }
  }
}

export function makeExtensionConfig(target: ExtensionTarget = 'chromium'): UserConfig {
  return {
    root: extensionDir,
    base: './',
    plugins: [react(), copyManifest(target), pdfjsAssets()],
    build: {
      outDir: outDirFor(target),
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
          // Stable name for the background worker so manifest.json can reference
          // it; everything else lands in assets/ (declared web-accessible).
          entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash][extname]'
        }
      }
    }
  }
}

export default defineConfig(makeExtensionConfig('chromium'))
