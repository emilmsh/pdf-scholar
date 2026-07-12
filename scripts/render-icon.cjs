// Rasterize scripts/icon.svg to build/icon.png (512x512, transparent
// corners) using Electron's offscreen renderer — no extra dependencies.
// Run: npx electron scripts/render-icon.cjs
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    useContentSize: true,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true }
  })
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf-8')
  const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style></head><body>${svg}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  await new Promise((resolve) => setTimeout(resolve, 800))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 })
  const png = image.toPNG()
  const out = path.join(__dirname, '..', 'build', 'icon.png')
  fs.writeFileSync(out, png)
  const size = image.getSize()
  console.log(`wrote ${out} (${png.length} bytes, ${size.width}x${size.height})`)
  app.quit()
})
