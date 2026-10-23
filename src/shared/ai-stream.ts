// A streamed answer as content parts, so citation chips appear while the answer
// is still being written instead of all at once when it ends.
//
// Two citation routes reach the panel (ai-provider-profile.ts):
//   - native (Anthropic, mock): each text block opens with its citations, then
//     streams its words. The deltas say so ('block', 'citation'), and the parts
//     here are built per block — the same parts the final result holds, so the
//     settled answer replaces the streamed one without anything moving.
//   - contract (every other provider): the citation is text, a [KILDE s.N: "…"]
//     marker in the answer. The streamed text is parsed with the same rule the
//     final answer is, and a marker still being written is held back, so the
//     raw marker never shows and its chip appears the moment it closes.
//
// Pure and dependency-free: main, the extension and the renderer all import it,
// and ai-chat.ts (which pulls the provider SDKs) must stay out of the renderer.
import type { AiCitation, AiContentPart, AiDeltaKind } from './types'

/** Split text on [KILDE s.N: "quote"] markers into parts with quote citations */
export function parseQuoteContract(text: string): AiContentPart[] {
  // Tolerant: curly quotes, «Kilde» casing, flexible spacing around the colon, and
  // inner quotes inside the excerpt — the content is matched lazily and only closes
  // on a quote immediately followed by "]", so a model that puts (often escaped)
  // quotes inside the excerpt no longer breaks the match. Escapes are stripped below
  // so the quote stays a verbatim document substring for locate + highlight.
  // The source token is any short bracket-safe run, not the literal KILDE:
  // models (Gemini, observed 2026-08-12) substitute the document's filename
  // ("[grebe2015-edoc.pdf s.2: …]"), and a marker that names the right page
  // and quote is a citation regardless of what the model called the source.
  const regex = /\s*\[[^\n[\]:«"“]{1,80}?\s+s\.?\s*(\d+)\s*:\s*[«"“]([\s\S]{5,300}?)["»”]\]/gi
  const parts: AiContentPart[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    parts.push({
      text: text.slice(last, match.index),
      citations: [
        {
          kind: 'quote',
          pageNumber: parseInt(match[1], 10),
          // Unescape \" and \\ so the quote stays a verbatim document substring
          quote: match[2].replace(/\\(["\\])/g, '$1').trim()
        }
      ]
    })
    last = regex.lastIndex
  }
  const tail = text.slice(last)
  if (tail.trim() || parts.length === 0) parts.push({ text: tail, citations: [] })
  return parts
}

// What a marker looks like before it is finished: the complete pattern above
// with every piece after the opening bracket optional. Bounded like the full
// one (80 for the source, 300 for the excerpt), so prose with a stray «[» is
// held back for at most a few hundred characters, never to the end.
const MARKER_PREFIX_RE =
  /^\[[^\n[\]:«"“]{0,80}?(?:\s+s\.?\s*(?:\d+\s*(?::\s*(?:[«"“][\s\S]{0,300})?)?)?)?$/i
const MARKER_CLOSE_RE = /["»”]\]/
const MARKER_MAX = 400

/** Where a [KILDE …] marker still being written begins, or text.length when
 *  the text does not end inside one. The earliest candidate wins: an excerpt
 *  may itself contain brackets («see [12]»), and those belong to the marker. */
export function pendingMarkerStart(text: string): number {
  for (let at = text.indexOf('[', Math.max(0, text.length - MARKER_MAX)); at !== -1; at = text.indexOf('[', at + 1)) {
    if (text[at - 1] === '\\') continue // \[ opens display math, not a marker
    const candidate = text.slice(at)
    // A closed marker that did not parse is text, and stays visible
    if (MARKER_CLOSE_RE.test(candidate)) continue
    if (MARKER_PREFIX_RE.test(candidate)) return at
  }
  return text.length
}

/** Fold one delta into the streamed parts. Returns a new array (React state);
 *  thinking deltas change nothing. */
export function appendDelta(
  parts: AiContentPart[],
  text: string,
  kind?: AiDeltaKind,
  citation?: AiCitation
): AiContentPart[] {
  if (kind === 'thinking') return parts
  const last = parts[parts.length - 1]
  if (kind === 'block') {
    // An opened block that never got anything is reused, not stacked
    return last && last.text === '' && last.citations.length === 0
      ? parts
      : [...parts, { text: '', citations: [] }]
  }
  const head = last ? parts.slice(0, -1) : []
  const open = last ?? { text: '', citations: [] }
  if (kind === 'citation') {
    return citation ? [...head, { ...open, citations: [...open.citations, citation] }] : parts
  }
  return text ? [...head, { ...open, text: open.text + text }] : parts
}

/** The streamed parts as they should be shown right now. `contract` = the
 *  provider cites through [KILDE …] markers in the text. */
export function streamingParts(parts: AiContentPart[], contract: boolean): AiContentPart[] {
  const out: AiContentPart[] = []
  parts.forEach((part, i) => {
    const open = i === parts.length - 1
    // A native citation arrives as its block opens, before the words it
    // supports. Held until the block is done, the chip lands once, at the end
    // of a finished sentence, rather than riding the end of one being written.
    const citations = open ? [] : part.citations
    if (!contract) {
      out.push({ text: part.text, citations })
      return
    }
    const sub = parseQuoteContract(open ? part.text.slice(0, pendingMarkerStart(part.text)) : part.text)
    sub[sub.length - 1].citations.push(...citations)
    out.push(...sub)
  })
  return out
}

/** The deltas a native-citation stream would have delivered for these parts:
 *  each part opens a block, names its citations, then streams its text in the
 *  pieces `split` cuts. For the stand-in streams (the mock providers, the
 *  recorded answers the screenshots replay), so they stream like the real one. */
export function partsAsDeltas(
  parts: AiContentPart[],
  split: (text: string) => string[]
): { text: string; kind?: AiDeltaKind; citation?: AiCitation }[] {
  return parts.flatMap((part) => [
    { text: '', kind: 'block' as const },
    ...part.citations.map((citation) => ({ text: '', kind: 'citation' as const, citation })),
    ...split(part.text).map((text) => ({ text }))
  ])
}
