// Render the same Markdown as AssistantBody, without a window or provider.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { renderToStaticMarkup } from 'react-dom/server'

const dir = mkdtempSync(join(tmpdir(), 'ai-markdown-'))
try {
  const outfile = join(dir, 'markdown.mjs')
  await build({
    entryPoints: [fileURLToPath(new URL('../src/renderer/src/components/ai-markdown.tsx', import.meta.url))],
    outfile, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', loader: { '.css': 'empty' }
  })
  const { renderMarkdown } = await import(pathToFileURL(outfile).href)
  const render = (text) => renderToStaticMarkup(renderMarkdown(text))
  const formula = String.raw`\(a*b\)`
  const plain = render(formula)
  assert.match(plain, /class="katex"/)
  for (const [mark, open, close] of [
    ['*', '<em>', '</em>'],
    ['**', '<strong>', '</strong>'],
    ['***', '<strong><em>', '</em></strong>']
  ]) {
    const html = render(`${mark}Before ${formula} after${mark}`)
    assert.equal(html, plain.replace('<p>', `<p>${open}Before `).replace('</p>', ` after${close}</p>`),
      `${mark}: keep the surrounding emphasis and render the complete formula`)
  }
  assert.equal(render('**Use `' + formula + '` here**'), `<p><strong>Use <code>${formula}</code> here</strong></p>`)
  assert.equal(render(String.raw`*Unfinished \(x*`), String.raw`<p><em>Unfinished \(x</em></p>`)
  console.log('ai-markdown: all passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
