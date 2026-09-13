// What the provider told us about the ACCOUNT's token ceiling, per model.
//
// The model's context window is a published number we keep curated
// (MODEL_CONTEXT_TOKENS in components/ai-models.ts). The account's per-minute
// token quota is not: it depends on the usage tier behind the key, it differs
// per model, and it is routinely an order of magnitude tighter than the window
// — a 900k-context model on a low tier refuses anything past 30k tokens. That
// mismatch is why a big document could fail with a rejection no amount of
// waiting would fix: the excerpt budget was measured against the wrong ceiling.
//
// So we listen. Every answer and every rejection carries the ceiling the
// provider published for it (AiChatResult.tokenLimit, read from its rate-limit
// headers in shared/ai-chat.ts); this remembers the last one per
// provider+model, and prepareDocumentForRequest budgets by whichever ceiling
// is tighter. Learning on SUCCESS is the point — a small question answers
// normally and teaches us the ceiling, so the first big one is cut to fit
// rather than failing and teaching us afterwards.
//
// Renderer-only and localStorage-backed, like the chat store: per machine, per
// browser profile, identical in Electron, the extension and dev:web. A stale
// or missing entry costs nothing — the budget falls back to the context
// window, which is what it always used to be.
import type { AiProviderId } from '../../shared/types'

const LS_KEY = 'pdfx-ai-token-limits'

/** Ceilings this absurd are a provider misreporting, not a quota — ignore
 *  rather than excerpt a document down to nothing over a typo upstream. */
const MIN_CREDIBLE_TOKENS = 1_000

type LimitStore = Record<string, number>

const keyOf = (provider: AiProviderId, model: string): string => `${provider}:${model.trim()}`

const readStore = (): LimitStore => {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Remember the ceiling a request just reported. No-ops on `undefined` (the
 *  provider said nothing) and on an unchanged value, so the everyday path
 *  never writes. */
export function rememberRequestTokenLimit(
  provider: AiProviderId,
  model: string,
  tokenLimit: number | undefined
): void {
  if (!tokenLimit || tokenLimit < MIN_CREDIBLE_TOKENS || !model.trim()) return
  const store = readStore()
  const key = keyOf(provider, model)
  if (store[key] === tokenLimit) return
  store[key] = tokenLimit
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store))
  } catch {
    /* private mode, or a full quota — the budget just falls back */
  }
}

/** The remembered per-request ceiling for this model, or undefined if the
 *  provider has never published one to us */
export function requestTokenLimit(provider: AiProviderId, model: string): number | undefined {
  const value = readStore()[keyOf(provider, model)]
  return typeof value === 'number' && value >= MIN_CREDIBLE_TOKENS ? value : undefined
}
