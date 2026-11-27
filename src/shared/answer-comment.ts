import type { AiCitation, AiContentPart } from './types'

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

// ---------- The sources an answer stood on (issue #168) ----------
//
// A comment cannot hold a button: /Contents is plain text, and it has to read
// the same in every PDF reader. So the answer's source chips are WRITTEN as
// text — «[s. 4]» after the sentence each one supports, and under the answer
// the passages themselves, word for word, one line per marker — and this app
// reads them back out of the text and draws them as chips again
// (`commentSources`). Nothing is stored beside the file: what another reader
// shows is all there is.

/** Longest passage a comment keeps; a model may cite a whole paragraph, and
 *  the opening of one is enough to find it again (an ellipsis at the cut is
 *  what the passage lookup reads as «only the part before this») */
const SOURCE_MAX = 300

export interface AnswerSourceLabels {
  /** «s.» / «p.» / «第» — the marker is «[s. 4]» */
  pageAbbrev: string
  /** The line over the passages */
  heading: string
}

const sentinel = (i: number): string => `\uE000${i}\uE001`

/** The comment an answer with source chips becomes: the answer as plain text
 *  with a «[s. 4]» where each chip stood, and the cited passages under it.
 *  `pageOf` says which page a citation is on (null = cannot be told — it is
 *  left out). An answer that cites nothing is `answerComment`, byte for byte. */
export function answerCommentWithSources(
  parts: AiContentPart[],
  question: string | null | undefined,
  labels: AnswerSourceLabels,
  pageOf: (citation: AiCitation) => number | null
): string {
  const sources: { page: number; quote: string }[] = []
  let md = ''
  for (const part of parts) {
    // The chat's own rule (AssistantBody): a part's chips are glued to the end
    // of its text, before the whitespace that closes it
    const trailing = /\s*$/.exec(part.text)?.[0] ?? ''
    md += trailing ? part.text.slice(0, part.text.length - trailing.length) : part.text
    const seen = new Set<string>()
    for (const c of part.citations) {
      if (c.kind === 'conversation') continue
      if (c.kind === 'web') {
        // No page to go to: the address itself, once
        if (!seen.has(c.url)) md += ` (${c.url})`
        seen.add(c.url)
        continue
      }
      const page = pageOf(c)
      if (page === null || !Number.isInteger(page) || page < 1) continue
      const whole = (c.kind === 'quote' ? c.quote : c.citedText).replace(/\s+/g, ' ').trim()
      const quote =
        whole.length > SOURCE_MAX ? `${whole.slice(0, SOURCE_MAX).replace(/\s+\S*$/, '')} …` : whole
      const key = `${page}\n${quote}`
      if (seen.has(key)) continue // the same passage twice under one sentence
      seen.add(key)
      md += ` ${sentinel(sources.length)}`
      sources.push({ page, quote })
    }
    md += trailing
  }
  const marker = (page: number): string => `[${labels.pageAbbrev} ${page}]`
  // The marks go in AFTER the Markdown is taken out, so no rule of plainAnswer
  // can read a marker as a link's text
  const body = answerComment(md, question).replace(/\uE000(\d+)\uE001/g, (_m, i: string) =>
    marker(sources[Number(i)].page)
  )
  // One line per marker, in the text's order: that order is how a marker finds
  // its passage again
  const lines = sources.map((s) => `${marker(s.page)} «${s.quote}»`)
  return lines.length ? `${body}\n\n${labels.heading}\n${lines.join('\n')}` : body
}

/** A page marker as any of the three interface languages writes it */
const MARKER = String.raw`\[(?:s\.|p\.|第)\s?(\d{1,5})\]`
const SOURCE_LINE = new RegExp(String.raw`^${MARKER}\s+«(.*)»$`, 'i')

export interface CommentSource {
  page: number
  /** The cited passage, when the comment lists one for this marker */
  quote: string | null
  /** The marker's place in `body` */
  start: number
  end: number
}

export interface CommentSources {
  /** The comment without its list of passages (line ends as «\n») */
  body: string
  sources: CommentSource[]
}

/** The sources a comment's text names, or null when it names none — which is
 *  every comment a reader typed themselves, and those are shown exactly as
 *  before. A marker is «[s. 4]» / «[p. 4]» / «[第 4]» for a page the document
 *  has; its passage is the line of the closing list that opens with the same
 *  marker, taken in order (the second «[s. 4]» of the text is the second
 *  «[s. 4] «…»» line). A text edited by hand in another reader is untrusted
 *  input: a marker with no line left is a page and nothing more. */
export function commentSources(text: string, pageCount?: number): CommentSources | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let end = lines.length
  while (end > 0 && !lines[end - 1].trim()) end--
  let first = end
  while (first > 0 && SOURCE_LINE.test(lines[first - 1].trim())) first--
  const listed = lines.slice(first, end).map((line) => {
    const m = SOURCE_LINE.exec(line.trim())!
    return { page: Number(m[1]), quote: m[2].trim() }
  })
  let bodyEnd = first
  if (listed.length && first > 0) {
    // The heading over the list: one short line with a blank line above it
    const head = lines[first - 1].trim()
    const alone = first === 1 || !lines[first - 2].trim()
    if (head && alone && head.length <= 60 && !new RegExp(MARKER, 'i').test(head)) bodyEnd = first - 1
  }
  const body = lines.slice(0, bodyEnd).join('\n').trimEnd()
  const sources: CommentSource[] = []
  const taken = new Map<number, number>()
  for (const m of body.matchAll(new RegExp(MARKER, 'gi'))) {
    const page = Number(m[1])
    if (page < 1 || (pageCount !== undefined && page > pageCount)) continue
    const nth = taken.get(page) ?? 0
    taken.set(page, nth + 1)
    const quote = listed.filter((l) => l.page === page)[nth]?.quote || null
    sources.push({ page, quote, start: m.index, end: m.index + m[0].length })
  }
  // With no marker in the text itself a closing list is just lines the reader
  // wrote: nothing is folded away
  return sources.length ? { body, sources } : null
}
