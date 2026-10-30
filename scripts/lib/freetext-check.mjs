// What a FreeText's appearance stream says about where its words sit — shared
// by test:engine (PDFium's full-rewrite path) and test:appender (our own
// incremental writer), which must both set a text box exactly as
// src/shared/freetext-layout.ts says (issue #66: a box that hugs its text is
// only 2 pt wider than its longest line, so the file must wrap and place the
// words where the screen did).
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** src/shared/freetext-layout.ts, bundled to a temp file and imported */
export async function loadFreetextLayout() {
  const { build } = await import('esbuild')
  const out = path.join(os.tmpdir(), `pdfx-freetext-layout-${process.pid}.mjs`)
  await build({
    entryPoints: [path.join(ROOT, 'src/shared/freetext-layout.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: out,
    logLevel: 'silent'
  })
  return import(pathToFileURL(out).href)
}

/** The renderer's wrap (freetextMinSize in annotations.ts): words joined by
 *  single spaces, a word moved to the next line once it — with the space
 *  after it, when one follows — would make the line WIDER than the box, each
 *  paragraph on its own lines */
export function wrapLines(text, maxW, width) {
  const lines = []
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ').filter((s) => s.length > 0)
    let current = ''
    for (const [i, word] of words.entries()) {
      const next = current === '' ? word : `${current} ${word}`
      const room = i < words.length - 1 ? `${next} ` : next
      if (width(room) > maxW && current !== '') {
        lines.push(current)
        current = word
      } else {
        current = next
      }
    }
    lines.push(current)
  }
  return lines
}

const unescape = (s) =>
  s.replace(/\\([0-7]{1,3}|.)/g, (_, e) => (/^[0-7]+$/.test(e) ? String.fromCharCode(parseInt(e, 8)) : e))

/** Every shown line of an appearance stream with the point it starts at, in
 *  page space: Td moves from the current line start (identity after BT), Tm
 *  sets it, T* steps down by TL. Upright text only — what both writers make
 *  on an unrotated page. */
export function apLines(ap) {
  const out = []
  let lx = 0
  let ly = 0
  let leading = 0
  const re = /(-?[\d.]+)\s+(-?[\d.]+)\s+Td|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm|(-?[\d.]+)\s+TL|T\*|\(((?:\\.|[^\\)])*)\)\s*Tj|\bBT\b/g
  for (const m of ap.matchAll(re)) {
    if (m[0] === 'BT') {
      lx = 0
      ly = 0
    } else if (m[1] !== undefined) {
      lx += Number(m[1])
      ly += Number(m[2])
    } else if (m[3] !== undefined) {
      lx = Number(m[7])
      ly = Number(m[8])
    } else if (m[9] !== undefined) {
      leading = Number(m[9])
    } else if (m[0] === 'T*') {
      ly -= leading
    } else if (m[10] !== undefined) {
      out.push({ text: unescape(m[10]), x: lx, y: ly })
    }
  }
  return out
}
