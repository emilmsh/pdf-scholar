// A local file picked for the assistant's paperclip (shared/file-context.ts)
// read into text, here in the renderer where pdf.js lives.
//
// A PDF goes through the same text path as the open document (buildPageText
// — pdf.js's text layer, and the OCR fallback for a scanned page when the
// engine is installed), so a scanned attachment is read too, at the OCR's
// pace. A text file is taken as it is. Anything else is refused by name
// rather than sent as garbage: the error codes are the app's, translated in
// the panel ([[feedback-named-failures]]).
import { openDocument } from './pdf-doc'
import type { DocResources } from './pdf-doc'
import { buildPageText } from './search'

export type AttachFileError = 'ai-file-type' | 'ai-file-unreadable' | 'ai-file-no-text'

export type AttachFileResult =
  | { ok: true; name: string; text: string }
  | { ok: false; error: AttachFileError; name: string }

/** Plain-text formats a model can read as they are */
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|tex|bib|log)$/i

export async function readAttachableFile(file: File): Promise<AttachFileResult> {
  const name = file.name
  if (/\.pdf$/i.test(name)) {
    let res: DocResources | null = null
    try {
      res = openDocument(new Uint8Array(await file.arrayBuffer()))
      const pdf = await res.task.promise
      const parts: string[] = []
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await buildPageText(pdf, i)
        const text = page.text.trim()
        if (text) parts.push(text)
      }
      const text = parts.join('\n\n')
      if (!text.trim()) return { ok: false, error: 'ai-file-no-text', name }
      return { ok: true, name, text }
    } catch {
      return { ok: false, error: 'ai-file-unreadable', name }
    } finally {
      // The document was opened only to be read: let the worker go
      await res?.task.destroy().catch(() => {})
      res?.port.terminate()
    }
  }
  if (TEXT_EXT.test(name)) {
    try {
      const text = await file.text()
      if (!text.trim()) return { ok: false, error: 'ai-file-no-text', name }
      return { ok: true, name, text }
    } catch {
      return { ok: false, error: 'ai-file-unreadable', name }
    }
  }
  return { ok: false, error: 'ai-file-type', name }
}

/** What the file picker offers: the formats readAttachableFile takes */
export const ATTACHABLE_ACCEPT = '.pdf,.txt,.md,.markdown,.csv,.tsv,.json,.tex,.bib,.log'
