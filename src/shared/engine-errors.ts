// Every failure we can NAME, in one place: annotation writes (ENGINE_ERRORS)
// and AI requests (AI_ERRORS).
//
// main and shared cannot reach the renderer's i18n, so a recognised failure
// travels as a `code` and the renderer translates it (`errorText` in
// src/renderer/src/i18n.ts); the Norwegian `error` string stays as the fallback
// and as the log line. See the EngineErrorCode doc comment in ./types.
//
// This module is dependency-free ON PURPOSE. Three write paths import it — the
// desktop PDFium engine, the browser PDFium engine, and the incremental
// appender (pure Node, no WASM, deliberately) — and the appender must not pull
// @embedpdf into its bundle. Keeping the literals here is also what stops the
// three from describing the same failure three different ways: the appender
// used to carry its own private copies of "annotation not found" and "password
// protected", which is how they drifted out of the translated set.
import type { FileError } from './types'

export const ENGINE_ERRORS = {
  notFound: { code: 'annot-not-found', error: 'Fant ikke annotasjonen i filen' },
  noPosition: { code: 'annot-no-position', error: 'Annotasjonen har ingen posisjon' },
  noObjectNumber: {
    code: 'annot-no-object-number',
    error: 'Fikk ikke objektnummer for annotasjonen'
  },
  updateRejected: { code: 'annot-update-rejected', error: 'Oppdateringen ble avvist av motoren' },
  passwordProtected: { code: 'pdf-password-protected', error: 'PDF-en er passordbeskyttet' },
  /** The appender met a PDF construct it will not rewrite. The `detail` argument
   *  at the throw site says which one; it is logged, never shown. */
  appendUnsupported: {
    code: 'append-unsupported',
    error:
      'Dokumentet har en PDF-struktur som ikke støttes for direkte annotering ennå — endringen ble ikke lagret.'
  },
  /** A foreign annotation compressed into an object stream, in a file too large
   *  for the WASM engine — so neither write path can edit it. */
  appendObjStmEdit: {
    code: 'append-objstm-edit',
    error: 'Annotasjonen kan ikke endres i så store dokumenter ennå'
  },
  asymmetric: (models: number, objNums: number): FileError => ({
    code: 'annot-list-asymmetric',
    // The counts stay in the message: they are the diagnostic, and no
    // translated sentence can carry them without the renderer knowing them.
    error: `Annotasjonslisten er usymmetrisk (${models} vs ${objNums}) — kan ikke identifisere trygt`
  })
} as const satisfies Record<string, FileError | ((...a: never[]) => FileError)>

/** The AI request path's named failures. Same contract, `aierr.*` keys.
 *
 *  Three callers share these: the desktop IPC handler (src/main/ai.ts), the
 *  extension's own implementation (src/renderer/src/extension-ai.ts) and the
 *  provider core both call (src/shared/ai-chat.ts) — which cannot import i18n
 *  because it runs in Electron main AND in the extension page. */
export const AI_ERRORS = {
  keyMissing: {
    code: 'ai-key-missing',
    error: 'Ingen API-nøkkel er lagret for valgt leverandør. Åpne KI-innstillingene.'
  },
  keyUndecryptable: {
    code: 'ai-key-undecryptable',
    error:
      'Den lagrede API-nøkkelen kunne ikke dekrypteres. Legg den inn på nytt i KI-innstillingene.'
  },
  keySessionOnly: {
    code: 'ai-key-session-only',
    error:
      'Nøkkelen lagres bare for denne økta på denne maskinen (ingen nøkkelring tilgjengelig). Legg den inn på nytt i KI-innstillingene.'
  },
  azureUnconfigured: {
    code: 'ai-azure-unconfigured',
    error: 'Azure-endepunkt og deployment må fylles ut i KI-innstillingene.'
  },
  /** The provider refused the request as too big for the model's context window.
   *  The provider's own wording is kept as `error` — it names the token counts,
   *  which is the only part worth reading in a log. */
  contextOverflow: (providerMessage: string): FileError => ({
    code: 'ai-context-overflow',
    error: providerMessage
  }),
  refusal: {
    code: 'ai-refusal',
    error: 'Modellen avslo å svare på denne forespørselen (sikkerhetsfilter hos leverandøren).'
  },
  streamAborted: { code: 'ai-stream-aborted', error: 'Strømmen ble avbrutt uten fullført svar.' },
  providerUnknown: { code: 'ai-provider-unknown', error: 'Ukjent feil fra leverandøren.' },
  aborted: { code: 'ai-aborted', error: 'Avbrutt' }
} as const satisfies Record<string, FileError | ((...a: never[]) => FileError)>
