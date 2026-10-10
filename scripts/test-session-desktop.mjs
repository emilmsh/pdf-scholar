// End-to-end test for the desktop session and pinned tabs (issue #29) in the
// real app.
//
//   npm run test:session-desktop        (needs `npm run build` first)
//
// The rules have a pure-Node test (test:session); this is everything that only
// exists with windows and a main process:
//   1. a stored session reopens its tabs LAZILY — names in the strip, no file
//      read until a tab is shown (proved by the recents, which every read
//      files: a tab never shown must not be in them), pinned tabs first and
//      without a close cross, a file from the command line in front, a file
//      that is gone left out
//   2. pinning from the tab menu moves the tab into the pinned group, and
//      «Lukk andre faner» leaves pinned tabs standing
//   3. closing the last window writes the strip as the next session — then a
//      relaunch from it reopens exactly that, the showing tab showing
//   4. restoreSession off brings back the pinned tabs only
//   5. a session of two windows reopens two windows, each with its own tabs
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9343
const SAMPLE = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')
const MAIN = join(ROOT, 'out', 'main', 'index.js')

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

async function waitFor(fn, ready, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await fn()
    if (ready(last)) return last
    await sleep(200)
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`)
}

/** The strip as the reader sees it */
const strip = (send) =>
  evaluate(
    send,
    `return [...document.querySelectorAll('.tab')].map((t) => ({
       name: t.querySelector('.tab-label')?.textContent?.replace('•', '') ?? '',
       pinned: t.classList.contains('pinned'),
       close: !!t.querySelector('.tab-close'),
       active: t.classList.contains('active')
     }))`
  )
const label = (tabs) => tabs.map((t) => `${t.pinned ? '*' : ''}${t.name}${t.active ? '<' : ''}`).join(',')

/** Launch with a state file, hand back a page connection, run `body`, and
 *  return the state file as the app left it (after `body` lets it quit) */
async function withApp({ state, args = [], windows = 1 }, body) {
  let profile = ''
  const app = launchApp({
    root: ROOT,
    mainJs: MAIN,
    args,
    port: PORT,
    prepareProfile: (p) => {
      profile = p
      writeFileSync(join(p, 'pdfx-state.json'), JSON.stringify(state))
    }
  })
  try {
    const targets = await waitForPageTargets(PORT, windows)
    const sends = []
    for (const target of targets) {
      const send = cdp(await openSocket(target.webSocketDebuggerUrl))
      await send('Runtime.enable')
      sends.push(send)
    }
    const exited = new Promise((done) => app.child.once('exit', done))
    await body(sends, exited)
    const file = join(profile, 'pdfx-state.json')
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : null
  } finally {
    await app.cleanup()
  }
}

async function run() {
  if (!existsSync(SAMPLE)) throw new Error(`missing ${SAMPLE} — run npm run sample`)
  const dir = mkdtempSync(join(tmpdir(), 'pdfx-session-'))
  const file = (name) => {
    const p = join(dir, name)
    copyFileSync(SAMPLE, p)
    return p
  }
  const PINNED = file('pinned.pdf')
  const SHOWN = file('shown.pdf')
  const NEVER = file('never.pdf')
  const LAUNCH = file('launch.pdf')
  const GONE = join(dir, 'gone.pdf') // in the session, not on disk

  try {
    // ---------- 1. A stored session reopens lazily ----------
    console.log('\n1. a stored session at launch')
    const after = await withApp(
      {
        state: {
          recents: [],
          settings: { language: 'nb' },
          session: {
            windows: [
              {
                tabs: [{ path: PINNED, pinned: true }, { path: SHOWN }, { path: GONE }, { path: NEVER }],
                active: 1
              }
            ]
          }
        },
        args: [LAUNCH]
      },
      async ([send], exited) => {
        const tabs = await waitFor(() => strip(send), (s) => s.length === 4 && s.some((t) => t.active), 'the restored strip')
        check('the session\'s tabs plus the launch file, the gone file left out', label(tabs).replace('<', '') === '*pinned.pdf,shown.pdf,never.pdf,launch.pdf', label(tabs))
        check('the launch file is the one in front', tabs[3].active)
        check('a pinned tab has no close cross', tabs[0].pinned && !tabs[0].close && tabs[1].close)
        await waitFor(() => evaluate(send, `return !!document.querySelector('.tab-view.active .pdf-page')`), (v) => v, 'the launch file to render')
        const lazy = await evaluate(send, `return document.querySelectorAll('.tab-view.tab-pending').length`)
        check('the three restored tabs mount no viewer yet', lazy === 3, `pending=${lazy}`)
        const recents1 = (await evaluate(send, 'return window.api.getRecents()')).map((r) => r.name)
        check('only the launch file was read', recents1.join() === 'launch.pdf', recents1.join())

        // Showing a restored tab reads it — and only it
        await evaluate(send, `[...document.querySelectorAll('.tab-label')].find((b) => b.textContent === 'shown.pdf').click()`)
        await waitFor(() => evaluate(send, `return document.querySelector('.tab.active .tab-label')?.textContent === 'shown.pdf' && !!document.querySelector('.tab-view.active .pdf-page')`), (v) => v, 'shown.pdf to render')
        check('a restored tab reads its file when shown', true)
        const recents2 = (await evaluate(send, 'return window.api.getRecents()')).map((r) => r.name)
        check('…and only that one: never.pdf is still unread', recents2.join() === 'shown.pdf,launch.pdf', recents2.join())

        // ---------- 2. Pinning, and the bulk close leaving pins alone ----------
        console.log('\n2. pinning')
        const menu = async (name, item) => {
          await evaluate(
            send,
            `const tab = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-label').textContent.replace('•', '') === ${JSON.stringify(name)});
             const r = tab.getBoundingClientRect();
             tab.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));`
          )
          await sleep(100)
          await evaluate(
            send,
            `const item = [...document.querySelectorAll('.tab-menu .menu-item')].find((b) => b.textContent === ${JSON.stringify(item)});
             if (!item) throw new Error('no menu item ' + ${JSON.stringify(item)});
             item.click();`
          )
        }
        await menu('launch.pdf', 'Fest fanen')
        const pinned = await waitFor(() => strip(send), (s) => s[1]?.name === 'launch.pdf', 'launch.pdf to join the pinned group')
        check('a pinned tab joins the end of the pinned group', label(pinned).replace(/</g, '') === '*pinned.pdf,*launch.pdf,shown.pdf,never.pdf', label(pinned))
        await menu('shown.pdf', 'Lukk andre faner')
        const closed = await waitFor(() => strip(send), (s) => s.length === 3, '«Lukk andre faner»')
        check('«Lukk andre faner» leaves the pinned tabs standing', label(closed).replace(/</g, '') === '*pinned.pdf,*launch.pdf,shown.pdf', label(closed))
        // Moving a tab stops at the pinned group's border (Ctrl+Shift+PageUp
        // on the first unpinned tab, which is the one showing)
        await evaluate(
          send,
          `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', code: 'PageUp', ctrlKey: true, shiftKey: true, bubbles: true }))`
        )
        await sleep(200)
        const moved = await strip(send)
        check('a tab moved left stops at the pinned group', label(moved).replace(/</g, '') === '*pinned.pdf,*launch.pdf,shown.pdf', label(moved))

        // ---------- 3. Closing the last window writes the session ----------
        console.log('\n3. closing the last window')
        await sleep(700) // past the strip report's debounce
        await send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {})
        await Promise.race([exited, sleep(10_000)])
      }
    )
    const written = after?.session?.windows ?? []
    check('one window in the written session', written.length === 1, JSON.stringify(after?.session))
    const w0 = written[0]
    check(
      'it holds the strip as it was left, pins marked',
      w0 && w0.tabs.map((t) => `${t.pinned ? '*' : ''}${t.path.split(/[\\/]/).pop()}`).join() === '*pinned.pdf,*launch.pdf,shown.pdf',
      JSON.stringify(w0?.tabs)
    )
    check('…and the tab that was showing', w0 && w0.tabs[w0.active]?.path === SHOWN, `active=${w0?.active}`)

    // The relaunch reopens exactly that
    console.log('\n3b. relaunching from it')
    await withApp({ state: { ...after, recents: [] } }, async ([send]) => {
      const tabs = await waitFor(() => strip(send), (s) => s.length === 3 && s.some((t) => t.active), 'the strip from the written session')
      check('the relaunch reopens the strip', label(tabs) === '*pinned.pdf,*launch.pdf,shown.pdf<', label(tabs))
      await waitFor(() => evaluate(send, `return !!document.querySelector('.tab-view.active .pdf-page')`), (v) => v, 'the showing tab to render')
      check('the showing tab renders', true)
    })

    // ---------- 4. restoreSession off: pinned tabs only ----------
    console.log('\n4. restoreSession off')
    await withApp({ state: { ...after, recents: [], settings: { ...after.settings, restoreSession: false } } }, async ([send]) => {
      await waitFor(() => strip(send), (s) => s.length >= 2, 'the pinned tabs')
      await sleep(500)
      const settled = await strip(send)
      check('only the pinned tabs come back', label(settled).replace(/</g, '') === '*pinned.pdf,*launch.pdf', label(settled))
    })

    // ---------- 5. Two windows ----------
    console.log('\n5. a session of two windows')
    await withApp(
      {
        state: {
          recents: [],
          settings: { language: 'nb' },
          session: {
            windows: [
              { tabs: [{ path: PINNED }], active: 0, bounds: { x: 40, y: 40, width: 900, height: 700 } },
              { tabs: [{ path: SHOWN }, { path: NEVER }], active: 1, bounds: { x: 200, y: 120, width: 900, height: 700 } }
            ]
          }
        },
        windows: 2
      },
      async (sends) => {
        const strips = await Promise.all(
          sends.map((send) => waitFor(() => strip(send), (s) => s.length > 0 && s.some((t) => t.active), 'a window strip'))
        )
        const labels = strips.map(label).sort()
        check('each window reopens with its own tabs', labels.join(' | ') === 'pinned.pdf< | shown.pdf,never.pdf<', labels.join(' | '))
      }
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

run()
  .then(() => {
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('\ntest-session-desktop failed:', err)
    process.exit(1)
  })
