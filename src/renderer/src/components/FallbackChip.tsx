import { t } from '../i18n'
import { prettyModelName } from './ai-models'

/**
 * «Besvart av …» on an answer the chosen model did not write: Anthropic's
 * server-side fallback retried a safety-classifier decline on another model
 * (ai-chat.ts, AiChatResult.fallbackModel). Without it the model menu's choice
 * would silently not hold. One component so the chat panel and the selection
 * bubble say it the same way.
 */
export function FallbackChip({ model, className }: { model: string; className?: string }) {
  const name = prettyModelName('anthropic', model)
  return (
    <span
      className={className ? `ai-fallback-chip ${className}` : 'ai-fallback-chip'}
      title={t('ai.fallbackTip', { model: name })}
    >
      {t('ai.fallbackChip', { model: name })}
    </span>
  )
}
