// Read-aloud with a provider's voice, on the reader's own key — the neural
// voice the hidden read-aloud was waiting for (flags.ts), without shipping a
// model. Platform-neutral like ai-chat.ts: the Electron main process and the
// extension both call runProviderSpeech with the key they hold, so the request
// and its failures cannot drift between them.
//
// Gemini only, on purpose (2026-10-30). Its TTS models read Norwegian Bokmål
// and Nynorsk as well as English. OpenAI's /v1/audio/speech was the other
// candidate, but gpt-4o-mini-tts is deprecated and shuts down 2027-01-06 and
// its successor speaks only through the Realtime API — a WebSocket session,
// not a request per paragraph. Anthropic has no voice.
//
// The request is Gemini's Interactions API as documented at
// ai.google.dev/gemini-api/docs/speech-generation (read 2026-10-30): the audio
// comes back as base64 WAV (24 kHz mono 16-bit) in the model_output step.
import type { AiSpeechRequest, AiSpeechResult } from './types'
import { AI_ERRORS } from './engine-errors'
import { providerFailure } from './ai-chat'
import { GEMINI_READING_VOICES, GEMINI_TTS_MODEL } from './ai-voices'

const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions'

/** How the voice should read. It reads the text in the language it is in,
 *  so the style says nothing about language. */
const READING_STYLE =
  'Read this passage from an academic paper aloud like a calm, clear narrator reading to a colleague: ' +
  'an even pace, natural intonation, no dramatisation.'

export function geminiSpeechBody(text: string, voice: string): unknown {
  return {
    model: GEMINI_TTS_MODEL,
    input: [
      {
        type: 'user_input',
        content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: READING_STYLE }] }]
      }
    ],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice }] }
  }
}

interface InteractionStep {
  type?: string
  content?: { type?: string; data?: string; mime_type?: string }[]
}

/** The last audio part of the model's output, as the docs' own jq filter reads it. */
export function audioFromInteraction(body: unknown): { data: string; mime: string } | null {
  const steps = (body as { steps?: InteractionStep[] } | null)?.steps
  if (!Array.isArray(steps)) return null
  let found: { data: string; mime: string } | null = null
  for (const step of steps) {
    if (step?.type !== 'model_output' || !Array.isArray(step.content)) continue
    for (const part of step.content) {
      if (part?.type === 'audio' && typeof part.data === 'string' && part.data !== '') {
        found = { data: part.data, mime: part.mime_type || 'audio/wav' }
      }
    }
  }
  return found
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function runProviderSpeech(opts: {
  key: string
  req: AiSpeechRequest
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}): Promise<AiSpeechResult> {
  const { key, req, signal } = opts
  const doFetch = opts.fetchImpl ?? fetch
  if (req.provider !== 'gemini') return AI_ERRORS.providerUnknown
  const voice = (GEMINI_READING_VOICES as readonly string[]).includes(req.voice)
    ? req.voice
    : GEMINI_READING_VOICES[0]
  let response: Response
  try {
    response = await doFetch(GEMINI_INTERACTIONS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(geminiSpeechBody(req.text, voice)),
      signal: signal ?? null
    })
  } catch (err) {
    if (signal?.aborted) return AI_ERRORS.aborted
    return AI_ERRORS.endpointUnreachable(
      'generativelanguage.googleapis.com',
      err instanceof Error ? err.message : String(err)
    )
  }
  let body: unknown = null
  try {
    body = await response.json()
  } catch {
    if (signal?.aborted) return AI_ERRORS.aborted
  }
  if (!response.ok) {
    const message =
      (body as { error?: { message?: string } } | null)?.error?.message || `HTTP ${response.status}`
    const failure = providerFailure(message, { model: GEMINI_TTS_MODEL, headers: response.headers })
    // Gemini's native 429 («Resource has been exhausted (e.g. check quota)»)
    // matches none of the phrasings the chat core knows from the OpenAI-shaped
    // endpoint; the status says it plainly. A named failure (no credit) wins.
    if (!failure.code && response.status === 429) return AI_ERRORS.rateLimited(message)
    return failure
  }
  const audio = audioFromInteraction(body)
  if (!audio) return AI_ERRORS.providerUnknown
  return { ok: true, audio: base64ToBytes(audio.data), mime: audio.mime, model: GEMINI_TTS_MODEL }
}
