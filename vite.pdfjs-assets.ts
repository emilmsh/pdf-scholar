// pdf.js side-loads binary companion assets at runtime — wasm image decoders
// (JBIG2/JPEG2000/qcms: without them scanned pages render BLANK), CJK CMaps,
// the 14 standard fonts and a CMYK ICC profile. They are plain files fetched
// from a base URL, so every build target must ship them next to index.html.
// This plugin serves them from node_modules in dev and copies them into the
// output dir on build. The matching URLs are passed to getDocument() in
// PdfViewer.tsx (pdfjsAssetUrl).
import { cpSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { Plugin } from 'vite'

const require = createRequire(import.meta.url)
const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'))

export const PDFJS_ASSET_DIRS = ['wasm', 'cmaps', 'standard_fonts', 'iccs'] as const

const DIR_RE = new RegExp(`^/(${PDFJS_ASSET_DIRS.join('|')})/([^/?#]+)`)

export function pdfjsAssets(): Plugin {
  let outDir = ''
  return {
    name: 'pdfx-pdfjs-assets',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = DIR_RE.exec(req.url ?? '')
        if (!m) {
          next()
          return
        }
        try {
          const data = readFileSync(path.join(pdfjsRoot, m[1], decodeURIComponent(m[2])))
          res.setHeader('Content-Type', 'application/octet-stream')
          res.end(data)
        } catch {
          res.statusCode = 404
          res.end()
        }
      })
    },
    closeBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        cpSync(path.join(pdfjsRoot, dir), path.join(outDir, dir), { recursive: true })
      }
    }
  }
}
