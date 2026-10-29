// What the reader has noted in a document — its annotations, each with the
// text it marks — kept per document so a tool OUTSIDE the app can find it
// without reading the PDF (Emil, 2026-10-29: Claude Code, Claude Desktop,
// Codex «simply finding everything noted and asked about a PDF»).
//
// The annotations live in the PDF itself, and the text a highlight covers is
// not in the file at all — the viewer recovers it from the page's text
// (annot-export.ts). An outside tool could do neither for 700 papers per
// question, so the viewer writes what it already has on screen into a small
// record whenever a document's marks settle (desktop: userData/notes, one
// file per document, src/main/notes-store.ts). Nothing to set up and nothing
// in the reader's own folders: the store lives beside the conversations, and
// the MCP server (src/main/mcp-server.ts) reads both.
//
// What a record keeps is what reads as a NOTE: every markup with the words it
// marks, every note and text box with its text, a drawing or shape only when
// it carries a comment, a signature never. A password-protected document
// keeps nothing but the fact that it is locked — the same line the picture
// and OCR stores hold (an encrypted file's words in the clear on disk are
// exactly what the encryption withholds) — and that marker is also what keeps
// its conversations away from an outside tool.
//
// A stored record is untrusted input, like every store here: a hand-edited or
// version-skewed file comes back as what still parses. Pure functions,
// Node-testable (scripts/test-research-notes.mjs).
import type { AiCitation, AnnotationType } from './types'
import type { StoredConversation } from './chat-history'
import { queryTerms, snippetAround } from './chat-history'
import type { ChatMarkdownLabels } from './chat-markdown'
import { messagesMarkdown } from './chat-markdown'

export interface NoteEntry {
  page: number
  type: AnnotationType
  /** The text the mark covers ('' for a note, a text box or a shape) */
  excerpt: string
  /** The reader's comment; a text box's own text. No author: a mark's
   *  author is a person's name, and nothing here needs it. */
  comment: string
  /** '#rrggbb' — a reader's colour code («yellow = method») is meaning too */
  color?: string | undefined
}

export interface DocNotes {
  path: string
  name: string
  /** The title the document's metadata gives, when it reads as one */
  title?: string | undefined
  doi?: string | undefined
  pages?: number | undefined
  /** When the record was last written (ms) */
  updatedAt: number
  /** Password-protected: no notes are kept, and an outside tool is given
   *  neither notes nor conversations for it */
  locked?: true | undefined
  notes: NoteEntry[]
}

/** Bounds on a stored record — against garbage, not against use */
export const MAX_NOTES_PER_DOC = 5000
const MAX_EXCERPT = 4000
const MAX_COMMENT = 20000

const MARKUP: ReadonlySet<string> = new Set(['highlight', 'underline', 'strikeout', 'squiggly'])
const TEXTUAL: ReadonlySet<string> = new Set(['note', 'freetext'])
const DRAWN: ReadonlySet<string> = new Set(['ink', 'square', 'circle', 'line', 'arrow'])

/** Whether a mark says anything an outside reader can use: a markup always
 *  (it marks words), a note or text box when it holds text, a drawing or
 *  shape only when the reader wrote a comment on it, a signature never. */
export function noteWorthy(type: string, excerpt: string, comment: string): boolean {
  if (MARKUP.has(type)) return !!(excerpt.trim() || comment.trim())
  if (TEXTUAL.has(type) || DRAWN.has(type)) return !!comment.trim()
  return false
}

/** The metadata title, when it is one. Producers fill /Title with the file
 *  name, the word processor's document name or nothing useful at all. */
export function plausibleTitle(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const t = raw.replace(/\s+/g, ' ').trim()
  if (t.length < 4 || t.length > 300) return undefined
  if (/^(microsoft (word|powerpoint) - |untitled\b)/i.test(t)) return undefined
  if (/\.(pdf|docx?|tex|dvi|ps|indd|pages|odt|rtf)$/i.test(t)) return undefined
  // A bare identifier (a manuscript number, a hash) is not a title
  if (!/\s/.test(t) && !/[a-zæøå]{4}/i.test(t)) return undefined
  return t
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

function sanitizeEntry(e: unknown): NoteEntry | null {
  if (!isObj(e)) return null
  const page = e.page
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return null
  if (typeof e.type !== 'string') return null
  const excerpt = str(e.excerpt, MAX_EXCERPT)
  const comment = str(e.comment, MAX_COMMENT)
  if (!noteWorthy(e.type, excerpt, comment)) return null
  const color = typeof e.color === 'string' && /^#[0-9a-f]{6}$/.test(e.color) ? e.color : undefined
  return { page, type: e.type as AnnotationType, excerpt, comment, ...(color ? { color } : {}) }
}

export function sanitizeDocNotes(input: unknown): DocNotes | null {
  if (!isObj(input) || typeof input.path !== 'string' || !input.path) return null
  const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : ''
  if (!name) return null
  const updatedAt =
    typeof input.updatedAt === 'number' && Number.isFinite(input.updatedAt) && input.updatedAt >= 0
      ? input.updatedAt
      : 0
  const pages =
    typeof input.pages === 'number' && Number.isInteger(input.pages) && input.pages > 0 ? input.pages : undefined
  const doi = typeof input.doi === 'string' && /^10\.\d{4,9}\/\S{1,300}$/.test(input.doi) ? input.doi : undefined
  const title = plausibleTitle(input.title)
  const base = {
    path: input.path,
    name,
    updatedAt,
    ...(title ? { title } : {}),
    ...(doi ? { doi } : {}),
    ...(pages ? { pages } : {})
  }
  if (input.locked === true) return { ...base, locked: true, notes: [] }
  const notes: NoteEntry[] = []
  if (Array.isArray(input.notes)) {
    for (const e of input.notes) {
      const clean = sanitizeEntry(e)
      if (clean) notes.push(clean)
      if (notes.length >= MAX_NOTES_PER_DOC) break
    }
  }
  // Page order, the order a reader meets them; the sort is stable, so marks
  // on one page keep the top-to-bottom order the viewer wrote them in
  notes.sort((a, b) => a.page - b.page)
  return { ...base, notes }
}

/** Whether a record is worth keeping at all: something noted, or the lock
 *  that withholds the document's conversations */
export const worthKeeping = (doc: DocNotes): boolean => doc.locked === true || doc.notes.length > 0

// ---------- Reading it out ----------

/** The words the Markdown is written in. English for an outside tool (the
 *  MCP server has no UI language — a model reads English labels around
 *  Norwegian notes as well as any); the interface's own for the reader's
 *  «Kopier for KI». */
export interface NotesLabels {
  annotType(type: string): string
  page(n: number): string
  title: string
  doi: string
  pages: string
  annotations(count: number): string
}

export const ENGLISH_NOTES_LABELS: NotesLabels = {
  annotType: (type) =>
    ({
      highlight: 'Highlight',
      underline: 'Underline',
      strikeout: 'Strikethrough',
      squiggly: 'Squiggly underline',
      note: 'Note',
      ink: 'Pen',
      square: 'Rectangle',
      circle: 'Ellipse',
      line: 'Line',
      arrow: 'Arrow',
      freetext: 'Text box'
    })[type] ?? type,
  page: (n) => `Page ${n}`,
  title: 'Title',
  doi: 'DOI',
  pages: 'Pages',
  annotations: (count) => `Annotations (${count})`
}

/** One mark as a line: what it is, the words it marks in «», the comment */
export function noteLine(e: NoteEntry, labels: NotesLabels): string {
  let line = `- **${labels.annotType(e.type)}**`
  const excerpt = e.excerpt.replace(/\s+/g, ' ').trim()
  const comment = e.comment.trim()
  if (excerpt) line += `: «${excerpt}»`
  // A comment over several lines stays one list item: its line breaks indent
  if (comment) line += `${excerpt ? ' — ' : ': '}${comment.replace(/\n+/g, '\n  ')}`
  return line
}

/** The document's facts as the head of its Markdown: the lines after the
 *  heading. Never its path — a folder's name can be a client's, and nothing
 *  outside the app needs to know where a file lives (Emil, 2026-10-29) — and
 *  never who wrote a mark. `id` = the handle an outside tool asks by. */
export function docFactsMarkdown(doc: Pick<DocNotes, 'title' | 'doi' | 'pages'>, labels: NotesLabels, id?: string): string[] {
  const out: string[] = []
  if (doc.title) out.push(`${labels.title}: ${doc.title}`)
  if (doc.doi) out.push(`${labels.doi}: ${doc.doi}`)
  if (doc.pages) out.push(`${labels.pages}: ${doc.pages}`)
  if (id) out.push(`id: ${id}`)
  return out
}

/** The marks, a heading per page — '' when there are none */
export function notesMarkdown(notes: NoteEntry[], labels: NotesLabels, heading = '##'): string {
  if (notes.length === 0) return ''
  const out: string[] = [`${heading} ${labels.annotations(notes.length)}`]
  let page = 0
  for (const e of notes) {
    if (e.page !== page) {
      page = e.page
      out.push('', `${heading}# ${labels.page(page)}`, '')
    }
    out.push(noteLine(e, labels))
  }
  return out.join('\n')
}

export interface DocumentMarkdownOptions {
  notes: NotesLabels
  chat: ChatMarkdownLabels
  conversations(count: number): string
  untitled: string
  date(ms: number): string
  /** The citation marker; plainCitationMarker when absent */
  marker?: ((c: AiCitation) => string) | undefined
  /** The document's id for an outside tool (get_document_notes takes it) */
  docId?: string | undefined
  /** A conversation's id beside its heading — what an outside tool asks
   *  get_conversation for */
  ids?: boolean | undefined
  /** Above this, the remaining conversations are listed by title, not
   *  written out — `omitted` says how to get them */
  maxChars?: number | undefined
  omitted?(count: number): string
}

/** Everything about one document as one Markdown text: its facts, its marks
 *  by page, its conversations whole. What get_document_notes answers and what
 *  «Kopier for KI» puts on the clipboard. */
export function documentMarkdown(
  doc: DocNotes,
  conversations: StoredConversation[],
  o: DocumentMarkdownOptions
): string {
  const facts = docFactsMarkdown(doc, o.notes, o.docId).join('\n')
  const parts: string[] = [`# ${doc.name}`, ...(facts ? [facts] : [])]
  const notes = notesMarkdown(doc.notes, o.notes)
  if (notes) parts.push(notes)
  if (conversations.length > 0) {
    parts.push(`## ${o.conversations(conversations.length)}`)
    let used = parts.join('\n\n').length
    const left: StoredConversation[] = []
    for (const c of conversations) {
      const head = `### ${c.title.trim() || o.untitled}\n\n*${o.date(c.updatedAt)}${o.ids ? ` · id: ${c.id}` : ''}*`
      const body = [head, ...messagesMarkdown(c.messages, o.chat, o.marker)].join('\n\n')
      // Newest first, and once one does not fit none after it is written —
      // a list with a gap in it would read as the whole story
      if (left.length > 0 || (o.maxChars !== undefined && used + body.length > o.maxChars)) {
        left.push(c)
        continue
      }
      parts.push(body)
      used += body.length + 2
    }
    if (left.length > 0) {
      parts.push(
        [
          o.omitted?.(left.length) ?? '',
          ...left.map((c) => `- ${c.title.trim() || o.untitled} (${o.date(c.updatedAt)}${o.ids ? ` · id: ${c.id}` : ''})`)
        ]
          .filter(Boolean)
          .join('\n')
      )
    }
  }
  return `${parts.join('\n\n')}\n`
}

// ---------- Searching it ----------

export interface NoteHit {
  docPath: string
  docName: string
  page: number
  type: AnnotationType
  /** The text around the first match — the mark's excerpt or its comment */
  snippet: string
}

/** The marks every word of the query occurs in (excerpt and comment read as
 *  one text, case-folded, regex characters literal — the conversation
 *  search's rule), newest document first, page order within one. */
export function searchNotes(docs: DocNotes[], query: string): NoteHit[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return []
  const hits: NoteHit[] = []
  for (const doc of [...docs].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (doc.locked) continue
    for (const e of doc.notes) {
      const text = [e.excerpt.replace(/\s+/g, ' ').trim(), e.comment.trim()].filter(Boolean).join(' — ')
      let first: RegExpExecArray | null = null
      let all = true
      for (const re of terms) {
        const m = re.exec(text)
        if (!m) {
          all = false
          break
        }
        first ??= m
      }
      if (!all || !first) continue
      hits.push({
        docPath: doc.path,
        docName: doc.name,
        page: e.page,
        type: e.type,
        snippet: text.length <= 300 ? text : snippetAround(text, first.index, first[0].length)
      })
    }
  }
  return hits
}
