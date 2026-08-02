// Compose one listing frame out of the three theme shots: the same cover, the
// same scroll position, wiped Day -> Sepia -> Night across the width. Five
// screenshot slots is not many, and three of them spent on one page in three
// colours is three slots that could have shown the app doing something.
//
// It only works because `shoot` puts all three at an identical framing, so the
// seams fall in the middle of a continuous window rather than between three
// pasted-together pictures. Guarded below: mismatched sizes are refused.
//
// Run: npx electron scripts/compose-tricolor.cjs [--from <dir>] [--out <dir>]
//                                                [--seam none|hairline|both] [--full]
// --full writes at the source resolution (the 2880x1800 README set) instead of
// the 1280x800 the stores want. The seam geometry below is expressed against
// 1280x800 either way and scaled to fit, so both sizes cut in the same place.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Left to right: the order the themes sit in the settings menu.
const PANELS = ['reading', 'parchment', 'night']
// The reference the seam geometry is measured in — the store size.
const REF_W = 1280
const REF_H = 800

const ROOT = path.join(__dirname, '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback
}
const AUTO = path.join(ROOT, 'docs', 'screenshots', '_auto')
const FROM = path.resolve(ROOT, flag('--from', AUTO))
const OUT = path.resolve(ROOT, flag('--out', path.join(AUTO, 'store')))
const SEAM = flag('--seam', 'none')
const NAME = flag('--name', 'tricolor')
// Where the two wipes fall, in output pixels. Near enough to equal thirds, but
// nudged into the gaps between toolbar icons so the straight upper part of the
// seam never cuts a button in half. Re-measure these if the toolbar changes:
// `--at 426,853` is the naive thirds if you want to see the difference.
const BOUNDS = flag('--at', '419,863')
  .split(',')
  .map(Number)
// How far the seam leans across the page, in output pixels. Seams in the page's
// own margins (`--at 210,1060 --slant 0`) cut no words at all, but then the
// whole text block is one theme and the other two show only as edges — it reads
// as a rendering glitch rather than as three themes. The lean is what makes the
// cut legible as a choice.
const SLANT = Number(flag('--slant', '90'))
// Where the chrome ends and the page begins — the seam stays vertical above it.
const CHROME = Number(flag('--chrome', '76'))

app.disableHardwareAcceleration()

/** Locate a PNG and read its pixel size out of the IHDR header. The page below
 *  is written to disk and loaded over file://, and the images are referenced by
 *  path: three 600 kB frames inlined as base64 make a data: URL of several
 *  megabytes, which loadURL never finishes. */
function load(name) {
  const file = path.join(FROM, `${name}.png`)
  if (!fs.existsSync(file)) throw new Error(`missing frame: ${file}`)
  const buf = fs.readFileSync(file)
  return {
    // pathToFileURL, not string surgery: this repo lives under a path with both
    // a space and a non-ASCII character in it, and a hand-built file:// URL
    // silently yields a broken-image icon rather than an error.
    uri: pathToFileURL(file).href,
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20)
  }
}

function page(frames, seam, W, H, k) {
  // Composed on a canvas rather than as clipped DOM layers, because an
  // offscreen window is capped at the display size and the README frame is
  // 2880x1800 — wider than this screen. A canvas has no such ceiling.
  // Each panel is a window onto the SAME full-width image, shifted left by the
  // panels before it — so the three slices line up pixel for pixel and the
  // result reads as one screenshot that changes colour, not as a collage.
  // All three frames are the same window at the same scroll, so they can simply
  // be stacked and each clipped to its own band — no offsets to keep in sync.
  // A slant makes the wipe unmistakably deliberate; at 0 it is a plain vertical
  // cut, which can read as a broken render.
  // The seam runs straight down through the chrome and only leans once it is on
  // the page: a diagonal across the toolbar bisects icons, which reads as a
  // mistake, while a diagonal across the page reads as a deliberate wipe. Pick
  // BOUNDS so the straight part falls in a gap between toolbar icons.
  const [x1, x2] = BOUNDS.map((x) => Math.round(x * k))
  const chrome = Math.round(CHROME * k)
  const bot = (x) => Math.round(x - SLANT * k)
  // Each band as a closed path: down the left seam, along the bottom, up the
  // right seam. The outer two run to the frame edge instead.
  const bands = [
    [[0, 0], [x1, 0], [x1, chrome], [bot(x1), H], [0, H]],
    [[x1, 0], [x2, 0], [x2, chrome], [bot(x2), H], [bot(x1), H], [x1, chrome]],
    [[x2, 0], [W, 0], [W, H], [bot(x2), H], [x2, chrome]]
  ]
  const seams = [
    [[x1, 0], [x1, chrome], [bot(x1), H]],
    [[x2, 0], [x2, chrome], [bot(x2), H]]
  ]
  const srcs = frames.map((f) => f.uri)
  return `<!doctype html><html><head><style>html,body{margin:0;background:#000}</style></head>
<body><script>
const W = ${W}, H = ${H}, SEAM = ${seam}
const BANDS = ${JSON.stringify(bands)}, SEAMS = ${JSON.stringify(seams)}
const SRCS = ${JSON.stringify(srcs)}
const trace = (ctx, pts) => {
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
}
Promise.all(SRCS.map((src) => new Promise((res, rej) => {
  const img = new Image()
  img.onload = () => res(img)
  img.onerror = () => rej(new Error('could not load ' + src))
  img.src = src
}))).then((imgs) => {
  const c = document.createElement('canvas')
  c.width = W; c.height = H
  const ctx = c.getContext('2d')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  imgs.forEach((img, i) => {
    ctx.save()
    trace(ctx, BANDS[i])
    ctx.closePath()
    ctx.clip()
    ctx.drawImage(img, 0, 0, W, H)
    ctx.restore()
  })
  if (SEAM) {
    ctx.strokeStyle = 'rgba(128,128,128,.45)'
    ctx.lineWidth = Math.max(1, Math.round(${k}))
    SEAMS.forEach((pts) => { trace(ctx, pts); ctx.stroke() })
  }
  window.__png = c.toDataURL('image/png')
}).catch((err) => { window.__err = err.message })
</script></body></html>`
}

let frames, W, H
try {
  frames = PANELS.map(load)
  const [ref] = frames
  for (const [i, f] of frames.entries()) {
    if (f.width !== ref.width || f.height !== ref.height) {
      throw new Error(`${PANELS[i]} is ${f.width}x${f.height}, ${PANELS[0]} is ${ref.width}x${ref.height} — the seams would not line up.`)
    }
  }
  if (Math.abs(ref.width / ref.height - REF_W / REF_H) > 0.001) {
    throw new Error(`source frames are ${ref.width}x${ref.height}, need 16:10.`)
  }
  W = args.includes('--full') ? ref.width : REF_W
  H = args.includes('--full') ? ref.height : REF_H
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
const k = W / REF_W

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  // The window only hosts the canvas; nothing is captured from it, so its size
  // is irrelevant.
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    frame: false,
    webPreferences: { offscreen: true }
  })
  const variants = SEAM === 'both' ? [[NAME, false], [`${NAME}-seam`, true]] : [[NAME, SEAM === 'hairline']]
  const scratch = path.join(OUT, '.tricolor.html')
  for (const [name, seam] of variants) {
    fs.writeFileSync(scratch, page(frames, seam, W, H, k))
    await win.loadFile(scratch)
    let uri = null
    for (let i = 0; i < 60 && !uri; i++) {
      await new Promise((r) => setTimeout(r, 250))
      const err = await win.webContents.executeJavaScript('window.__err || null')
      if (err) {
        console.error(`  ${name} … ${err}`)
        app.exit(1)
        return
      }
      uri = await win.webContents.executeJavaScript('window.__png || null')
    }
    if (!uri) {
      console.error(`  ${name} … the canvas never finished`)
      app.exit(1)
      return
    }
    const png = Buffer.from(uri.slice(uri.indexOf(',') + 1), 'base64')
    const dest = path.join(OUT, `${name}.png`)
    fs.writeFileSync(dest, png)
    console.log(`  ${name} … ${PANELS.join(' | ')}, ${W}x${H}, ${Math.round(png.length / 1024)} kB`)
  }
  fs.rmSync(scratch, { force: true })
  console.log(`\nDone — ${OUT}`)
  app.quit()
})
