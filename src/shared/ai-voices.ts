// The provider voices read-aloud offers. Apart from ai-speech.ts so the
// renderer can name them without bundling the provider core that module
// imports (ai-chat.ts and its SDKs live in main and the extension only).

export const GEMINI_TTS_MODEL = 'gemini-3.8-flash-tts'

/** The prebuilt voices offered for reading — the ones Google describes as even,
 *  clear or informative; the excitable and breathy ones are not for a paper.
 *  The first is the default. */
export const GEMINI_READING_VOICES = [
  'Charon',
  'Kore',
  'Iapetus',
  'Erinome',
  'Schedar',
  'Sadaltager',
  'Rasalgethi',
  'Sulafat'
] as const
