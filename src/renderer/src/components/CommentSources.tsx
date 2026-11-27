// The sources a COMMENT names, drawn as the assistant's own chips (issue #168).
//
// An answer kept as a comment carries its sources as plain text — «[s. 4]»
// after the sentence, the passage in a list under the answer
// (shared/answer-comment.ts) — because that is all a PDF comment can hold and
// all another reader will show. Here the same text is read back: each marker
// is a chip that goes to its page and flashes its passage, exactly as in the
// chat, and the list is folded away since the chips carry it.
//
// Who does the jumping is the viewer's business: it puts a handler in
// CommentSourceContext, and every surface that shows a comment under it —
// the margin cards, the Merknader tab, the hover card, the comment bubble —
// gets working chips with no prop passed down. With no handler the markers
// stay the text they are.
import { createContext, useContext, useMemo } from 'react'
import { commentSources } from '../../../shared/answer-comment'
import type { CommentSource, CommentSources } from '../../../shared/answer-comment'
import { t } from '../i18n'

/** `from` is the chip pressed: the viewer reads which column or bubble it
 *  sits in off it (the split view's other file has pages of its own) */
export type CommentSourceHandler = (source: { page: number; quote: string | null }, from: Element) => void

export const CommentSourceContext = createContext<CommentSourceHandler | null>(null)

/** The sources in a comment's text — null for the comments that name none,
 *  which is nearly all of them, and where there is nobody to follow one */
export function useCommentSources(text: string | undefined): CommentSources | null {
  const jump = useContext(CommentSourceContext)
  return useMemo(() => (jump && text ? commentSources(text) : null), [jump, text])
}

function SourceChip({ source }: { source: CommentSource }): React.JSX.Element {
  const jump = useContext(CommentSourceContext)
  const quote = source.quote ?? ''
  const excerpt = quote.length > 180 ? `${quote.slice(0, 179)}…` : quote
  return (
    <button
      type="button"
      className="ai-chip comment-source"
      // The chat chip's hover: the passage itself, so two «s. 4» can be told apart
      title={excerpt ? `“${excerpt}”\n${t('ai.chipTip')}` : t('ai.chipTip')}
      // A chip inside a bubble's drag handle or a card that selects on press
      // must not start either
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        // The card around it has a click of its own (the Merknader tab jumps
        // to the mark): the chip's is the only one meant
        e.stopPropagation()
        jump?.({ page: source.page, quote: source.quote }, e.currentTarget)
      }}
    >
      {t('app.pageAbbrev')} {source.page}
    </button>
  )
}

/** The comment as it reads, each marker a chip where it stood */
export function CommentBody({ parsed }: { parsed: CommentSources }): React.JSX.Element {
  const out: React.ReactNode[] = []
  let at = 0
  parsed.sources.forEach((source, i) => {
    if (source.start > at) out.push(parsed.body.slice(at, source.start))
    out.push(<SourceChip key={i} source={source} />)
    at = source.end
  })
  if (at < parsed.body.length) out.push(parsed.body.slice(at))
  return <>{out}</>
}

/** The chips alone, in the text's order — beside a field that is being
 *  typed in, where the markers themselves must stay text */
export function CommentSourceRow({ parsed }: { parsed: CommentSources }): React.JSX.Element {
  return (
    <div className="comment-source-row">
      {parsed.sources.map((source, i) => (
        <SourceChip key={i} source={source} />
      ))}
    </div>
  )
}
