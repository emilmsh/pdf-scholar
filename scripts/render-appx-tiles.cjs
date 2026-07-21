// Render the MSIX/appx tile + logo assets the Microsoft Store requires into
// build/appx/. Without these, electron-builder packs its OWN default
// placeholder logo, which fails Store policy 10.1.1.11 ("tile icons must
// uniquely represent product"). electron-builder auto-picks up any of these
// filenames from <buildResources>/appx/ (buildResources = build).
//
// Square tiles are Lanczos-downscaled from the 512px master (build/icon.png,
// itself rendered from scripts/icon.svg — a self-contained rounded teal icon)
// with nativeImage, the same reliable path render-extension-icons.cjs uses.
// The non-square Wide tile + SplashScreen center that logo on transparency via
// a single offscreen render, so the appx `backgroundColor` (#1c1c1e) shows
// through — a dark tile with the teal icon centered.
//
// Uses Electron only — no extra deps.
// Run: npx electron scripts/render-appx-tiles.cjs  (or: npm run icons:appx)
const { app, nativeImage, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

const SQUARE = [
  { name: 'Square44x44Logo.png', size: 44 },
  { name: 'Square71x71Logo.png', size: 71 },
  { name: 'Square150x150Logo.png', size: 150 },
  { name: 'Square310x310Logo.png', size: 310 },
  { name: 'StoreLogo.png', size: 50 }
]
// scale = fraction of the tile height the centered logo occupies.
const WIDE = [
  { name: 'Wide310x150Logo.png', w: 310, h: 150, scale: 0.78 },
  { name: 'SplashScreen.png', w: 620, h: 300, scale: 0.7 }
]

app.whenReady().then(async () => {
  const master = path.join(__dirname, '..', 'build', 'icon.png')
  const base = nativeImage.createFromPath(master)
  if (base.isEmpty()) throw new Error(`could not read ${master}`)
  const outDir = path.join(__dirname, '..', 'build', 'appx')
  fs.mkdirSync(outDir, { recursive: true })

  for (const t of SQUARE) {
    // quality:'best' → Lanczos; crisp downscale from the 512px master.
    const png = base.resize({ width: t.size, height: t.size, quality: 'best' }).toPNG()
    fs.writeFileSync(path.join(outDir, t.name), png)
    console.log(`wrote ${t.name} (${png.length} bytes, ${t.size}x${t.size})`)
  }

  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf-8')
  const largest = WIDE.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b))
  const win = new BrowserWindow({
    show: false,
    width: largest.w,
    height: largest.h,
    useContentSize: true,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true }
  })
  const tmpHtml = path.join(app.getPath('temp'), 'pdfx-appx-tile.html')
  for (const t of WIDE) {
    const logoPx = Math.round(t.h * t.scale)
    const html =
      `<!doctype html><html><head><meta charset="utf-8"><style>` +
      `html,body{margin:0;padding:0;background:transparent;overflow:hidden}` +
      `.wrap{width:${t.w}px;height:${t.h}px;display:flex;align-items:center;justify-content:center}` +
      `.wrap svg{width:${logoPx}px;height:${logoPx}px;display:block}` +
      `</style></head><body><div class="wrap">${svg}</div></body></html>`
    fs.writeFileSync(tmpHtml, html)
    win.setContentSize(t.w, t.h)
    await win.loadFile(tmpHtml)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: t.w, height: t.h })
    const png = image.toPNG()
    fs.writeFileSync(path.join(outDir, t.name), png)
    const size = image.getSize()
    console.log(`wrote ${t.name} (${png.length} bytes, ${size.width}x${size.height})`)
  }
  fs.rmSync(tmpHtml, { force: true })
  win.destroy()
  app.quit()
})
