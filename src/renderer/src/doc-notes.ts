// The viewer's half of a document's notes (shared/research-notes.ts): the
// record built from what the viewer already holds — the annotations, the
// words each one marks (the sidebar's excerpts), the DOI it detected — and
// the text «Kopier for KI» puts on the clipboard. No page is read for either:
// the excerpts are computed for the Merknader tab anyway.
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { StoredConversation } from '../../shared/chat-history'
import type { DocNotes, NoteEntry, NotesLabels } from '../../shared/research-notes'
import { documentMarkdown, noteWorthy, plausibleTitle } from '../../shared/research-notes'
import type { PageAnnotation } from './annotations'
import { annotTypeLabel } from './annotations'
import { chatLabels } from './chat-export'
import { locale, t } from './i18n'

const hex = (c: [number, number, number]): string =>
  `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`

export interface DocNotesInput {
  path: string
  name: string
  annots: ReadonlyMap<number, PageAnnotation[]>
  excerpts: ReadonlyMap<string, string>
  pages: number
  doi: string | null
  title: string | undefined
  /** Password-protected: the record keeps only that fact */
  locked: boolean
}

export function buildDocNotes(d: DocNotesInput): DocNotes {
  const base = {
    path: d.path,
    name: d.name,
    updatedAt: Date.now(),
    ...(d.pages ? { pages: d.pages } : {}),
    ...(d.doi ? { doi: d.doi } : {}),
    ...(d.title ? { title: d.title } : {})
  }
  if (d.locked) return { ...base, locked: true, notes: [] }
  const notes: NoteEntry[] = []
  for (const page of [...d.annots.keys()].sort((a, b) => a - b)) {
    // Top to bottom, the order the Merknader tab and the export list them
    const list = [...(d.annots.get(page) ?? [])].sort((a, b) => (a.quads[0]?.y ?? 0) - (b.quads[0]?.y ?? 0))
    for (const r of list) {
      const excerpt = r.type === 'note' ? '' : (d.excerpts.get(r.id) ?? '')
      const comment = r.contents ?? ''
      if (!noteWorthy(r.type, excerpt, comment)) continue
      notes.push({
        page,
        type: r.type,
        excerpt,
        comment,
        ...(r.author?.trim() ? { author: r.author.trim() } : {}),
        color: hex(r.color)
      })
    }
  }
  return { ...base, notes }
}

/** The metadata title, when the document's /Title reads as one */
export async function metadataTitle(pdf: PDFDocumentProxy): Promise<string | undefined> {
  try {
    const { info } = await pdf.getMetadata()
    return plausibleTitle((info as { Title?: unknown } | null)?.Title)
  } catch {
    return undefined
  }
}

function notesLabels(): NotesLabels {
  return {
    annotType: (type) => annotTypeLabel(type as PageAnnotation['type']),
    page: (n) => t('export.page', { page: n }),
    title: t('notes.title'),
    doi: 'DOI',
    file: t('notes.file'),
    pages: t('notes.pages'),
    annotations: (count) => t('notes.annotations', { count: String(count) })
  }
}

/** Everything about the document as one text for another AI tool: its
 *  facts, its marks by page, its conversations whole, in the interface's
 *  language. null = nothing noted and nothing asked. */
export function copyForAiMarkdown(doc: DocNotes, conversations: StoredConversation[]): string | null {
  if (doc.notes.length === 0 && conversations.length === 0) return null
  return documentMarkdown(doc, conversations, {
    notes: notesLabels(),
    chat: chatLabels(),
    conversations: (count) => t('notes.conversations', { count: String(count) }),
    untitled: t('ai.untitledChat'),
    date: (ms) => new Date(ms).toLocaleDateString(locale())
  })
}
