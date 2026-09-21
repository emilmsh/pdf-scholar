// XFA forms, read-only.
//
// An XFA form (Adobe LiveCycle / AEM Forms) carries its real content as XML
// in /AcroForm /XFA; the PDF pages underneath are a one-page "Please wait…"
// placeholder. pdf.js lays that XML out as HTML — the same engine Firefox
// shows these forms with — and this module puts that HTML on our page.
//
// What we do NOT do, on purpose (Emil, 2026-09-21): fill or save. Filling
// means writing the XFA datasets back, which only pdf.js could do — and pdf.js
// never writes in this app. XFA was deprecated in PDF 2.0 (ISO 32000-2, 2017)
// and Chrome/Edge do not open these at all, so reading is the whole ambition.
// Every control is therefore rendered inert, and the viewer hides its
// annotation tools for the document: the pages you see do not exist as PDF
// pages, so a highlight would land on the placeholder page in the file.
//
// pdf.js only treats a document this way when the catalog says
// /NeedsRendering true AND the form has no AcroForm fields (a dynamic form) —
// a static XFA form with an AcroForm twin keeps rendering from its PDF pages,
// and every other document is untouched by the flag (`test:xfa` pins this).
import { XfaLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist'

/** Whether pdf.js is showing this document from its XFA layout rather than its
 *  PDF pages. Read from the loaded document, so a reload keeps the answer. */
export function isXfaDocument(pdf: PDFDocumentProxy | null | undefined): boolean {
  return pdf?.isPureXfa === true
}

export interface XfaLayerHandle {
  /** Re-scale the laid-out form for a new viewport. Cheap: one transform. */
  update(viewport: PageViewport): void
}

/** Every text node pdf.js laid out is wrapped in one of these, so search can
 *  measure a match against the same 1:1 run list it uses for the text layer
 *  (see search.ts — the wrapped nodes ARE getTextContent()'s items, in order). */
export const XFA_TEXT_CLASS = 'xfa-text'

/**
 * Lay one page of an XFA form out into `host` as inert HTML.
 *
 * `viewport` is the page's display viewport (scale + rotation): pdf.js lays
 * the form out in CSS px at scale 1 and transforms the whole layer, so a zoom
 * is a transform change (`update`), never a rebuild. Returns null when the
 * page has no XFA content (the caller then falls back to nothing — the canvas
 * has already painted the blank placeholder page).
 */
export async function renderXfaLayer(
  page: PDFPageProxy,
  host: HTMLElement,
  viewport: PageViewport,
  onExternalLink: (url: string) => void
): Promise<XfaLayerHandle | null> {
  const xfaHtml = await page.getXfa()
  if (!xfaHtml) return null
  const div = document.createElement('div')
  // The only thing pdf.js asks a link service for here: dress an <a>. External
  // links hand off to the system browser like the ones in a normal document.
  const linkService = {
    addLinkAttributes(link: HTMLAnchorElement, url: string): void {
      link.href = url
      link.title = url
      link.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        onExternalLink(url)
      })
    }
  }
  // intent 'print' is pdf.js's own read-only mode: no storage listeners are
  // attached, so typing could never reach a value that nothing would save.
  type LinkService = Parameters<typeof XfaLayer.render>[0]['linkService']
  const params = {
    viewport: viewport.clone({ dontFlip: true }),
    div,
    xfaHtml,
    linkService: linkService as unknown as LinkService,
    intent: 'print'
  }
  const { textDivs } = XfaLayer.render(params)
  // Search's spans. Empty text nodes are skipped exactly as buildPageText skips
  // empty items, so the two lists stay parallel.
  for (const node of textDivs) {
    if (!(node instanceof Text) || node.data === '') continue
    const span = document.createElement('span')
    span.className = XFA_TEXT_CLASS
    node.replaceWith(span)
    span.append(node)
  }
  // Inert controls: unfocusable and read-only in the DOM, and pointer-events
  // off in CSS (.xfa-host) so a checkbox cannot toggle either. Their values
  // still show — a form is read for what it says, defaults included.
  for (const el of div.querySelectorAll<HTMLElement>('input, textarea, select, button')) {
    el.tabIndex = -1
    el.setAttribute('aria-readonly', 'true')
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.readOnly = true
  }
  host.replaceChildren(div)
  return {
    update(next: PageViewport): void {
      // update() reads only viewport and div; the type asks for the full set
      XfaLayer.update({ ...params, viewport: next.clone({ dontFlip: true }) })
    }
  }
}
