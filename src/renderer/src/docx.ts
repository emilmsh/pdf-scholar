// Minimal .docx writer for the annotation-summary export. A .docx is a ZIP of
// OOXML parts; we emit the smallest valid package (content types, package
// rels, styles, document) with stored (uncompressed) entries — the summaries
// are tiny, and hand-rolling ~150 lines beats pulling in a zip + docx
// dependency chain (repo convention: keep runtime deps permissive and few).

export interface DocxRunOpts {
  bold?: boolean
  italic?: boolean
  /** RRGGBB (no #) */
  color?: string
  /** Font size in points (document default is 11pt Calibri) */
  size?: number
}

function xmlEscape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function docxRun(text: string, opts: DocxRunOpts = {}): string {
  const props: string[] = []
  if (opts.bold) props.push('<w:b/>')
  if (opts.italic) props.push('<w:i/>')
  if (opts.color) props.push(`<w:color w:val="${opts.color}"/>`)
  // w:sz is in half-points
  if (opts.size) props.push(`<w:sz w:val="${Math.round(opts.size * 2)}"/>`)
  const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : ''
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`
}

export function docxParagraph(runs: string, style?: 'Title' | 'Heading1'): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''
  return `<w:p>${pPr}${runs}</w:p>`
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

const CONTENT_TYPES = `${XML_DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`

const PACKAGE_RELS = `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`

const DOCUMENT_RELS = `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`

// Heading1 mirrors the HTML export's page headings (small grey uppercase) and
// carries outlineLvl 0 so pages show up in Word's navigation pane.
const STYLES = `${XML_DECL}
<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="60"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:caps/><w:color w:val="6E6E73"/><w:sz w:val="20"/></w:rPr></w:style></w:styles>`

// A4 with 2.5cm margins (values in twentieths of a point)
const SECT_PR =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1417" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'

export function makeDocx(paragraphs: string[]): Uint8Array {
  const documentXml = `${XML_DECL}
<w:document ${W_NS}><w:body>${paragraphs.join('')}${SECT_PR}</w:body></w:document>`
  const enc = new TextEncoder()
  return zipStore([
    // [Content_Types].xml first — naive OPC readers expect it as the first entry
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(PACKAGE_RELS) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(DOCUMENT_RELS) },
    { name: 'word/styles.xml', data: enc.encode(STYLES) },
    { name: 'word/document.xml', data: enc.encode(documentXml) }
  ])
}

// ---------- ZIP (store-only) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Build a ZIP with all entries stored (method 0). Names must be ASCII. */
function zipStore(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder()
  const now = new Date()
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
  const dosDate =
    (Math.max(0, now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
  const files = entries.map((e) => ({
    name: enc.encode(e.name),
    data: e.data,
    crc: crc32(e.data),
    offset: 0
  }))
  const localTotal = files.reduce((n, f) => n + 30 + f.name.length + f.data.length, 0)
  const centralTotal = files.reduce((n, f) => n + 46 + f.name.length, 0)
  const out = new Uint8Array(localTotal + centralTotal + 22)
  const view = new DataView(out.buffer)
  let pos = 0
  for (const f of files) {
    // Local file header (flags/method/extra stay 0 = stored)
    f.offset = pos
    view.setUint32(pos, 0x04034b50, true)
    view.setUint16(pos + 4, 20, true)
    view.setUint16(pos + 10, dosTime, true)
    view.setUint16(pos + 12, dosDate, true)
    view.setUint32(pos + 14, f.crc, true)
    view.setUint32(pos + 18, f.data.length, true)
    view.setUint32(pos + 22, f.data.length, true)
    view.setUint16(pos + 26, f.name.length, true)
    out.set(f.name, pos + 30)
    out.set(f.data, pos + 30 + f.name.length)
    pos += 30 + f.name.length + f.data.length
  }
  const centralStart = pos
  for (const f of files) {
    // Central directory entry
    view.setUint32(pos, 0x02014b50, true)
    view.setUint16(pos + 4, 20, true)
    view.setUint16(pos + 6, 20, true)
    view.setUint16(pos + 12, dosTime, true)
    view.setUint16(pos + 14, dosDate, true)
    view.setUint32(pos + 16, f.crc, true)
    view.setUint32(pos + 20, f.data.length, true)
    view.setUint32(pos + 24, f.data.length, true)
    view.setUint16(pos + 28, f.name.length, true)
    view.setUint32(pos + 42, f.offset, true)
    out.set(f.name, pos + 46)
    pos += 46 + f.name.length
  }
  // End of central directory
  view.setUint32(pos, 0x06054b50, true)
  view.setUint16(pos + 8, files.length, true)
  view.setUint16(pos + 10, files.length, true)
  view.setUint32(pos + 12, pos - centralStart, true)
  view.setUint32(pos + 16, centralStart, true)
  return out
}
