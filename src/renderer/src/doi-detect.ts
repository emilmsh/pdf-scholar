// Finding the document's DOI with pdf.js — the renderer half of the DOI
// reserve (src/shared/doi.ts holds the matching; this file only gathers the
// texts it looks in). Metadata first: the Info dictionary (some producers put a
// `doi` key there) and the XMP packet (`prism:doi`, `dc:identifier`, Crossref's
// own `crossmark` fields — scanned as values, not by name, so a new field
// needs no code). Then the text of the first pages, where a paper prints its
// own DOI before any it cites. Two pages: a title page can be a cover sheet
// and the real first page follows it. Never throws — a document with no text
// layer or no metadata simply has no DOI as far as we can tell.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { doiFromTexts } from '../../shared/doi'

const PAGES_SCANNED = 2

export async function detectDoi(pdf: PDFDocumentProxy): Promise<string | null> {
  const texts: string[] = []
  try {
    const { info, metadata } = await pdf.getMetadata()
    texts.push(...stringValues(info))
    if (metadata) {
      // pdf.js's Metadata exposes getAll(): Record<name, string | string[]>
      const all = (metadata as { getAll?: () => Record<string, unknown> }).getAll?.()
      if (all) texts.push(...stringValues(all))
    }
  } catch {
    // Unreadable metadata is not a reason to skip the page text
  }
  const fromMeta = doiFromTexts(texts)
  if (fromMeta) return fromMeta
  for (let i = 1; i <= Math.min(PAGES_SCANNED, pdf.numPages); i++) {
    try {
      const page = await pdf.getPage(i)
      const content = await page.getTextContent()
      // Items are joined WITHOUT a separator: a DOI in a footer often arrives
      // as two items («https://doi.org/10.1007/» + «s11528-007-0040-x»), and a
      // space would cut it in half. Words the layer already separates carry
      // their own spaces; a line end becomes a newline so a DOI never runs
      // into the next line's first word.
      let text = ''
      for (const item of content.items) {
        if ('str' in item) {
          text += item.str
          if (item.hasEOL) text += '\n'
        }
      }
      const found = doiFromTexts([text])
      if (found) return found
    } catch {
      // A page that fails to load has no text to scan
    }
  }
  return null
}

/** Every string (or string-array member) among an object's values, one
 *  level deep (`info.Custom` is a nested dictionary of producer-specific keys). */
function stringValues(o: unknown): string[] {
  const out: string[] = []
  if (o === null || typeof o !== 'object') return out
  for (const v of Object.values(o as Record<string, unknown>)) {
    if (typeof v === 'string') out.push(v)
    else if (v !== null && typeof v === 'object')
      // An array (dc:identifier) and a nested dictionary (info.Custom) alike
      for (const x of Object.values(v as object)) if (typeof x === 'string') out.push(x)
  }
  return out
}
