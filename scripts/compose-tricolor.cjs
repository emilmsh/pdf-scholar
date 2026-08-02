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
//                                                [--seam none|hairline|both]
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

// Left to right: the order the themes sit in the settings menu.
const PANELS = ['reading', 'parchment', 'night']
const WIDTH = 1280
const HEIGHT = 800

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

app.commandLine.appendSwitch('force-device-scale-factor', '1')
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

function page(frames, seam) {
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
  const [x1, x2] = BOUNDS
  const bot = (x) => Math.round(x - SLANT)
  const seamPath = (x) => `${x}px 0, ${x}px ${CHROME}px, ${bot(x)}px 100%`
  const clips = [
    `polygon(0 0, ${seamPath(x1)}, 0 100%)`,
    `polygon(${seamPath(x1)}, ${bot(x2)}px 100%, ${x2}px ${CHROME}px, ${x2}px 0)`,
    `polygon(${seamPath(x2)}, 100% 100%, 100% 0)`
  ]
  // The hairline has to follow the same kink, so it is drawn as an SVG path on
  // top rather than as a border on a panel.
  const line = (x) => `M${x} 0 L${x} ${CHROME} L${bot(x)} ${HEIGHT}`
  const rules = seam
    ? `<svg width="${WIDTH}" height="${HEIGHT}"><path d="${line(x1)} ${line(x2)}" stroke="rgba(128,128,128,.45)" stroke-width="1" fill="none"/></svg>`
    : ''
  const layers = frames.map((f, i) => `<img src="${f.uri}" style="clip-path:${clips[i]}">`).join('')
  return `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:#000}
    img,svg{position:absolute;top:0;left:0;width:${WIDTH}px;height:${HEIGHT}px;display:block}
  </style></head><body>${layers}${rules}</body></html>`
}

app.whenReady().then(async () => {
  const frames = PANELS.map(load)
  const [ref] = frames
  for (const [i, f] of frames.entries()) {
    if (f.width !== ref.width || f.height !== ref.height) {
      console.error(`${PANELS[i]} is ${f.width}x${f.height}, ${PANELS[0]} is ${ref.width}x${ref.height} — the seams would not line up.`)
      app.exit(1)
      return
    }
  }
  if (Math.abs(ref.width / ref.height - WIDTH / HEIGHT) > 0.001) {
    console.error(`source frames are ${ref.width}x${ref.height}, need 16:10.`)
    app.exit(1)
    return
  }

  fs.mkdirSync(OUT, { recursive: true })
  const win = new BrowserWindow({
    show: false,
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    frame: false,
    webPreferences: { offscreen: true }
  })
  const variants = SEAM === 'both' ? [[NAME, false], [`${NAME}-seam`, true]] : [[NAME, SEAM === 'hairline']]
  const scratch = path.join(OUT, '.tricolor.html')
  for (const [name, seam] of variants) {
    fs.writeFileSync(scratch, page(frames, seam))
    await win.loadFile(scratch)
    await new Promise((r) => setTimeout(r, 900))
    const png = (await win.webContents.capturePage()).toPNG()
    const dest = path.join(OUT, `${name}.png`)
    fs.writeFileSync(dest, png)
    console.log(`  ${name} … ${PANELS.join(' | ')}, ${WIDTH}x${HEIGHT}, ${Math.round(png.length / 1024)} kB`)
  }
  fs.rmSync(scratch, { force: true })
  console.log(`\nDone — ${OUT}`)
  app.quit()
})
