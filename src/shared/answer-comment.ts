// An AI answer kept as a COMMENT on the passage it was asked about (issue #137:
// the selection bubble closes on Esc or a click outside, and the answer went
// with it).
//
// A comment is plain text — /Contents in the file, read by every other PDF
// reader — while an answer is Markdown. So the marks that only mean something
// to a renderer are taken out and the words kept. Deliberately conservative:
// anything this does not recognise stays as it was written (math, a table, a
// lone asterisk), since a stray mark is better than a lost word.

/** Markdown → the same words as plain text. */
export function plainAnswer(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let fenced = false
  for (const raw of lines) {
    // A code fence's own lines go; what is inside stays untouched
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      out.push(raw)
      continue
    }
    let line = raw
      // «## Heading» → «Heading»
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      // «* item» / «+ item» → «- item» (the indent kept)
      .replace(/^(\s*)[*+]\s+/, '$1- ')
      // «> quoted» → «quoted»
      .replace(/^\s{0,3}>\s?/, '')
    // A horizontal rule carries nothing
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue
    line = line
      // [text](url) → text (url); an image's «!» goes too
      .replace(/!?\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) =>
        text === url ? url : `${text} (${url})`
      )
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      // *emphasis*: only where the asterisks hug the words, so «2 * 3 * 4»
      // and a bullet's own marker are left alone
      .replace(/(^|[^*\w])\*(?=\S)([^*]*[^*\s])\*(?![*\w])/g, '$1$2')
      .replace(/(^|[^_\w])_(?=\S)([^_]*[^_\s])_(?![_\w])/g, '$1$2')
    out.push(line.replace(/\s+$/, ''))
  }
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The comment's text: the reader's own question first when they typed one
 *  (a chip — «Forklar» — asked nothing the marked passage does not show). */
export function answerComment(answer: string, question?: string | null): string {
  const body = plainAnswer(answer)
  const q = question?.replace(/\s+/g, ' ').trim()
  if (!q) return body
  return body ? `${q}\n\n${body}` : q
}
