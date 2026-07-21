// Annotation summary export (Phase 6). The marked-up text is recovered by
// intersecting each markup annotation's quads with the page's text items
// (positions from getTextContent), slicing items proportionally by x-overlap.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PageRect } from '../../shared/types'
import { annotTypeLabel } from './annotations'
import { docxParagraph, docxRun, makeDocx } from './docx'
import { getLanguage, t } from './i18n'
import type { PageAnnotation } from './annotations'

export interface ExportRow {
  pageNumber: number
  record: PageAnnotation
  /** Text covered by the markup quads ('' for notes and empty results) */
  excerpt: string
}

export interface ExportMeta {
  fileName: string
  exportedAt: string
}

interface PositionedItem {
  str: string
  x: number
  /** top in page space (y down) */
  y: number
  w: number
  h: number
}

async function getPositionedItems(pdf: PDFDocumentProxy, pageNumber: number): Promise<PositionedItem[]> {
  const page = await pdf.getPage(pageNumber)
  const pageHeight = page.getViewport({ scale: 1 }).height
  const content = await page.getTextContent()
  const items: PositionedItem[] = []
  for (const item of content.items) {
    if (!('str' in item) || item.str === '') continue
    const t = item.transform
    items.push({
      str: item.str,
      x: t[4],
      y: pageHeight - t[5] - item.height,
      w: item.width,
      h: item.height
    })
  }
  return items
}

function textUnderQuads(items: PositionedItem[], quads: PageRect[]): string {
  const parts: { y: number; x: number; text: string }[] = []
  for (const q of quads) {
    for (const item of items) {
      const cy = item.y + item.h / 2
      if (cy < q.y - 2 || cy > q.y + q.h + 2) continue
      // Pad the quad slightly and round outward so edge characters survive
      // the proportional slicing
      const left = Math.max(item.x, q.x - 1.5)
      const right = Math.min(item.x + item.w, q.x + q.w + 1.5)
      if (right - left < 0.5) continue
      const len = item.str.length
      const from = Math.max(0, Math.floor(((left - item.x) / item.w) * len))
      const to = Math.min(len, Math.ceil(((right - item.x) / item.w) * len))
      const text = item.str.slice(from, to)
      if (text.trim()) parts.push({ y: item.y, x: left, text })
    }
  }
  parts.sort((a, b) => a.y - b.y || a.x - b.x)
  return parts
    .map((p) => p.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Marked-up text per annotation (localId → excerpt), for the sidebar list */
export async function computeExcerpts(
  pdf: PDFDocumentProxy,
  annots: ReadonlyMap<number, PageAnnotation[]>
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const [pageNumber, list] of annots) {
    const markup = list.filter((r) => r.type !== 'note')
    if (markup.length === 0) continue
    const items = await getPositionedItems(pdf, pageNumber)
    for (const record of markup) {
      const text = textUnderQuads(items, record.quads)
      if (text) map.set(record.id, text)
    }
  }
  return map
}

export async function collectExportRows(
  pdf: PDFDocumentProxy,
  annots: ReadonlyMap<number, PageAnnotation[]>
): Promise<ExportRow[]> {
  const rows: ExportRow[] = []
  const pages = [...annots.keys()].sort((a, b) => a - b)
  for (const pageNumber of pages) {
    const list = [...(annots.get(pageNumber) ?? [])].sort(
      (a, b) => (a.quads[0]?.y ?? 0) - (b.quads[0]?.y ?? 0)
    )
    const needsText = list.some((r) => r.type !== 'note')
    const items = needsText ? await getPositionedItems(pdf, pageNumber) : []
    for (const record of list) {
      rows.push({
        pageNumber,
        record,
        excerpt: record.type === 'note' ? '' : textUnderQuads(items, record.quads)
      })
    }
  }
  return rows
}

function groupByPage(rows: ExportRow[]): Map<number, ExportRow[]> {
  const map = new Map<number, ExportRow[]>()
  for (const row of rows) {
    const list = map.get(row.pageNumber) ?? []
    list.push(row)
    map.set(row.pageNumber, list)
  }
  return map
}

function rowLine(row: ExportRow): { label: string; excerpt: string; comment: string; author: string } {
  return {
    label: annotTypeLabel(row.record.type),
    excerpt: row.excerpt,
    comment: row.record.contents ?? '',
    author: row.record.author ?? ''
  }
}

export function toMarkdown(rows: ExportRow[], meta: ExportMeta): string {
  const lines: string[] = [
    `# ${t('export.title', { name: meta.fileName })}`,
    '',
    `*${t('export.byline', { date: meta.exportedAt })}*`
  ]
  for (const [pageNumber, pageRows] of groupByPage(rows)) {
    lines.push('', `## ${t('export.page', { page: pageNumber })}`, '')
    for (const row of pageRows) {
      const { label, excerpt, comment, author } = rowLine(row)
      let line = `- **${label}**`
      if (excerpt) line += `: «${excerpt}»`
      if (comment) line += excerpt ? ` — ${comment}` : `: ${comment}`
      if (author) line += ` *(${author})*`
      lines.push(line)
    }
  }
  return lines.join('\n') + '\n'
}

export function toPlainText(rows: ExportRow[], meta: ExportMeta): string {
  const lines: string[] = [
    t('export.title', { name: meta.fileName }),
    t('export.byline', { date: meta.exportedAt })
  ]
  for (const [pageNumber, pageRows] of groupByPage(rows)) {
    lines.push('', t('export.page', { page: pageNumber }), '─'.repeat(30))
    for (const row of pageRows) {
      const { label, excerpt, comment, author } = rowLine(row)
      let line = `• ${label}`
      if (excerpt) line += `: «${excerpt}»`
      if (comment) line += excerpt ? ` — ${comment}` : `: ${comment}`
      if (author) line += ` (${author})`
      lines.push(line)
    }
  }
  return lines.join('\n') + '\n'
}

/** Same summary as the other formats, as a Word document (see docx.ts) */
export function toDocx(rows: ExportRow[], meta: ExportMeta): Uint8Array {
  const muted = '6E6E73'
  const paragraphs: string[] = [
    docxParagraph(docxRun(t('export.title', { name: meta.fileName })), 'Title'),
    docxParagraph(docxRun(t('export.byline', { date: meta.exportedAt }), { color: muted, size: 9 }))
  ]
  for (const [pageNumber, pageRows] of groupByPage(rows)) {
    paragraphs.push(docxParagraph(docxRun(t('export.page', { page: pageNumber })), 'Heading1'))
    for (const row of pageRows) {
      const { label, excerpt, comment, author } = rowLine(row)
      const hex = row.record.color
        .map((v) => Math.round(v * 255).toString(16).padStart(2, '0'))
        .join('')
      const runs = [docxRun('● ', { color: hex }), docxRun(label, { bold: true })]
      if (excerpt) runs.push(docxRun(`: «${excerpt}»`))
      if (comment) runs.push(docxRun(excerpt ? ` — ${comment}` : `: ${comment}`, { italic: true }))
      if (author) runs.push(docxRun(` (${author})`, { color: muted, size: 9 }))
      paragraphs.push(docxParagraph(runs.join('')))
    }
  }
  return makeDocx(paragraphs)
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function toHtml(rows: ExportRow[], meta: ExportMeta): string {
  const body: string[] = []
  for (const [pageNumber, pageRows] of groupByPage(rows)) {
    body.push(`<h2>${t('export.page', { page: pageNumber })}</h2><ul>`)
    for (const row of pageRows) {
      const { label, excerpt, comment, author } = rowLine(row)
      const [r, g, b] = row.record.color.map((v) => Math.round(v * 255))
      let li = `<li><span class="dot" style="background:rgb(${r},${g},${b})"></span><strong>${label}</strong>`
      if (excerpt) li += `: <q>${escapeHtml(excerpt)}</q>`
      if (comment) li += ` — <em>${escapeHtml(comment)}</em>`
      if (author) li += ` <span class="author">(${escapeHtml(author)})</span>`
      body.push(li + '</li>')
    }
    body.push('</ul>')
  }
  return `<!doctype html>
<html lang="${getLanguage() === 'nb' ? 'no' : 'en'}"><head><meta charset="utf-8"><title>${escapeHtml(t('export.title', { name: meta.fileName }))}</title>
<style>
body { font-family: 'Segoe UI', system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1d1d1f; line-height: 1.55; }
h1 { font-size: 24px; } h2 { font-size: 15px; margin-top: 28px; color: #6e6e73; text-transform: uppercase; letter-spacing: .05em; }
ul { list-style: none; padding: 0; } li { padding: 7px 0; border-bottom: 1px solid #eee; }
.dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; border: 1px solid rgba(0,0,0,.15); }
.author { color: #6e6e73; font-size: 13px; } q { quotes: '«' '»'; }
.meta { color: #6e6e73; font-size: 13px; }
</style></head><body>
<h1>${escapeHtml(t('export.title', { name: meta.fileName }))}</h1>
<p class="meta">${escapeHtml(t('export.byline', { date: meta.exportedAt }))}</p>
${body.join('\n')}
</body></html>
`
}
