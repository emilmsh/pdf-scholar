// Rasterize scripts/pdf-document.svg — the .pdf FILE icon (issue #26) — into
// the three files the installers read:
//   build/pdf.ico           Windows: electron-builder picks `<ext>.ico` up by
//                           name for the fileAssociations entry (FileAssociation
//                           option docs) and the NSIS installer writes it as the
//                           ProgId's DefaultIcon
//   build/pdf.icns          macOS: same rule, `<ext>.icns`, for CFBundleDocumentTypes
// (The MSIX manifest gets no per-file-type logo through electron-builder, so
// the Store build keeps the app icon on files — docs/PLATFORMS.md § 27.)
// Same offscreen-Electron approach as render-icon.cjs, no dependencies: ICO and
// ICNS are both containers that accept PNG payloads (Vista+ for ICO, 10.7+ for
// ICNS), so packing them is a header and a table, nothing more.
// Run: npm run icons:app (renders this after the app icon)
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

const SVG = path.join(__dirname, 'pdf-document.svg')
const OUT = path.join(__dirname, '..', 'build')

/** Every size either container wants. 16/32/48 are what Explorer actually
 *  draws in list and tile views; 256 is its large-icon view; the ICNS set
 *  wants the @2x pairs too. */
const SIZES = [16, 32, 48, 64, 128, 256, 512]

/** One offscreen window for every size: a second data-URL load into a fresh
 *  window failed with ERR_FAILED on this machine, so the page is loaded once
 *  and the window and the <svg> are resized between captures instead. */
let win = null
async function openPage() {
  win = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    useContentSize: true,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: true }
  })
  const svg = fs.readFileSync(SVG, 'utf-8')
  const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

async function render(size) {
  win.setContentSize(size, size)
  await win.webContents.executeJavaScript(
    `(() => { const s = document.querySelector('svg'); s.setAttribute('width', ${size}); s.setAttribute('height', ${size}); return true })()`
  )
  await new Promise((resolve) => setTimeout(resolve, 400))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  const got = image.getSize()
  if (got.width !== size || got.height !== size) throw new Error(`rendered ${got.width}x${got.height}, wanted ${size}`)
  return image.toPNG()
}

/** ICO: ICONDIR (6 bytes) + one ICONDIRENTRY (16 bytes) per image, then the
 *  PNG payloads back to back. Width/height bytes are 0 for 256 (the format's
 *  way of saying 256); 512 is not a legal ICO size and is left out. */
function packIco(pngs) {
  const entries = pngs.filter(({ size }) => size <= 256)
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4)
  const dir = Buffer.alloc(16 * entries.length)
  let offset = 6 + dir.length
  entries.forEach(({ size, png }, i) => {
    const o = i * 16
    dir.writeUInt8(size === 256 ? 0 : size, o)
    dir.writeUInt8(size === 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2) // palette
    dir.writeUInt8(0, o + 3) // reserved
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bpp
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)])
}

/** ICNS: 'icns' + total length, then one chunk per image: 4-char type + length
 *  (both included) + PNG. The PNG-capable types and the point size each stands
 *  for (an @2x type is the same pixel size as the next 1x one, and macOS wants
 *  both to pick the right one per display). */
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic11', 32], // 16@2x
  ['ic12', 64], // 32@2x
  ['ic13', 256], // 128@2x
  ['ic14', 512] // 256@2x
]
function packIcns(pngs) {
  const bySize = new Map(pngs.map(({ size, png }) => [size, png]))
  const chunks = ICNS_TYPES.map(([type, size]) => {
    const png = bySize.get(size)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(8 + png.length, 4)
    return Buffer.concat([head, png])
  })
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

app.whenReady().then(async () => {
  await openPage()
  const pngs = []
  // largest first: shrinking an offscreen window is reliable, growing it
  // past its creation size is not
  for (const size of [...SIZES].sort((a, b) => b - a)) pngs.push({ size, png: await render(size) })
  fs.mkdirSync(OUT, { recursive: true })
  const ico = path.join(OUT, 'pdf.ico')
  const icns = path.join(OUT, 'pdf.icns')
  fs.writeFileSync(ico, packIco(pngs))
  fs.writeFileSync(icns, packIcns(pngs))
  for (const f of [ico, icns]) console.log(`wrote ${f} (${fs.statSync(f).size} bytes)`)
  // Per-size previews for judging the small renders by eye (gitignored _auto)
  const dbg = path.join(__dirname, '..', 'docs', 'screenshots', '_auto', 'file-icon')
  fs.mkdirSync(dbg, { recursive: true })
  for (const { size, png } of pngs) fs.writeFileSync(path.join(dbg, `pdf-${size}.png`), png)
  console.log(`per-size previews in ${dbg}`)
  app.quit()
})
