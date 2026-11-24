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
// Where a reference comes from — two ways, since the first one failed in the
// first real session and nothing in the session said why (2026-11-24: the
// plugin, then named like the server, drew no button against the real tool
// while it drew them against a stand-in):
// - as the call is made: a `tool.call` hook notes the reference PDF Scholar
//   numbered, in the session's state;
// - from the transcript itself, when an answer cites a number that was never
//   noted: the session's own record of the call and its answer. This one
//   needs no hook to have run, and holds for a session resumed later.
// Either way it is what the model already sent — the document's path, the
// page and the quoted words. Nothing is read from PDF Scholar and nothing
// leaves; a press calls the same tool on the same server, which is the same
// session there, so the passage keeps its number and no second card is made.
//
// The plugin is NOT named like the server (`pdf-scholar`): a plugin's own
// tools live under `mcp__<plugin>__…`, the very names the server's tools
// have, and the first release under the shared name is the one that drew
// nothing.
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
const references = atom({ plugin: 'pdf-scholar-buttons', key: 'references' } as const, [], {
  shape: 'references-1',
})

/** The most kept: a session that cites more than this has long since
 *  scrolled its first answers away */
const KEEP = 500

/** How far back the transcript is read for a number that was never noted */
const LOOK_BACK = 400

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

type Transcript = {
  session: {
    messages: (range: { last: number }) => Promise<
      | { deny: string }
      | readonly {
          toolUses?: readonly { tool: string; input: Record<string, unknown>; text?: string }[]
        }[]
    >
  }
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

/** The references the session's own record holds: every answered
 *  `show_passage` call in its last messages, the newest of a number last */
async function referencesIn($: Transcript): Promise<Reference[]> {
  const messages = await $.session.messages({ last: LOOK_BACK })

  if ('deny' in messages) {
    return []
  }

  const found: Reference[] = []

  for (const message of messages) {
    for (const use of message.toolUses ?? []) {
      const made = referenceOf(use.tool, use.input, use.text)

      if (made !== undefined) {
        found.push(made)
      }
    }
  }

  return found
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

/** «s. 6», as PDF Scholar's own source chips read — in the language the
 *  machine is set to, which is as close as a plugin gets to the reader's.
 *  English where the language has no entry here, or cannot be asked. */
function pageLabel(page: number): string {
  let language = 'en'

  try {
    language = new Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().split('-')[0] ?? 'en'
  } catch {
    // No Intl here: English
  }

  if (language === 'zh') {
    return `第 ${page} 页`
  }

  const word: Record<string, string> = {
    nb: 's.',
    nn: 's.',
    no: 's.',
    da: 's.',
    sv: 's.',
    fi: 's.',
    de: 'S.',
    nl: 'p.',
    fr: 'p.',
    es: 'p.',
    it: 'p.',
    pt: 'p.',
    pl: 's.',
  }

  return `${word[language] ?? 'p.'} ${page}`
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
      // A reference not noted costs nothing: the transcript still has it
    }

    return ran
    // Whatever goes wrong here, the call goes on as if the plugin were not there
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const cited = citedIn(e.props.text)

    if (cited.length === 0) {
      return next(e)
    }

    let known: readonly Reference[] = await read($, references)

    // A number nobody noted: the session's own record of the calls
    if (cited.some(n => !known.some(one => one.n === n))) {
      try {
        known = [...(await referencesIn($)), ...known]
      } catch {
        // Then only what was noted
      }
    }

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
            // The text as ONE label, never as children: a Button with several
            // children takes a press only where it lands on their glyphs, and
            // the padding around «[3] s. 7» — most of so small a button — was
            // dead (Emil, 2026-11-24: «finicky to hit»)
            <Button
              key={`reference-${reference.n}`}
              label={`[${reference.n}] ${reference.isFound ? '' : '✗ '}${pageLabel(reference.page)}`}
              dimColor={!reference.isFound}
              onPress={() => show($, reference)}
            />
          ))}
        </Box>
      </Box>
    )
  })
}
