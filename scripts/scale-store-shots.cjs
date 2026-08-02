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

// The store listing's five, in the order docs/STORE-LISTING.md gives them.
const SHOTS = ['reading', 'annotations', 'assistant', 'parchment', 'night']
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
  }
  console.log(`\nDone — ${OUT}`)
  app.quit()
})
