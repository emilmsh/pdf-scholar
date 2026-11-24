// Run: claude plugin test claude-plugin
import { expect, test } from 'claude-code/testing'

const ANSWER = {
  plugin: 'pdf-scholar',
  component: 'AssistantMessage',
} as const

const SURFACES = ['terminal', 'desktop'] as const

const TOOL = 'mcp__pdf-scholar__show_passage'
const PATH = 'C:/papers/attention.pdf'

type Shown = { server: string; tool: string; args: Record<string, unknown> }

/** A test's own `on`: its hooks stand for the engine beneath the plugin */
type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

/** PDF Scholar's side, as the engine would relay it: the n-th passage shown
 *  is answered «[n] …», a quote in `missing` as not found */
function scholar(on: On, missing: readonly string[] = []): Shown[] {
  const shown: Shown[] = []
  let count = 0

  on('tool.call', (_, e) => {
    const quote = String((e as unknown as { quote?: unknown }).quote)
    const text = missing.includes(quote)
      ? `[${++count}] NOT FOUND: these words are not in the document’s text.`
      : `[${++count}] Found word for word on page 6. PDF Scholar is showing it to the user.`

    return { result: text, text }
  })
  on('mcp.call', (_, e) => {
    shown.push(e)

    return { value: { content: [], isError: false } }
  })

  return shown
}

test('each [n] in an answer gets a button that shows its passage', async ($, on) => {
  const shown = scholar(on)

  await $.tool.call({ tool: TOOL, path: PATH, page: 6, quote: 'we use sine and cosine functions' })
  await $.tool.call({ tool: TOOL, path: PATH, page: 7, quote: 'self-attention layers are faster' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      ...ANSWER,
      surface,
      props: {
        text: 'Positions are encoded with sinusoids [1]. Self-attention is faster [2], as [1] hints.',
        isFirstOfReply: true,
      },
    })

    expect((await ui.find({ type: 'Button', key: 'reference-1' }))?.text).toBe('[1] p. 6')
    expect((await ui.find({ type: 'Button', key: 'reference-2' }))?.text).toBe('[2] p. 7')

    await ui.press({ key: 'reference-2' })
    await ui.unmount()
  }

  // The same tool on the same server, asked to SHOW: the same session there,
  // so the passage keeps its number
  expect(shown).toEqual(
    SURFACES.map(() => ({
      server: 'pdf-scholar',
      tool: 'show_passage',
      args: { path: PATH, page: 7, quote: 'self-attention layers are faster', show: true },
    })),
  )
})

test('an answer that cites nothing of ours is left alone', async ($, on) => {
  scholar(on)
  await $.tool.call({ tool: TOOL, path: PATH, page: 6, quote: 'we use sine and cosine functions' })

  for (const text of [
    'No citations here.',
    // A paper's own citations, quoted along: not our numbers
    'The authors build on [17, 18] and [9–11].',
    // A number PDF Scholar never gave
    'See [42].',
  ]) {
    const ui = await $.ui.mount({
      ...ANSWER,
      surface: 'desktop',
      props: { text, isFirstOfReply: true },
    })

    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  }
})

test('a quote PDF Scholar did not find is marked on its button', async ($, on) => {
  scholar(on, ['trained for six weeks on a laptop'])
  await $.tool.call({ tool: TOOL, path: PATH, page: 8, quote: 'trained for six weeks on a laptop' })

  const ui = await $.ui.mount({
    ...ANSWER,
    surface: 'desktop',
    props: { text: 'It was trained on a laptop [1].', isFirstOfReply: true },
  })

  expect((await ui.find({ type: 'Button', key: 'reference-1' }))?.text).toBe('[1] ✗ p. 8')
  await ui.unmount()
})

test('another tool, a refused call and an unnumbered answer make no button', async ($, on) => {
  let answer: { result: string; text: string } | { deny: string } = {
    result: 'ok',
    text: '[1] looks like ours but is not',
  }

  on('tool.call', () => answer)

  // Not PDF Scholar's tool
  await $.tool.call({ tool: 'mcp__notes__show_passage', path: PATH, page: 1, quote: 'q' })
  // Refused before it ran
  answer = { deny: 'PDF Scholar is not reading together with AI tools' }
  await $.tool.call({ tool: TOOL, path: PATH, page: 1, quote: 'q' })
  // An older PDF Scholar: no number in the answer
  answer = { result: 'Found word for word on page 1.', text: 'Found word for word on page 1.' }
  await $.tool.call({ tool: TOOL, path: PATH, page: 1, quote: 'q' })

  const ui = await $.ui.mount({
    ...ANSWER,
    surface: 'desktop',
    props: { text: 'A claim [1].', isFirstOfReply: true },
  })

  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()
})

test('a server set up under another name is called by that name', async ($, on) => {
  const shown = scholar(on)

  await $.tool.call({
    tool: 'mcp__pdf-scholar-dev__show_passage',
    path: PATH,
    page: 2,
    quote: 'the Transformer allows for more parallelization',
  })

  const ui = await $.ui.mount({
    ...ANSWER,
    surface: 'desktop',
    props: { text: 'More parallel [1].', isFirstOfReply: true },
  })

  await ui.press({ key: 'reference-1' })
  expect(shown[0]?.server).toBe('pdf-scholar-dev')
  await ui.unmount()
})
