// Render the extension-store listing assets into docs/store-assets/: the
// 300x300 "Extension logo" both dashboards ask for, and the 440x280 small
// promotional tile. These are neither app icons (build/icon.png) nor the
// in-package extension icons (src/extension/icons/, capped at 128px) — they
// are uploaded by hand in the Edge/Chrome dashboards, which is exactly how
// the Edge listing kept showing the pre-v0.25.4 scroll logo long after every
// shipped icon had moved on. Committed files give the upload a source of
// truth that check-in review can catch going stale.
//
// The logo is Lanczos-downscaled from the 512px master. The promo tile
// centers the SVG on the same near-black (#1c1c1e) the MSIX tiles use, so
// the store surfaces agree with each other.
//
// Uses Electron only — no extra deps.
// Run: npx electron scripts/render-store-assets.cjs  (or: npm run icons:store)
const { app, nativeImage, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

const TILE = { w: 440, h: 280, scale: 0.72, bg: '#1c1c1e' }

app.whenReady().then(async () => {
  const outDir = path.join(__dirname, '..', 'docs', 'store-assets')
  fs.mkdirSync(outDir, { recursive: true })

  const master = path.join(__dirname, '..', 'build', 'icon.png')
  const base = nativeImage.createFromPath(master)
  if (base.isEmpty()) throw new Error(`could not read ${master} — run npm run icons:app first`)
  const logo = base.resize({ width: 300, height: 300, quality: 'best' }).toPNG()
  fs.writeFileSync(path.join(outDir, 'extension-logo-300.png'), logo)
  console.log(`wrote extension-logo-300.png (${logo.length} bytes, 300x300)`)

  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf-8')
  const logoPx = Math.round(TILE.h * TILE.scale)
  const win = new BrowserWindow({
    show: false,
    width: TILE.w,
    height: TILE.h,
    useContentSize: true,
    frame: false,
    webPreferences: { offscreen: true }
  })
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;padding:0;background:${TILE.bg};overflow:hidden}` +
    `.wrap{width:${TILE.w}px;height:${TILE.h}px;display:flex;align-items:center;justify-content:center}` +
    `.wrap svg{width:${logoPx}px;height:${logoPx}px;display:block}` +
    `</style></head><body><div class="wrap">${svg}</div></body></html>`
  const tmpHtml = path.join(app.getPath('temp'), 'pdfx-store-tile.html')
  fs.writeFileSync(tmpHtml, html)
  await win.loadFile(tmpHtml)
  await new Promise((r) => setTimeout(r, 600))
  const shot = await win.webContents.capturePage()
  const size = shot.getSize()
  if (size.width !== TILE.w || size.height !== TILE.h) {
    throw new Error(`captured ${size.width}x${size.height}, expected ${TILE.w}x${TILE.h}`)
  }
  const png = shot.toPNG()
  fs.writeFileSync(path.join(outDir, 'promo-tile-440x280.png'), png)
  console.log(`wrote promo-tile-440x280.png (${png.length} bytes, ${TILE.w}x${TILE.h})`)
  fs.rmSync(tmpHtml, { force: true })
  app.quit()
})
