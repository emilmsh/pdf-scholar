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
  emptyStroke: { code: 'annot-empty-stroke', error: 'Streken er tom' },
  /** A pressure stroke's varying width could not be baked into the file's
   *  appearance stream. The annotation is not kept: a uniform stroke standing
   *  in for the calligraphy the user drew would be silent data loss. */
  pressureBakeFailed: {
    code: 'annot-pressure-bake',
    error: 'Fikk ikke lagret strekens trykkvariasjon i filen — streken ble ikke lagt til'
  },
  lineNoEndpoints: { code: 'annot-line-endpoints', error: 'Linjen mangler endepunkter' },
  /** The type name is the diagnostic and cannot be reconstructed from a code,
   *  so it rides along in `error` the way the asymmetric counts do. */
  unknownType: (type: string): FileError => ({
    code: 'annot-unknown-type',
    error: `Ukjent annotasjonstype: ${type}`
  }),
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
  compatUnconfigured: {
    code: 'ai-compat-unconfigured',
    error: 'Base-URL og modell-id for det OpenAI-kompatible endepunktet må fylles ut i KI-innstillingene.'
  },
  /** A first-class service has its key but no model picked yet — the model
   *  list is live-fetched, so the fix is one click away in the model menu. */
  modelUnchosen: {
    code: 'ai-model-unchosen',
    error: 'Ingen modell er valgt for denne leverandøren ennå. Velg modell i modellmenyen.'
  },
  /** The fetch itself failed — nothing is listening, DNS failed, or (in the
   *  extension) the browser blocked the cross-origin call. The host and the
   *  runtime's own sentence ride in `error` for the log; the renderer shows
   *  its translation of the code. */
  endpointUnreachable: (host: string, detail: string): FileError => ({
    code: 'ai-endpoint-unreachable',
    error: `Fikk ikke kontakt med ${host} (${detail})`
  }),
  /** The endpoint answered but never produced anything we recognise as a
   *  Chat Completions stream or response — probably not an OpenAI-compatible
   *  API root (wrong path, a web page, a bare Ollama root without /v1). */
  endpointIncompatible: {
    code: 'ai-endpoint-incompatible',
    error: 'Endepunktet svarte, men ikke som et OpenAI-kompatibelt API (sjekk at base-URL-en peker på API-roten, vanligvis …/v1).'
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
