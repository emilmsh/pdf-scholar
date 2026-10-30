// What read-aloud sends to a voice, and in what pieces.
//
// A research paper is not prose from end to end. The parts a listener does not
// want spoken are the ones a reader's eye skips without noticing: the numeric
// citation brackets in every other sentence, the hyphen a line break split a
// word with, a DOI, and the whole reference list at the end. The rules here are
// deliberately few and conservative — a word dropped by a clever rule is worse
// than a «[12]» read out — and they shape only what is SPOKEN: the sentence
// offsets the highlight follows still address the page text itself.
//
// A cloud voice is also paid and asked per request, so sentences are grouped
// into chunks of a paragraph's length: one request per sentence costs a round
// trip each and reads every sentence with a fresh, flat intonation, one per page
// makes the first sound wait for a page's worth of audio.

export interface SpokenSentence {
  pageNumber: number
  /** Offsets into the page text — what the highlight resolves */
  start: number
  end: number
  text: string
}

export interface SpeechChunk {
  /** Index of the chunk's first sentence in the session's list */
  first: number
  /** Index one past its last sentence */
  end: number
  /** What the voice is given: the sentences joined and made speakable */
  text: string
  /** Each sentence's share of `text`, in order — where the highlight moves on */
  weights: number[]
}

// A heading that opens the back matter on a line of its own, optionally
// numbered («7 References», «8. Bibliography»). The words a heading uses, not
// a page position: a short paper's references can start on page 3.
const REFERENCES_HEADING_RE =
  /^[ \t]*(?:\d{1,2}\.?[ \t]+)?(?:references?|bibliography|works cited|literature cited|references and notes|referanser|litteratur|litteraturliste|kildeliste|参考文献)[ \t]*:?[ \t]*$/im

/** Where the reference list starts in a page's text, or -1 when it does not. */
export function referencesStart(pageText: string): number {
  const m = REFERENCES_HEADING_RE.exec(pageText)
  return m ? m.index : -1
}

/** Split page texts into sentences with offsets into each page, from a given
 *  page on, stopping at the reference list. */
export function buildSentences(texts: readonly { text: string }[], fromPage: number): SpokenSentence[] {
  const out: SpokenSentence[] = []
  for (let p = Math.max(0, fromPage - 1); p < texts.length; p++) {
    const full = texts[p].text
    const refs = referencesStart(full)
    const text = refs >= 0 ? full.slice(0, refs) : full
    const regex = /[^.!?\n]+[.!?]*[\s]*/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      const raw = match[0]
      const trimmed = raw.trim()
      if (trimmed.length < 2) continue
      const leading = raw.indexOf(trimmed[0])
      out.push({
        pageNumber: p + 1,
        start: match.index + leading,
        end: match.index + leading + trimmed.length,
        text: trimmed
      })
    }
    if (refs >= 0) break
  }
  return out
}

/** The text as it should be spoken. */
export function speakable(text: string): string {
  return (
    text
      // A word split by a line break: «infor-\nmation». Only across a line end
      // and only before a lower-case letter, so «well-known» and «COVID-19» stay.
      .replace(/(\p{L})-[ \t]*\n[ \t]*(\p{Ll})/gu, '$1$2')
      // Numeric citations: [12], [3, 5–9], [1-4]. Never a bracket with a word
      // in it — «[see 5]» and «[sic]» are the author's text.
      .replace(/[ \t]*\[\d{1,3}(?:[ \t]*[,–-][ \t]*\d{1,3})*\]/g, '')
      // Addresses are not read; a listener cannot use them
      .replace(/\b(?:https?:\/\/|doi:\s*|www\.)\S+/gi, '')
      .replace(/\s+/g, ' ')
      // A bracket taken out before a full stop leaves «word .»
      .replace(/ ([.,;:!?])/g, '$1')
      .trim()
  )
}

/** Group sentences into chunks of about `target` characters. A chunk never
 *  crosses a page — the voice should not run on past the page the highlight
 *  is on — and a sentence that speaks as nothing (a lone citation) still
 *  belongs to a chunk, with no share of its time. */
export function chunkSentences(
  sentences: readonly SpokenSentence[],
  target = 450,
  max = 1200
): SpeechChunk[] {
  const out: SpeechChunk[] = []
  let first = 0
  while (first < sentences.length) {
    let end = first
    let length = 0
    const page = sentences[first].pageNumber
    while (end < sentences.length && sentences[end].pageNumber === page) {
      const next = speakable(sentences[end].text).length
      if (end > first && (length >= target || length + next > max)) break
      length += next + 1
      end++
    }
    const parts = sentences.slice(first, end).map((s) => speakable(s.text))
    out.push({
      first,
      end,
      text: parts.filter(Boolean).join(' '),
      weights: parts.map((p) => p.length)
    })
    first = end
  }
  return out
}

/** Which sentence of a chunk is being spoken `fraction` (0–1) of the way
 *  through its audio — by its share of the characters, the best a voice that
 *  reports no word timings lets us do. Returns an index into `weights`. */
export function sentenceAt(weights: readonly number[], fraction: number): number {
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0 || !(fraction > 0)) return 0
  const at = Math.min(fraction, 1) * total
  let acc = 0
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i]
    if (at < acc) return i
  }
  return weights.length - 1
}
