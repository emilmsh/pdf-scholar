// Read aloud: speak the document sentence by sentence and follow along on the
// page.
//
// This is the one part of the viewer that drives an outside engine, and it is
// the one part hidden behind a flag (READ_ALOUD, see flags.ts: Chromium on
// Windows only exposes the robotic SAPI5 voices). Two engines now:
//
//   - a provider's VOICE on the reader's own key (src/shared/ai-speech.ts —
//     Gemini), when one is held and KI-tilgang is not «Av». The text goes out
//     in chunks of about a paragraph (speech-text.ts), the next two fetched
//     while one plays, and the highlight moves through a chunk's sentences by
//     their share of its characters — a voice that reports no word timings
//     allows no better. Under «Bekreft før deling» the first send of a
//     document waits for the reader's yes, as the assistant's does.
//   - the platform speech synthesiser, as before, when there is no voice key,
//     when the reader declines the cloud, or when they pick a system voice.
//
// It borrows rather than owns. The sentence being spoken is drawn with the
// SEARCH hit overlay — one highlight mechanism for the page, so the two can
// never fight over it — and the sentence offsets come from the page texts search
// and the AI panel already cache. That is why the caller hands in `setSearchHits`
// and `pageTextsRef` instead of this hook keeping either.
//
// Two invariants to keep whatever else changes here: a reading session is
// identified by the object in `readSessionRef`, and every callback — an
// utterance's `onend`, an audio element's `ended`, a fetched chunk landing —
// re-checks that it is still the current one before speaking on (a stopped
// session must not resurrect itself); and speech must never outlive the tab it
// started in, which is what the `active` teardown and the unmount stop are for.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { FileError, PageRect } from '../../../shared/types'
import { bridge } from '../bridge'
import { errorText, getLanguage, t } from '../i18n'
import { buildPageTexts, resolveMatchRects } from '../search'
import type { PageText } from '../search'
import type { RowLayout } from '../rotation'
import { isSharedWith, markSharedWith } from '../ai-sharing'
import { GEMINI_READING_VOICES, GEMINI_TTS_MODEL } from '../../../shared/ai-voices'
import { buildSentences, chunkSentences, sentenceAt } from '../../../shared/speech-text'
import type { SpeechChunk, SpokenSentence } from '../../../shared/speech-text'
// Type-only, so no runtime cycle back into the component. Importing the alias
// rather than restating `'a' | 'b'` keeps the two from drifting apart.
import type { PaneId } from '../components/PdfViewer'

interface ReadAloudDeps {
  pdf: PDFDocumentProxy | null
  /** The document's path — what «Bekreft før deling» remembers a send by */
  docPath: string
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

/** A voice value naming a provider voice rather than a system voiceURI */
const CLOUD_PREFIX = 'gemini:'
const isCloudVoice = (v: string): boolean => v.startsWith(CLOUD_PREFIX)

interface ReadAloud {
  readAloud: 'closed' | 'playing' | 'paused'
  readRate: number
  setReadRate: React.Dispatch<React.SetStateAction<number>>
  readVoice: string
  setReadVoice: React.Dispatch<React.SetStateAction<string>>
  voices: SpeechSynthesisVoice[]
  /** The provider voices on offer (values carry CLOUD_PREFIX); empty without a key */
  cloudVoices: string[]
  /** Set while the first send of this document waits for the reader's yes */
  consent: { model: string } | null
  approveCloud: () => void
  declineCloud: () => void
  /** Waiting for a chunk's audio */
  readLoading: boolean
  /** Why the voice stopped; play retries */
  readError: string | null
  /** Set by the voice picker so per-document auto-selection stops overriding it */
  voiceManualRef: React.RefObject<boolean>
  startReadAloud: () => Promise<void>
  stopReadAloud: () => void
  toggleReadPause: () => void
}

interface ReadSession {
  sentences: SpokenSentence[]
  index: number
  stopped: boolean
  engine: 'cloud' | 'system'
  /** cloud only */
  chunks: SpeechChunk[]
  chunkIndex: number
  audio: Map<number, Promise<string | FileError>>
  urls: string[]
  paused: boolean
  failed: boolean
}

export function useReadAloud({
  pdf,
  docPath,
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
  const [cloudVoices, setCloudVoices] = useState<string[]>([])
  const [consent, setConsent] = useState<{ model: string } | null>(null)
  const [readLoading, setReadLoading] = useState(false)
  const [readError, setReadError] = useState<string | null>(null)
  const readSessionRef = useRef<ReadSession | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
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

  /** Is a provider voice usable right now? Asked again at every start, since
   *  the key or KI-tilgang may have changed in the settings meanwhile. */
  const cloudAvailable = useCallback(async (): Promise<{ ok: boolean; confirm: boolean }> => {
    const config = await bridge.aiGetConfig().catch(() => null)
    const ok = !!config && config.access !== 'off' && config.hasKey.gemini === true
    setCloudVoices(ok ? GEMINI_READING_VOICES.map((v) => CLOUD_PREFIX + v) : [])
    return { ok, confirm: config?.access === 'confirm' }
  }, [])

  useEffect(() => {
    void cloudAvailable()
  }, [cloudAvailable])

  // Default voice: a provider voice when there is one, else match the app
  // language when such a system voice exists
  useEffect(() => {
    if (readVoice) return
    if (cloudVoices.length > 0) {
      setReadVoice(cloudVoices[0])
      return
    }
    if (voices.length === 0) return
    const wanted = getLanguage() === 'nb' ? ['nb', 'no'] : ['en']
    const match = voices.find((v) => wanted.some((p) => v.lang.toLowerCase().startsWith(p)))
    setReadVoice((match ?? voices.find((v) => v.default) ?? voices[0]).voiceURI)
  }, [voices, cloudVoices, readVoice])

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
    async (s: SpokenSentence) => {
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
        { start: s.start, end: s.end },
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

  const finish = useCallback((session: ReadSession) => {
    session.stopped = true
    for (const url of session.urls) URL.revokeObjectURL(url)
    session.urls = []
    if (readSessionRef.current === session) readSessionRef.current = null
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    setReadAloud('closed')
    setReadLoading(false)
    setSearchHits(null)
  }, [])

  // ---------- The system synthesiser ----------

  const speakFrom = useCallback(
    (index: number) => {
      const session = readSessionRef.current
      const synth = window.speechSynthesis
      if (!session || session.stopped || !synth) return
      if (index >= session.sentences.length) {
        finish(session)
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
    [highlightSentence, finish]
  )

  // ---------- The provider voice ----------

  /** A chunk's audio as a blob URL ('' for a chunk with nothing to say), fetched
   *  once per session. Recording the send here is what keeps «Bekreft før
   *  deling» honest: it marks the moment text actually leaves. */
  const fetchChunk = useCallback(
    (session: ReadSession, i: number): Promise<string | FileError> => {
      const cached = session.audio.get(i)
      if (cached) return cached
      const chunk = session.chunks[i]
      const voice = readPrefsRef.current.voiceURI.slice(CLOUD_PREFIX.length)
      const pending: Promise<string | FileError> = !chunk.text
        ? Promise.resolve('')
        : (markSharedWith(docPath, 'gemini'),
          bridge.aiSpeak({ provider: 'gemini', text: chunk.text, voice }).then((r) => {
            if (!('ok' in r)) return r
            const url = URL.createObjectURL(new Blob([r.audio as BlobPart], { type: r.mime }))
            // A session stopped while this was on its way never plays it
            if (session.stopped) URL.revokeObjectURL(url)
            else session.urls.push(url)
            return url
          }))
      session.audio.set(i, pending)
      return pending
    },
    [docPath]
  )

  const playChunk = useCallback(
    async (session: ReadSession, i: number): Promise<void> => {
      if (session.stopped || readSessionRef.current !== session) return
      if (i >= session.chunks.length) {
        finish(session)
        return
      }
      session.chunkIndex = i
      session.failed = false
      setReadError(null)
      for (let k = i; k < Math.min(i + 3, session.chunks.length); k++) void fetchChunk(session, k)
      setReadLoading(true)
      const url = await fetchChunk(session, i)
      if (session.stopped || readSessionRef.current !== session) return
      setReadLoading(false)
      if (typeof url !== 'string') {
        // Kept open and paused: the bar says why, and play asks again
        session.audio.delete(i)
        session.failed = true
        session.paused = true
        // The assistant's rate-limit advice is about questions; this one waits
        setReadError(url.code === 'ai-rate-limited' ? t('ra.rateLimited') : errorText(url))
        setReadAloud('paused')
        return
      }
      if (url === '') {
        void playChunk(session, i + 1)
        return
      }
      const chunk = session.chunks[i]
      const audio = (audioRef.current ??= new Audio())
      audio.src = url
      audio.playbackRate = readPrefsRef.current.rate
      audio.preservesPitch = true
      const sentenceNow = (): void => {
        if (readSessionRef.current !== session || session.stopped) return
        const fraction = audio.duration > 0 ? audio.currentTime / audio.duration : 0
        const index = chunk.first + sentenceAt(chunk.weights, fraction)
        if (index === session.index) return
        session.index = index
        void highlightSentence(session.sentences[index])
      }
      session.index = -1
      audio.ontimeupdate = sentenceNow
      audio.onplaying = sentenceNow
      audio.onended = () => {
        if (readSessionRef.current === session && !session.stopped) void playChunk(session, i + 1)
      }
      if (session.paused) return
      try {
        await audio.play()
      } catch {
        // A pause or a stop in between interrupts play(); anything else is
        // audio the element cannot decode — skip it rather than stall
        if (!session.paused && !session.stopped && readSessionRef.current === session)
          void playChunk(session, i + 1)
      }
    },
    [fetchChunk, highlightSentence, finish]
  )

  // ---------- Start, pause, stop ----------

  const startSystem = useCallback(
    (session: ReadSession, texts: PageText[]) => {
      session.engine = 'system'
      // Read English papers with an English voice even when the UI is
      // Norwegian (and vice versa) — unless the user picked a voice themselves
      if (!voiceManualRef.current || isCloudVoice(readPrefsRef.current.voiceURI)) {
        const voice = pickVoiceFor(detectDocLanguage(texts))
        if (voice) {
          setReadVoice(voice.voiceURI)
          readPrefsRef.current.voiceURI = voice.voiceURI
        }
      }
      if (!window.speechSynthesis) {
        finish(session)
        return
      }
      setReadAloud('playing')
      speakFrom(0)
    },
    [pickVoiceFor, detectDocLanguage, speakFrom, finish]
  )

  const stopReadAloud = useCallback(() => {
    const session = readSessionRef.current
    window.speechSynthesis?.cancel()
    setConsent(null)
    setReadError(null)
    if (session) finish(session)
    else {
      setReadAloud('closed')
      setSearchHits(null)
    }
  }, [finish])

  const startReadAloud = useCallback(async () => {
    if (!pdf) return
    stopReadAloud()
    const texts = (pageTextsRef.current ??= await buildPageTexts(pdf))
    const sentences = buildSentences(texts, currentPage)
    if (sentences.length === 0) return
    const session: ReadSession = {
      sentences,
      index: 0,
      stopped: false,
      engine: 'cloud',
      chunks: [],
      chunkIndex: 0,
      audio: new Map(),
      urls: [],
      paused: false,
      failed: false
    }
    readSessionRef.current = session
    const cloud = await cloudAvailable()
    if (readSessionRef.current !== session) return
    let voice = readPrefsRef.current.voiceURI
    if (cloud.ok && (!voiceManualRef.current || !voice)) voice = CLOUD_PREFIX + GEMINI_READING_VOICES[0]
    if (!cloud.ok || !isCloudVoice(voice)) {
      startSystem(session, texts)
      return
    }
    setReadVoice(voice)
    readPrefsRef.current.voiceURI = voice
    session.chunks = chunkSentences(sentences)
    if (cloud.confirm && !isSharedWith(docPath, 'gemini')) {
      // Nothing leaves before the reader says yes
      session.paused = true
      setConsent({ model: GEMINI_TTS_MODEL })
      setReadAloud('paused')
      return
    }
    setReadAloud('playing')
    void playChunk(session, 0)
  }, [pdf, docPath, currentPage, stopReadAloud, cloudAvailable, startSystem, playChunk])

  const approveCloud = useCallback(() => {
    const session = readSessionRef.current
    setConsent(null)
    if (!session || session.stopped) return
    session.paused = false
    setReadAloud('playing')
    void playChunk(session, session.chunkIndex)
  }, [playChunk])

  const declineCloud = useCallback(() => {
    const session = readSessionRef.current
    setConsent(null)
    if (!session || session.stopped) return
    const texts = pageTextsRef.current
    if (!texts) return
    voiceManualRef.current = false
    startSystem(session, texts)
  }, [startSystem])

  const toggleReadPause = useCallback(() => {
    const session = readSessionRef.current
    if (session?.engine === 'cloud') {
      if (consent) return
      const audio = audioRef.current
      if (!session.paused) {
        session.paused = true
        audio?.pause()
        setReadAloud('paused')
        return
      }
      session.paused = false
      setReadAloud('playing')
      // A failed chunk is asked for again; a paused one plays on from where it
      // was; one paused while still loading starts when it lands
      if (session.failed || !audio?.src) void playChunk(session, session.chunkIndex)
      else void audio.play().catch(() => undefined)
      return
    }
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
  }, [consent, playChunk])

  // A speed change takes effect on the sentence being spoken
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = readRate
  }, [readRate])

  // Never keep speaking from a background tab / after close
  useEffect(() => {
    if (!active && readSessionRef.current) stopReadAloud()
  }, [active, stopReadAloud])
  useEffect(
    () => () => {
      window.speechSynthesis?.cancel()
      const session = readSessionRef.current
      if (session) {
        session.stopped = true
        for (const url of session.urls) URL.revokeObjectURL(url)
      }
      audioRef.current?.pause()
    },
    []
  )

  return {
    readAloud,
    readRate,
    setReadRate,
    readVoice,
    setReadVoice,
    voices,
    cloudVoices,
    consent,
    approveCloud,
    declineCloud,
    readLoading,
    readError,
    voiceManualRef,
    startReadAloud,
    stopReadAloud,
    toggleReadPause
  }
}
