// Local files attached to a question as context (Emil, 2026-10-24: the
// composer's «Samtaler» button became a paperclip that takes earlier
// conversations, images AND files — notes, another paper, a data sheet).
//
// The same shape as the conversations block (conversation-context.ts): the
// reader chooses, the files ride in a block of their own in the SYSTEM prompt,
// rebuilt from what is attached at that moment — never folded into a user
// message, never into the document. What the model is told: the document is
// the only source. A file is context the reader supplied; an answer that uses
// one says which file in plain words. No tags and no chips: a file is not a
// place the app can open, so there is nothing for a chip to do.
//
// Only text travels: a PDF's extractable text, a text file as it is. Each file
// is capped, and the block as a whole, so one long report cannot crowd the
// document out of a tight request (the panel takes the block's size off the
// document's budget, as it does for conversations). Pure, Node-testable
// (scripts/test-file-context.mjs).
import { capTranscript } from './conversation-context'

export interface AttachedFile {
  name: string
  text: string
}

export const MAX_FILES = 5
/** Per file, and for the block as a whole (≈ 11 000 / 22 000 tokens) */
export const MAX_FILE_CHARS_EACH = 40_000
export const MAX_FILE_CHARS_TOTAL = 80_000

export interface FilesBlock {
  /** The system-prompt block; '' when nothing could be attached */
  text: string
  /** The names that are in it, in order */
  included: string[]
  /** Those whose text was cut to fit */
  cut: string[]
  /** Those left out entirely (the block was full) */
  left: string[]
}

const RULES = `ATTACHED FILES — supplied by the reader for this question.
These are files the reader chose to send along: notes, another paper, a data sheet. They are context, NOT the document.
RULES:
- The document attached to this conversation is the only thing you cite as a source. Never put a document citation (a [KILDE …] marker or any other source citation) on something taken from these files.
- When you use something from one of them, say which file in plain words, e.g. «according to the attached file notes.md».
- Where a file disagrees with the document, say that they disagree; for claims about the document, the document wins.
- Leave them out of the answer when they do not bear on the question.`

/** The block for the system prompt, with each file capped and the whole
 *  within MAX_FILE_CHARS_TOTAL. A file with no text is left out. */
export function attachedFilesBlock(files: AttachedFile[]): FilesBlock {
  const included: string[] = []
  const cut: string[] = []
  const left: string[] = []
  const sections: string[] = []
  let remaining = MAX_FILE_CHARS_TOTAL
  for (const file of files.slice(0, MAX_FILES)) {
    const full = file.text.trim()
    if (!full) continue
    if (remaining < 200) {
      left.push(file.name)
      continue
    }
    const capped = capTranscript(full, Math.min(MAX_FILE_CHARS_EACH, remaining))
    if (capped.cut) cut.push(file.name)
    included.push(file.name)
    sections.push(`[FILE ${included.length}] "${file.name}"\n${capped.text}`)
    remaining -= capped.text.length
  }
  if (included.length === 0) return { text: '', included, cut, left }
  return { text: `\n\n${RULES}\n\n${sections.join('\n\n')}`, included, cut, left }
}

/** Roughly what a file costs, for the chip (4 chars ≈ 1 token) */
export function fileTokens(file: AttachedFile): number {
  return Math.round(Math.min(file.text.length, MAX_FILE_CHARS_EACH) / 4)
}
