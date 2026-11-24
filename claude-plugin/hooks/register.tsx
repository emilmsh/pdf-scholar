// PDF Scholar's plugin for Claude Code: under an answer that cites passages,
// one button per citation that shows the passage in PDF Scholar.
//
// PDF Scholar's MCP server (docs/MCP.md, «Reading together») gives Claude a
// `show_passage` tool; every call is answered with the reference's number,
// «[3] Found word for word on page 7 …», and Claude writes that number beside
// the claim it backs. Without this plugin the number is all there is in the
// chat: the reader finds card 3 in PDF Scholar's list themselves. With it,
// the «[3]» in the answer gets a button under the answer that brings the
// passage up — the link between a sentence and its source stays in the window
// the discussion is in, and can be pressed again whenever (Emil, 2026-11-24:
// with a list in one window and prose in the other, nothing says which claim
// belongs to which passage).
//
// Why under the ANSWER and not under the tool call: once a turn ends, the
// transcript folds its tool calls into one line above the answer («Used
// pdf-scholar 7 times»), and anything drawn on a call's row is gone with the
// row. An answer's text stays, and its «[n]» say which references it uses.
//
// What it keeps: per session, the references PDF Scholar numbered — the
// document's path, the page and the quoted words, exactly what the model
// already sent. Nothing is read from PDF Scholar and nothing leaves; a press
// calls the same tool on the same server, which is the same session there,
// so the passage keeps its number and no second card is made.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Reference } from '../types'

/** PDF Scholar's tool, whatever the server is called in this setup (the app
 *  writes `pdf-scholar`; one set up by hand may carry another name) */
const SHOW = /^mcp__(.*pdf[-_]scholar.*)__show_passage$/i

/** The number the server opens every answer with */
const NUMBER = /^\[(\d{1,6})\]/

/** «[3]» in an answer — not «[3, 5]» or «[17–19]», which are a paper's own
 *  citations quoted along, never ours */
const CITED = /\[(\d{1,6})\]/g

// Change the tag when a reference's fields change: it declines what an
// earlier version stored, which outlives a reload
const references = atom({ plugin: 'pdf-scholar', key: 'references' } as const, [], {
  shape: 'references-1',
})

/** The most kept: a session that cites more than this has long since
 *  scrolled its first answers away */
const KEEP = 500

type Caller = {
  mcp: {
    call: (
      server: string,
      tool: string,
      args?: Record<string, unknown>,
    ) => Promise<{ content: unknown[]; isError: boolean }>
  }
  ui: { toast: (text: string) => unknown }
}

/** The reference a finished `show_passage` call made, or undefined: the tool
 *  was another, it was refused, or PDF Scholar gave it no number */
function referenceOf(
  tool: string,
  input: Record<string, unknown>,
  text: string | undefined,
): Reference | undefined {
  const server = SHOW.exec(tool)?.[1]
  const n = Number(NUMBER.exec(text ?? '')?.[1])

  if (server === undefined || !Number.isInteger(n) || n < 1) {
    return undefined
  }

  const { path, page, quote } = input

  if (typeof path !== 'string' || typeof quote !== 'string' || typeof page !== 'number') {
    return undefined
  }

  return {
    n,
    server,
    path,
    page,
    quote,
    isFound: !/NOT FOUND|could not be checked/.test(text ?? ''),
  }
}

/** The numbers an answer cites, each once, in the order they first appear */
function citedIn(text: string): number[] {
  const seen: number[] = []

  for (const match of text.matchAll(CITED)) {
    const n = Number(match[1])

    if (!seen.includes(n)) {
      seen.push(n)
    }
  }

  return seen
}

/** Show the passage in PDF Scholar again; a refusal is said, not swallowed
 *  (the switch was turned off, the document is kept out, the app is closed) */
async function show($: Caller, reference: Reference): Promise<void> {
  const result = await $.mcp.call(reference.server, 'show_passage', {
    path: reference.path,
    page: reference.page,
    quote: reference.quote,
    show: true,
  })

  if (!result.isError) {
    return
  }

  const first = result.content[0] as { text?: unknown } | undefined

  $.ui.toast(typeof first?.text === 'string' ? first.text : 'PDF Scholar did not answer.')
}

export const register: Register = on => {
  // Every tool call passes here; only PDF Scholar's own is looked at, and the
  // call's answer is handed on untouched whatever happens while noting it
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    try {
      const made =
        ran.deny === undefined
          ? referenceOf(e.tool, e as unknown as Record<string, unknown>, ran.text)
          : undefined

      if (made !== undefined) {
        await update($, references, list =>
          [...list.filter(one => one.n !== made.n || one.server !== made.server), made].slice(
            -KEEP,
          ),
        )
      }
    } catch {
      // A reference not noted costs a button, never the tool's answer
    }

    return ran
    // Whatever goes wrong here, the call goes on as if the plugin were not there
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const cited = citedIn(e.props.text)

    if (cited.length === 0) {
      return next(e)
    }

    const known = await read($, references)
    const mine = cited
      .map(n => known.findLast(one => one.n === n))
      .filter((one): one is Reference => one !== undefined)

    if (mine.length === 0) {
      return next(e)
    }

    const { Box, Button } = $.ui.resolve(e)
    const answer = await next(e)

    return (
      <Box flexDirection="column">
        {answer}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {mine.map(reference => (
            <Button
              key={`reference-${reference.n}`}
              dimColor={!reference.isFound}
              onPress={() => show($, reference)}
            >
              [{reference.n}] {reference.isFound ? '' : '✗ '}p. {reference.page}
            </Button>
          ))}
        </Box>
      </Box>
    )
  })
}
