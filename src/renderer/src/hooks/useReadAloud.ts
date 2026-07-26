// Read aloud: speak the document sentence by sentence and follow along on the
// page.
//
// This is the one part of the viewer that drives an outside engine — the
// platform speech synthesiser — and it is the one part hidden behind a flag
// (READ_ALOUD, see flags.ts: Chromium on Windows only exposes the robotic SAPI5
// voices). Its own file is what lets the flag stay off, and lets a local neural
// TTS replace the engine, without either touching the component.
//
// It borrows rather than owns. The sentence being spoken is drawn with the
// SEARCH hit overlay — one highlight mechanism for the page, so the two can
// never fight over it — and the sentence offsets come from the page texts search
// and the AI panel already cache. That is why the caller hands in `setSearchHits`
// and `pageTextsRef` instead of this hook keeping either.
//
// Two invariants to keep whatever else changes here: a reading session is
// identified by the object in `readSessionRef`, and every utterance callback
// re-checks that it is still the current one before speaking on (a stopped
// session must not resurrect itself from a queued `onend`); and speech must never
// outlive the tab it started in, which is what the `active` teardown and the
// unmount cancel are for.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PageRect } from '../../../shared/types'
import { getLanguage } from '../i18n'
import { buildPageTexts, resolveMatchRects } from '../search'
import type { PageText } from '../search'
import type { RowLayout } from '../rotation'
// Type-only, so no runtime cycle back into the component. Importing the alias
// rather than restating `'a' | 'b'` keeps the two from drifting apart.
import type { PaneId } from '../components/PdfViewer'

interface ReadAloudDeps {
  pdf: PDFDocumentProxy | null
  /** This tab is the visible one. Speech is stopped when it stops being true. */
  active: boolean
  /** Reading starts at the page the reader is on, not at page 1 */
  currentPage: number
  containerRef: React.RefObject<HTMLDivElement | null>
  layoutRef: React.RefObject<RowLayout | null>
  /** The document's text, built once and shared with search and the AI panel */
  pageTextsRef: React.RefObject<PageText[] | null>
  scaleRef: React.RefObject<number>
  updateRange: () => void
  waitForTextLayer: (
    pane: PaneId,
    pageNumber: number,
    timeoutMs?: number
  ) => Promise<HTMLElement | null>
  /** The search-hit overlay, reused to mark the sentence being spoken */
  setSearchHits: (hits: { pageNumber: number; rects: PageRect[] } | null) => void
}

interface ReadAloud {
  readAloud: 'closed' | 'playing' | 'paused'
  readRate: number
  setReadRate: React.Dispatch<React.SetStateAction<number>>
  readVoice: string
  setReadVoice: React.Dispatch<React.SetStateAction<string>>
  voices: SpeechSynthesisVoice[]
  /** Set by the voice picker so per-document auto-selection stops overriding it */
  voiceManualRef: React.RefObject<boolean>
  startReadAloud: () => Promise<void>
  stopReadAloud: () => void
  toggleReadPause: () => void
}

interface ReadSentence {
  pageNumber: number
  start: number
  end: number
  text: string
}

export function useReadAloud({
  pdf,
  active,
  currentPage,
  containerRef,
  layoutRef,
  pageTextsRef,
  scaleRef,
  updateRange,
  waitForTextLayer,
  setSearchHits
}: ReadAloudDeps): ReadAloud {
  const [readAloud, setReadAloud] = useState<'closed' | 'playing' | 'paused'>('closed')
  const [readRate, setReadRate] = useState(1)
  const [readVoice, setReadVoice] = useState<string>('')
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const readSessionRef = useRef<{
    sentences: ReadSentence[]
    index: number
    stopped: boolean
  } | null>(null)
  const readPrefsRef = useRef({ rate: 1, voiceURI: '' })
  readPrefsRef.current = { rate: readRate, voiceURI: readVoice }

  useEffect(() => {
    const synth = window.speechSynthesis
    if (!synth) return
    const load = (): void => setVoices(synth.getVoices())
    load()
    synth.addEventListener('voiceschanged', load)
    return () => synth.removeEventListener('voiceschanged', load)
  }, [])

  // Default voice: match the app language when such a voice exists
  useEffect(() => {
    if (readVoice || voices.length === 0) return
    const wanted = getLanguage() === 'nb' ? ['nb', 'no'] : ['en']
    const match = voices.find((v) => wanted.some((p) => v.lang.toLowerCase().startsWith(p)))
    setReadVoice((match ?? voices.find((v) => v.default) ?? voices[0]).voiceURI)
  }, [voices, readVoice])

  /** The user picked a voice by hand — stop auto-selecting per document */
  const voiceManualRef = useRef(false)

  /** Crude but effective: is the document Norwegian or English? */
  const detectDocLanguage = useCallback((texts: PageText[]): 'nb' | 'en' => {
    const sample = texts
      .slice(0, 3)
      .map((p) => p.text)
      .join(' ')
      .toLowerCase()
      .slice(0, 4000)
    const nbHits =
      ((sample.match(/\b(og|ikke|det|som|på|til|med|har|å|skal|kan|fra|ved|også|eller|være)\b/g) ??
        []).length +
        (sample.match(/[æøå]/g) ?? []).length * 2)
    const enHits = (sample.match(/\b(the|of|and|that|with|this|from|which|are|have|been|their)\b/g) ??
      []).length
    return nbHits > enHits ? 'nb' : 'en'
  }, [])

  /** Best available voice for a language ("Natural" Windows voices first) */
  const pickVoiceFor = useCallback(
    (lang: 'nb' | 'en'): SpeechSynthesisVoice | null => {
      const prefixes = lang === 'nb' ? ['nb', 'no'] : ['en']
      const candidates = voices.filter((v) =>
        prefixes.some((p) => v.lang.toLowerCase().startsWith(p))
      )
      if (candidates.length === 0) return null
      return candidates.find((v) => /natural/i.test(v.name)) ?? candidates[0]
    },
    [voices]
  )

  /** Follow the spoken sentence: highlight it and keep it comfortably in view */
  const highlightSentence = useCallback(
    async (s: ReadSentence) => {
      const el = containerRef.current
      const lay = layoutRef.current
      const texts = pageTextsRef.current
      if (!el || !lay || !texts) return
      const pageTop = lay.tops[s.pageNumber - 1]
      if (Math.abs(el.scrollTop - pageTop) > el.clientHeight * 2) {
        el.scrollTop = Math.max(0, pageTop - 8)
        updateRange()
      }
      const pageEl = await waitForTextLayer('a', s.pageNumber)
      if (!pageEl || readSessionRef.current?.stopped !== false) return
      const rects = resolveMatchRects(
        pageEl,
        texts[s.pageNumber - 1],
        { pageNumber: s.pageNumber, start: s.start, end: s.end, snippet: '', snippetOffset: 0 },
        scaleRef.current
      )
      if (!rects || rects.length === 0) return
      setSearchHits({ pageNumber: s.pageNumber, rects })
      const lay2 = layoutRef.current
      if (!lay2) return
      const y = lay2.tops[s.pageNumber - 1] + rects[0].y * scaleRef.current
      const viewTop = el.scrollTop
      if (y < viewTop + 70 || y > viewTop + el.clientHeight - 150) {
        el.scrollTo({ top: Math.max(0, y - el.clientHeight * 0.3), behavior: 'smooth' })
      }
    },
    [updateRange, waitForTextLayer]
  )

  const speakFrom = useCallback(
    (index: number) => {
      const session = readSessionRef.current
      const synth = window.speechSynthesis
      if (!session || session.stopped || !synth) return
      if (index >= session.sentences.length) {
        session.stopped = true
        readSessionRef.current = null
        setReadAloud('closed')
        setSearchHits(null)
        return
      }
      session.index = index
      const s = session.sentences[index]
      const utterance = new SpeechSynthesisUtterance(s.text)
      utterance.rate = readPrefsRef.current.rate
      const voice = synth.getVoices().find((v) => v.voiceURI === readPrefsRef.current.voiceURI)
      if (voice) utterance.voice = voice
      utterance.onstart = () => void highlightSentence(s)
      utterance.onend = () => {
        if (readSessionRef.current === session && !session.stopped) speakFrom(index + 1)
      }
      utterance.onerror = () => {
        if (readSessionRef.current === session && !session.stopped) speakFrom(index + 1)
      }
      synth.speak(utterance)
    },
    [highlightSentence]
  )

  /** Split page texts into sentences with char offsets (from a given page) */
  const buildSentences = useCallback((texts: PageText[], fromPage: number): ReadSentence[] => {
    const out: ReadSentence[] = []
    for (let p = fromPage - 1; p < texts.length; p++) {
      const text = texts[p].text
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
    }
    return out
  }, [])

  const stopReadAloud = useCallback(() => {
    const session = readSessionRef.current
    if (session) session.stopped = true
    readSessionRef.current = null
    window.speechSynthesis?.cancel()
    setReadAloud('closed')
    setSearchHits(null)
  }, [])

  const startReadAloud = useCallback(async () => {
    if (!pdf || !window.speechSynthesis) return
    window.speechSynthesis.cancel()
    const texts = (pageTextsRef.current ??= await buildPageTexts(pdf))
    const sentences = buildSentences(texts, currentPage)
    if (sentences.length === 0) return
    // Read English papers with an English voice even when the UI is Norwegian
    // (and vice versa) — unless the user picked a voice themselves
    if (!voiceManualRef.current) {
      const voice = pickVoiceFor(detectDocLanguage(texts))
      if (voice) {
        setReadVoice(voice.voiceURI)
        readPrefsRef.current.voiceURI = voice.voiceURI
      }
    }
    readSessionRef.current = { sentences, index: 0, stopped: false }
    setReadAloud('playing')
    speakFrom(0)
  }, [pdf, currentPage, buildSentences, speakFrom, detectDocLanguage, pickVoiceFor])

  const toggleReadPause = useCallback(() => {
    const synth = window.speechSynthesis
    if (!synth) return
    setReadAloud((state) => {
      if (state === 'playing') {
        synth.pause()
        return 'paused'
      }
      if (state === 'paused') {
        synth.resume()
        return 'playing'
      }
      return state
    })
  }, [])

  // Never keep speaking from a background tab / after close
  useEffect(() => {
    if (!active && readSessionRef.current) stopReadAloud()
  }, [active, stopReadAloud])
  useEffect(() => () => window.speechSynthesis?.cancel(), [])

  return {
    readAloud,
    readRate,
    setReadRate,
    readVoice,
    setReadVoice,
    voices,
    voiceManualRef,
    startReadAloud,
    stopReadAloud,
    toggleReadPause
  }
}
