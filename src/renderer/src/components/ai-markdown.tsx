// Assistant-answer rendering: the markdown/LaTeX subset that turns model output
// into React nodes. Hook-free and headless — every function here is a pure
// string -> ReactNode transform that knows nothing about conversations,
// providers or requests. That is why it is not part of AiPanel.tsx: both the
// chat panel and the explain-selection popover render through it, and it is the
// one piece of the AI surface that can be reasoned about (and broken) on its
// own.
//
// Keep it a subset. It covers what the models actually emit; every feature
// added here is one more way a real answer can render wrong.
import katex from 'katex'
import 'katex/dist/katex.min.css'
import type { AiCitation, AiContentPart } from '../../../shared/types'
import { citationPage } from '../ai'
import type { AiDocument } from '../ai'
import { t } from '../i18n'

// ---------- Markdown rendering (Claude/ChatGPT-style subset) ----------
// Headings, paragraphs, nested bullet/numbered lists, fenced + inline code,
// bold/italic, blockquotes, tables and horizontal rules. Citation chips
// travel through the text as private-use sentinels (\uE000<index>\uE001)
// glued to the sentence they support, so they render inline — never on a
// line of their own.

interface ChipContext {
  chips: AiCitation[]
  doc: AiDocument | null
  onCitation(citation: AiCitation): void
}

const chipToken = (index: number): string => `\uE000${index}\uE001`

/** KaTeX render of a TeX snippet; throwOnError:false degrades bad TeX to
 *  red-tinted source instead of breaking the message. */
function mathNode(tex: string, display: boolean, key: string): React.ReactNode {
  return (
    <span
      key={key}
      className={display ? 'ai-math-block' : 'ai-math'}
      dangerouslySetInnerHTML={{
        __html: katex.renderToString(tex, { throwOnError: false, displayMode: display })
      }}
    />
  )
}

function renderInline(text: string, keyBase: string, ctx?: ChipContext): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const regex =
    /(\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`|\uE000\d+\uE001|\\\(.+?\\\)|\$\$[^$\n]+\$\$)/g
  let last = 0
  let match: RegExpExecArray | null
  let i = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('\\(')) {
      out.push(mathNode(token.slice(2, -2), false, `${keyBase}-${i++}`))
      last = regex.lastIndex
      continue
    }
    if (token.startsWith('$$')) {
      out.push(mathNode(token.slice(2, -2), false, `${keyBase}-${i++}`))
      last = regex.lastIndex
      continue
    }
    if (token.startsWith('\uE000')) {
      const chip = ctx?.chips[Number(token.slice(1, -1))]
      if (chip && ctx && chip.kind === 'web') {
        // Web-search source: labelled by domain, opens in the browser
        let host = ''
        try {
          host = new URL(chip.url).hostname.replace(/^www\./, '')
        } catch {
          /* malformed URL - fall back to the generic label */
        }
        out.push(
          <button
            key={`${keyBase}-${i++}`}
            className="ai-chip ai-chip-web"
            title={`${chip.title}\n${chip.url}`}
            onClick={() => ctx.onCitation(chip)}
          >
            {host || t('ai.sourceChip')}
          </button>
        )
      } else if (chip && ctx) {
        const page = citationPage(chip, ctx.doc)
        // Hover shows the cited excerpt so two same-page chips ("p. 6", "p. 6")
        // are tellable apart; fall back to the generic hint when there is none.
        const raw =
          (chip.kind === 'char' ? chip.citedText : chip.kind === 'quote' ? chip.quote : '')?.trim() ?? ''
        const excerpt = raw.length > 180 ? `${raw.slice(0, 179)}…` : raw
        out.push(
          <button
            key={`${keyBase}-${i++}`}
            className="ai-chip"
            title={excerpt ? `“${excerpt}”\n${t('ai.chipTip')}` : t('ai.chipTip')}
            onClick={() => ctx.onCitation(chip)}
          >
            {page !== null ? `${t('app.pageAbbrev')} ${page}` : t('ai.sourceChip')}
          </button>
        )
      }
    } else if (token.startsWith('***')) {
      out.push(
        <strong key={`${keyBase}-${i++}`}>
          <em>{token.slice(3, -3)}</em>
        </strong>
      )
    } else if (token.startsWith('**')) {
      out.push(<strong key={`${keyBase}-${i++}`}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`')) {
      out.push(<code key={`${keyBase}-${i++}`}>{token.slice(1, -1)}</code>)
    } else {
      out.push(<em key={`${keyBase}-${i++}`}>{token.slice(1, -1)}</em>)
    }
    last = regex.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

const LIST_ITEM_RE = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/
const TABLE_DIVIDER_RE = /^\|?[\s:|-]+\|?$/

const splitTableRow = (line: string): string[] =>
  line
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())

/** Parse a run of list lines starting at `start`; supports one nesting level
 *  per recursion via indentation. Returns the list node and the next index. */
function parseList(
  lines: string[],
  start: number,
  keyBase: string,
  ctx?: ChipContext
): [React.ReactNode, number] {
  const first = LIST_ITEM_RE.exec(lines[start])!
  const baseIndent = first[1].length
  const ordered = /\d/.test(first[2][0])
  const items: { text: string; subLines: string[] }[] = []
  let i = start
  while (i < lines.length) {
    const m = LIST_ITEM_RE.exec(lines[i])
    if (!m) {
      // An indented non-list line continues the previous item
      if (items.length > 0 && lines[i].trim() !== '' && /^\s{2,}/.test(lines[i])) {
        items[items.length - 1].text += ' ' + lines[i].trim()
        i++
        continue
      }
      break
    }
    if (m[1].length > baseIndent && items.length > 0) {
      items[items.length - 1].subLines.push(lines[i])
      i++
      continue
    }
    if (m[1].length < baseIndent) break
    items.push({ text: m[3], subLines: [] })
    i++
  }
  const children = items.map((item, j) => (
    <li key={j}>
      {renderInline(item.text, `${keyBase}-${j}`, ctx)}
      {item.subLines.length > 0 && parseList(item.subLines, 0, `${keyBase}-${j}s`, ctx)[0]}
    </li>
  ))
  return [ordered ? <ol key={keyBase}>{children}</ol> : <ul key={keyBase}>{children}</ul>, i]
}

export function renderMarkdown(text: string, ctx?: ChipContext): React.ReactNode {
  const out: React.ReactNode[] = []
  const lines = text.split('\n')
  const para: string[] = []
  let key = 0
  const flushPara = (): void => {
    if (para.length === 0) return
    out.push(<p key={key++}>{renderInline(para.join(' '), `p${key}`, ctx)}</p>)
    para.length = 0
  }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '') {
      flushPara()
      i++
      continue
    }
    if (trimmed.startsWith('```')) {
      flushPara()
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i])
        i++
      }
      i++ // closing fence
      out.push(
        <pre key={key++}>
          <code>{buf.join('\n')}</code>
        </pre>
      )
      continue
    }
    // Display math: \[ … \] or $$ … $$, single- or multi-line
    if (trimmed.startsWith('\\[') || trimmed.startsWith('$$')) {
      flushPara()
      const close = trimmed.startsWith('\\[') ? '\\]' : '$$'
      const buf: string[] = []
      let content = trimmed.slice(2)
      for (;;) {
        const at = content.indexOf(close)
        if (at !== -1) {
          buf.push(content.slice(0, at))
          break
        }
        buf.push(content)
        i++
        if (i >= lines.length) break
        content = lines[i]
      }
      i++ // past the closing line
      out.push(mathNode(buf.join('\n').trim(), true, `m${key++}`))
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      flushPara()
      const content = renderInline(heading[2], `h${key}`, ctx)
      const level = heading[1].length
      out.push(
        level <= 2 ? (
          <h3 key={key++}>{content}</h3>
        ) : level === 3 ? (
          <h4 key={key++}>{content}</h4>
        ) : (
          <h5 key={key++}>{content}</h5>
        )
      )
      i++
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara()
      out.push(<hr key={key++} />)
      i++
      continue
    }
    if (/^>\s?/.test(trimmed)) {
      flushPara()
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      out.push(<blockquote key={key++}>{renderMarkdown(buf.join('\n'), ctx)}</blockquote>)
      continue
    }
    if (
      trimmed.startsWith('|') &&
      i + 1 < lines.length &&
      lines[i + 1].includes('-') &&
      TABLE_DIVIDER_RE.test(lines[i + 1].trim())
    ) {
      flushPara()
      const header = splitTableRow(trimmed)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[i].trim()))
        i++
      }
      out.push(
        <div className="ai-table-wrap" key={key++}>
          <table>
            <thead>
              <tr>
                {header.map((cell, c) => (
                  <th key={c}>{renderInline(cell, `t${key}h${c}`, ctx)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{renderInline(cell, `t${key}r${r}c${c}`, ctx)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }
    if (LIST_ITEM_RE.test(line)) {
      flushPara()
      const [node, next] = parseList(lines, i, `l${key++}`, ctx)
      out.push(node)
      i = next
      continue
    }
    para.push(trimmed)
    i++
  }
  flushPara()
  return out
}

// ---------- Message rendering ----------

interface AssistantBodyProps {
  parts: AiContentPart[]
  doc: AiDocument | null
  onCitation(citation: AiCitation): void
}

export function AssistantBody({ parts, doc, onCitation }: AssistantBodyProps): React.JSX.Element {
  // Merge all parts into one markdown document so citation boundaries never
  // split paragraphs; each part's chips are glued (as inline sentinels) to
  // the end of the sentence that carries them.
  const chips: AiCitation[] = []
  let md = ''
  for (const part of parts) {
    const trailing = /\s*$/.exec(part.text)?.[0] ?? ''
    md += trailing ? part.text.slice(0, part.text.length - trailing.length) : part.text
    for (const c of part.citations) {
      md += chipToken(chips.length)
      chips.push(c)
    }
    md += trailing
  }
  return <>{renderMarkdown(md, { chips, doc, onCitation })}</>
}
