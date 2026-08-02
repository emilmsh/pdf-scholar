// Scale the five store frames from the 2880x1800 shoot output down to the
// 1280x800 the Chrome/Edge listings require. Both are 16:10, so this is a
// clean 2.25x downscale with no crop — Electron's nativeImage does it with
// Skia at its best filter, so no extra dependency.
//
// Run: npx electron scripts/scale-store-shots.cjs [--from <dir>] [--out <dir>]
//
// Defaults read docs/screenshots/_auto/ and write docs/screenshots/_auto/store/,
// both gitignored: the same rule as `shoot` itself — which frames ship to a
// store listing is Emil's call, so overwriting docs/store-screenshots/ takes an
// explicit --out.
const { app, nativeImage } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// Four of the listing's five, in the order docs/STORE-LISTING.md gives them —
// the fifth is `tricolor`, composed from the three theme frames by
// compose-tricolor.cjs, which this script runs at the end.
// Name shots as positional arguments to scale a different set.
const DEFAULT_SHOTS = ['annotations', 'assistant', 'assistant_figure', 'dual-pane']
const WIDTH = 1280
const HEIGHT = 800

const ROOT = path.join(__dirname, '..')
const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(name)
  return i !== -1 && args[i + 1] ? path.resolve(ROOT, args[i + 1]) : fallback
}
const AUTO = path.join(ROOT, 'docs', 'screenshots', '_auto')
const FROM = flag('--from', AUTO)
const OUT = flag('--out', path.join(AUTO, 'store'))
// Skip the VALUE of each flag, not args[0]: indexOf returns -1 for a flag that
// was not passed, and -1 + 1 lands on the first positional shot name.
const flagValues = new Set(
  ['--from', '--out'].map((f) => args.indexOf(f)).filter((i) => i !== -1).map((i) => args[i + 1])
)
const named = args.filter((a) => !a.startsWith('-') && !flagValues.has(a))
const SHOTS = named.length ? named : DEFAULT_SHOTS

app.disableHardwareAcceleration()

app.whenReady().then(() => {
  fs.mkdirSync(OUT, { recursive: true })
  console.log(`${FROM}\n  -> ${OUT}\n`)
  let failed = 0
  for (const name of SHOTS) {
    const src = path.join(FROM, `${name}.png`)
    if (!fs.existsSync(src)) {
      console.error(`  ${name} … MISSING (${src})`)
      failed++
      continue
    }
    const image = nativeImage.createFromPath(src)
    const from = image.getSize()
    // A frame that is not 16:10 would come out stretched rather than cropped,
    // and a stretched screenshot is the kind of thing you only notice once it
    // is live — so refuse instead of guessing a crop.
    if (Math.abs(from.width / from.height - WIDTH / HEIGHT) > 0.001) {
      console.error(`  ${name} … WRONG ASPECT ${from.width}x${from.height} (need 16:10)`)
      failed++
      continue
    }
    const png = nativeImage
      .createFromBuffer(image.toPNG())
      .resize({ width: WIDTH, height: HEIGHT, quality: 'best' })
      .toPNG()
    const dest = path.join(OUT, `${name}.png`)
    fs.writeFileSync(dest, png)
    const age = fs.statSync(src).mtime.toISOString().slice(0, 16).replace('T', ' ')
    console.log(`  ${name} … ${from.width}x${from.height} -> ${WIDTH}x${HEIGHT}, ${Math.round(png.length / 1024)} kB (source shot ${age})`)
  }
  if (failed) {
    console.error(`\n${failed} frame(s) not written.`)
    app.exit(1)
    return
  }
  // The fifth frame is composed rather than scaled, but it belongs to the same
  // set and the same --from/--out, so one command produces all five. Runs in
  // this Electron binary (process.execPath), not a fresh `npx electron`.
  if (!args.includes('--no-tricolor') && !named.length) {
    const r = spawnSync(
      process.execPath,
      [path.join(__dirname, 'compose-tricolor.cjs'), '--from', FROM, '--out', OUT],
      { stdio: 'inherit' }
    )
    if (r.status !== 0) {
      app.exit(r.status ?? 1)
      return
    }
  }
  console.log(`\nDone — ${OUT}`)
  app.quit()
})
