// Produce the PNG sizes a Chromium MV3 extension needs (16/32/48/128) into
// src/extension/icons/icon-<n>.png, so the browser extension shows the SAME
// icon as the native app. Downscales the already-rendered build/icon.png
// (512x512, from scripts/icon.svg) with Electron's nativeImage — no extra
// dependencies, and no offscreen page render (which hangs headless).
// Run: npx electron scripts/render-extension-icons.cjs
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SIZES = [16, 32, 48, 128]

app.whenReady().then(() => {
  const src = path.join(__dirname, '..', 'build', 'icon.png')
  const base = nativeImage.createFromPath(src)
  if (base.isEmpty()) throw new Error(`could not read ${src}`)
  const outDir = path.join(__dirname, '..', 'src', 'extension', 'icons')
  fs.mkdirSync(outDir, { recursive: true })
  for (const size of SIZES) {
    // quality:'best' → Lanczos; crisp downscale from the 512px master.
    const png = base.resize({ width: size, height: size, quality: 'best' }).toPNG()
    const out = path.join(outDir, `icon-${size}.png`)
    fs.writeFileSync(out, png)
    console.log(`wrote ${out} (${png.length} bytes, ${size}x${size})`)
  }
  app.quit()
})
