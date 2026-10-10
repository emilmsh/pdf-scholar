// End-to-end test for the library's grid of first pages (issue #28) in the real
// desktop app.
//
//   npm run test:recents-grid        (needs `npm run build` first)
//
// The rules have a pure-Node test (test:recent-thumbs); this is everything that
// only exists with a window: the viewer takes the picture of a document it has
// open, the grid draws the ones it never took — WITHOUT filing those documents
// as just opened (readFile would move each to the top of the very list being
// drawn, and onto the OS jump list) — a locked document shows a lock and leaves
// no picture on disk, opened with its password or not, and a reader who keeps
// the list pays nothing: no picture is taken while the list is chosen.
//
// The pictures must also be PICTURES: each one is drawn onto a canvas and has
// to carry ink, since a white JPEG would pass every other check here.
//
// Keeping the library tidy (issue #29): a pinned entry moves into «Festet»,
// a removed one leaves the grid AND the disk, «Angre» puts it back where it
// was with its own date, Delete on a focused card does the same as the cross,
// the cross is reachable by a real pointer once the card is hovered (a button
// drawn but covered would pass a dispatched click), and the size buttons
// change the grid and are remembered.
//
// SHOT_DIR=<folder> also saves a screenshot of the grid with a pinned group,
// for looking at rather than asserting.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import * as mupdf from 'mupdf'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9341
const SAMPLE = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')
const PASSWORD = 'grid-test'

let failures = 0
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? '  (' + detail + ')' : ''}`)
  if (!cond) failures++
}

const keyOf = (path) => createHash('sha1').update(path).digest('hex')

/** What the library shows, card by card, plus the ink in each picture */
const readGrid = (send) =>
  evaluate(
    send,
    `
    const grid = document.querySelector('.recents-grid');
    const cards = [...document.querySelectorAll('.recent-card')].map((card) => {
      const img = card.querySelector('.recent-cover img');
      let ink = 0;
      if (img && img.complete && img.naturalWidth > 0) {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] < 384) ink++;
      }
      return {
        name: card.querySelector('.recent-card-name')?.textContent ?? '',
        image: !!img,
        width: img ? img.naturalWidth : 0,
        height: img ? img.naturalHeight : 0,
        ink,
        locked: !img && !!card.querySelector('.recent-cover svg rect'),
        meta: card.querySelector('.recent-card-meta')?.textContent ?? null,
        progress: card.querySelector('.recent-progress')?.style.width ?? null
      };
    });
    return { grid: !!grid, list: !!document.querySelector('.recent-row'), cards };
  `
  )

async function waitFor(fn, ready, what, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await fn()
    if (ready(last)) return last
    await sleep(250)
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`)
}

const click = (send, selector) =>
  evaluate(
    send,
    `const el = document.querySelector(${JSON.stringify(selector)});
     if (!el) throw new Error('no element ' + ${JSON.stringify(selector)});
     el.dispatchEvent(new MouseEvent('click', { bubbles: true }));`
  )

const meta = (profile, path) => {
  const file = join(profile, 'recent-thumbs', `${keyOf(path)}.json`)
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : null
}
const hasPicture = (profile, path) => existsSync(join(profile, 'recent-thumbs', `${keyOf(path)}.jpg`))

async function run() {
  if (!existsSync(SAMPLE)) throw new Error(`missing ${SAMPLE} — run npm run sample`)
  const dir = mkdtempSync(join(tmpdir(), 'pdfx-grid-'))
  const OPENED = join(dir, 'opened.pdf') // open in a tab → the viewer pictures it
  const OLDER = join(dir, 'older.pdf') // recent from before the grid → the grid draws it
  const GONE = join(dir, 'gone.pdf') // in the recents, not on disk → placeholder
  const LOCKED = join(dir, 'locked.pdf') // encrypted, never opened → lock, no picture
  const UNLOCKED = join(dir, 'unlocked.pdf') // encrypted, opened WITH the password → lock too
  copyFileSync(SAMPLE, OPENED)
  copyFileSync(SAMPLE, OLDER)
  const encrypted = mupdf.PDFDocument.openDocument(readFileSync(SAMPLE), 'application/pdf')
    .saveToBuffer(`encrypt=aes-256,user-password=${PASSWORD},owner-password=${PASSWORD}-owner`)
    .asUint8Array()
  writeFileSync(LOCKED, encrypted)
  writeFileSync(UNLOCKED, encrypted)

  const day = 24 * 3600 * 1000
  const recents = [
    { path: OLDER, name: 'older.pdf', lastOpened: Date.now() - 1 * day },
    { path: GONE, name: 'gone.pdf', lastOpened: Date.now() - 2 * day },
    { path: LOCKED, name: 'locked.pdf', lastOpened: Date.now() - 3 * day },
    { path: UNLOCKED, name: 'unlocked.pdf', lastOpened: Date.now() - 4 * day }
  ]

  let profile = ''
  const app = launchApp({
    root: ROOT,
    mainJs: join(ROOT, 'out', 'main', 'index.js'),
    args: [OPENED],
    port: PORT,
    prepareProfile: (p) => {
      profile = p
      writeFileSync(
        join(p, 'pdfx-state.json'),
        JSON.stringify({
          recents,
          positions: { [OLDER]: { page: 2, offset: 0, zoom: 1 } },
          settings: { recentsView: 'grid', language: 'nb' }
        })
      )
    }
  })
  try {
    const [target] = await waitForPageTargets(PORT, 1)
    const send = cdp(await openSocket(target.webSocketDebuggerUrl))
    await send('Runtime.enable')

    // ---------- 1. The viewer pictures what it opens ----------
    console.log('\n1. a document opened while the grid is chosen')
    await waitFor(() => Promise.resolve(meta(profile, OPENED)), (m) => m !== null, 'the opened document to be pictured')
    const opened = meta(profile, OPENED)
    check('the open document got a picture on disk', hasPicture(profile, OPENED))
    check('with its page count', opened.pages > 1, `pages=${opened.pages}`)

    // ---------- 2. The library draws the rest, without reshuffling it ----------
    console.log('\n2. the library')
    const before = await evaluate(send, 'return window.api.getRecents()')
    await click(send, `button[title="Tilbake til biblioteket"]`)
    const shown = await waitFor(
      () => readGrid(send),
      (g) => g.cards.length === 5 && g.cards.filter((c) => c.ink > 0).length >= 2,
      'the grid with two pictures'
    )
    check('the grid is what the library shows', shown.grid && !shown.list)
    const byName = Object.fromEntries(shown.cards.map((c) => [c.name, c]))
    check('the opened document shows its picture', byName['opened.pdf']?.image === true)
    check('a recent from before the grid is drawn by the grid', byName['older.pdf']?.image === true)
    for (const name of ['opened.pdf', 'older.pdf']) {
      const c = byName[name]
      check(`${name}: the picture has ink (not a blank sheet)`, c.ink > 200, `ink=${c.ink}`)
      check(`${name}: drawn at the stored size`, Math.max(c.width, c.height) === 480, `${c.width}×${c.height}`)
    }
    check('the reading position shows as «s. 2 av N»', /^s\. 2 av \d+$/.test(byName['older.pdf']?.meta ?? ''), byName['older.pdf']?.meta)
    check('…and as a line along the foot of the page', /%$/.test(byName['older.pdf']?.progress ?? ''), byName['older.pdf']?.progress)
    check('a file that is gone keeps a placeholder', byName['gone.pdf']?.image === false && byName['gone.pdf']?.locked === false)

    const locked = await waitFor(
      () => readGrid(send),
      (g) => g.cards.find((c) => c.name === 'locked.pdf')?.locked,
      'the encrypted file to show a lock'
    )
    check('an encrypted file shows a lock', locked.cards.find((c) => c.name === 'locked.pdf').locked)
    check('…and keeps NO picture on disk', !hasPicture(profile, LOCKED) && meta(profile, LOCKED)?.locked === true)
    check('the missing file left nothing on disk', meta(profile, GONE) === null)

    const after = await evaluate(send, 'return window.api.getRecents()')
    const order = (list) => list.map((r) => `${r.path}@${r.lastOpened}`).join('|')
    check('drawing the pictures did not reorder or re-date the recents', order(before) === order(after))

    // ---------- 3. A locked document opened with its password ----------
    console.log('\n3. an encrypted document opened with its password')
    await evaluate(send, `window.api.newWindow(${JSON.stringify(UNLOCKED)})`)
    const targets = await waitForPageTargets(PORT, 2)
    const second = targets.find((t) => t.webSocketDebuggerUrl !== target.webSocketDebuggerUrl)
    const send2 = cdp(await openSocket(second.webSocketDebuggerUrl))
    await send2('Runtime.enable')
    await waitFor(
      () => evaluate(send2, `return !!document.querySelector('.password-input')`),
      (v) => v,
      'the password prompt'
    )
    await evaluate(
      send2,
      `const input = document.querySelector('.password-input');
       const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
       set.call(input, ${JSON.stringify(PASSWORD)});
       input.dispatchEvent(new Event('input', { bubbles: true }));
       await new Promise((r) => setTimeout(r, 50));
       input.closest('form').requestSubmit();`
    )
    // The grid already marked it locked with no page count (it never had the
    // password); the viewer, which has, records the page count too
    await waitFor(() => Promise.resolve(meta(profile, UNLOCKED)), (m) => m?.pages > 0, 'the unlocked document to be recorded')
    const unlocked = meta(profile, UNLOCKED)
    check('opened with its password: recorded as locked', unlocked.locked === true)
    check('…with its page count (the reader did open it)', unlocked.pages > 1, `pages=${unlocked.pages}`)
    check('…and still NO picture on disk', !hasPicture(profile, UNLOCKED))
    await send2('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {})

    // ---------- 4. The list: no pictures taken ----------
    console.log('\n4. the list')
    await click(send, `.recents-view button[aria-label="Vis som liste"]`)
    const list = await waitFor(() => readGrid(send), (g) => g.list, 'the list')
    check('the switch shows the list', list.list && !list.grid)
    const settings = await evaluate(send, 'return window.api.getSettings()')
    check('the choice is remembered', settings.recentsView === 'list')
    const takenBefore = meta(profile, OLDER).taken
    await evaluate(
      send,
      `[...document.querySelectorAll('.recent-row')]
         .find((row) => row.querySelector('.recent-name')?.textContent === 'older.pdf')
         .dispatchEvent(new MouseEvent('click', { bubbles: true }));`
    )
    // Long enough for the viewer's idle-time picture (4 s ceiling) to have fired
    await sleep(6000)
    check('opening a document while the list is chosen takes no picture', meta(profile, OLDER).taken === takenBefore)

    // ---------- 5. Keeping the library tidy (issue #29) ----------
    console.log('\n5. pin, remove, undo, size')
    await click(send, `button[title="Tilbake til biblioteket"]`)
    await waitFor(() => readGrid(send), (g) => g.list, 'the library again')
    await click(send, `.recents-view button[aria-label="Vis forsidene"]`)
    await waitFor(() => readGrid(send), (g) => g.grid && g.cards.length === 5, 'the grid again')

    const cardSel = (name) =>
      `[...document.querySelectorAll('.recent-item')].find((li) =>
         li.querySelector('.recent-card-name, .recent-name')?.textContent === ${JSON.stringify(name)})`
    const groups = () =>
      evaluate(
        send,
        `return [...document.querySelectorAll('.recents-group')].map((g) => ({
           label: g.querySelector('h3')?.textContent ?? null,
           names: [...g.querySelectorAll('.recent-card-name, .recent-name')].map((n) => n.textContent)
         }))`
      )

    // Pin
    await evaluate(send, `${cardSel('gone.pdf')}.querySelector('.recent-action[aria-label="Fest øverst"]').click()`)
    const pinnedGroups = await waitFor(groups, (g) => g.length === 2, 'the «Festet» group')
    check('a pinned entry gets a «Festet» group of its own', pinnedGroups[0].label === 'Festet' && pinnedGroups[0].names.join() === 'gone.pdf', JSON.stringify(pinnedGroups))
    check('…and leaves the rest', !pinnedGroups[1].names.includes('gone.pdf'))
    const storedPin = (await evaluate(send, 'return window.api.getRecents()')).find((r) => r.path === GONE)
    check('the pin is stored', typeof storedPin?.pinnedAt === 'number')

    if (process.env.SHOT_DIR) {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(process.env.SHOT_DIR, 'recents-grid-pinned.png'), Buffer.from(shot.data, 'base64'))
    }

    // A real pointer reaches the cross once the card is hovered
    const box = await evaluate(
      send,
      `const li = ${cardSel('older.pdf')};
       li.scrollIntoView({ block: 'center' });
       await new Promise((done) => setTimeout(done, 100));
       const r = li.getBoundingClientRect();
       return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`
    )
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
    const reach = await waitFor(
      () =>
        evaluate(
          send,
          `const btn = ${cardSel('older.pdf')}.querySelector('.recent-action[aria-label="Fjern fra Nylig lest"]');
           const r = btn.getBoundingClientRect();
           return { hit: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === btn,
                    shown: getComputedStyle(btn.parentElement).opacity };`
        ),
      (v) => v.shown === '1' && v.hit,
      'the hovered card to show its cross',
      3000
    ).catch((err) => ({ hit: false, shown: String(err.message).slice(-60) }))
    check('hovering a card shows its cross', reach.shown === '1', `opacity ${reach.shown}`)
    check('…and a pointer at the cross reaches it', reach.hit)

    // Remove → gone from the grid and the disk; Angre → back where it was
    const listBefore = await evaluate(send, 'return window.api.getRecents()')
    const indexBefore = listBefore.findIndex((r) => r.path === OLDER)
    await evaluate(send, `${cardSel('older.pdf')}.querySelector('.recent-action[aria-label="Fjern fra Nylig lest"]').click()`)
    const afterRemove = await waitFor(() => readGrid(send), (g) => !g.cards.some((c) => c.name === 'older.pdf'), 'the card to go')
    check('a removed entry leaves the grid', afterRemove.cards.length === 4)
    await waitFor(() => Promise.resolve(meta(profile, OLDER) === null && !hasPicture(profile, OLDER)), (v) => v, 'its picture to go')
    check('…and its picture leaves the disk', meta(profile, OLDER) === null && !hasPicture(profile, OLDER))
    check('…and the store no longer lists it', !(await evaluate(send, 'return window.api.getRecents()')).some((r) => r.path === OLDER))
    const toast = await evaluate(send, `return document.querySelector('.recents-undo')?.textContent ?? null`)
    check('a toast offers «Angre»', /older\.pdf/.test(toast ?? '') && /Angre/.test(toast ?? ''), toast)
    await click(send, '.recents-undo .toast-action')
    await waitFor(() => readGrid(send), (g) => g.cards.some((c) => c.name === 'older.pdf'), 'the card to come back')
    const listAfter = await evaluate(send, 'return window.api.getRecents()')
    const restored = listAfter.find((r) => r.path === OLDER)
    check('«Angre» puts it back at its place', listAfter.findIndex((r) => r.path === OLDER) === indexBefore)
    check('…with its own date, not as just opened', restored?.lastOpened === listBefore[indexBefore].lastOpened)
    check('the toast goes with the undo', !(await evaluate(send, `return !!document.querySelector('.recents-undo')`)))

    // Delete on a focused card
    await evaluate(
      send,
      `const card = ${cardSel('opened.pdf')}.querySelector('.recent-card');
       card.focus();
       card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));`
    )
    await waitFor(() => readGrid(send), (g) => !g.cards.some((c) => c.name === 'opened.pdf'), 'Delete to remove')
    check('Delete on a focused card removes it', true)
    await click(send, '.recents-undo .toast-action')
    await waitFor(() => readGrid(send), (g) => g.cards.some((c) => c.name === 'opened.pdf'), 'its undo')

    // Size
    const columnsNow = () =>
      evaluate(
        send,
        `return getComputedStyle(document.querySelector('.recents-group.after-pinned .recents-grid')).gridTemplateColumns.split(' ').length`
      )
    const mediumColumns = await columnsNow()
    const gridWidth = await evaluate(send, `return document.querySelector('.recents-box').getBoundingClientRect().width`)
    const columnWidth = await evaluate(send, `return document.querySelector('.welcome-inner').getBoundingClientRect().width`)
    check('the grid steps out of the library column', gridWidth > columnWidth + 100, `${gridWidth} vs ${columnWidth}`)
    await click(send, `.recents-size button[aria-label="Større forsider"]`)
    const large = await evaluate(send, `return document.querySelector('.recents-grid')?.className ?? ''`)
    check('«Større forsider» draws the large size', /size-large/.test(large), large)
    const largeColumns = await columnsNow()
    check('…fewer, larger pages across', largeColumns < mediumColumns, `${mediumColumns} → ${largeColumns}`)
    check('…and is remembered', (await evaluate(send, 'return window.api.getSettings()')).recentsGridSize === 'large')
    check(
      'the larger button stops at the largest size',
      await evaluate(send, `return document.querySelector('.recents-size button[aria-label="Større forsider"]').disabled`)
    )
    if (process.env.SHOT_DIR) {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(join(process.env.SHOT_DIR, 'recents-grid-large.png'), Buffer.from(shot.data, 'base64'))
    }

    // Unpin: back among the rest, no label left
    await evaluate(send, `${cardSel('gone.pdf')}.querySelector('.recent-action[aria-label="Løsne"]').click()`)
    const unpinned = await waitFor(groups, (g) => g.length === 1, 'the «Festet» group to go')
    check('unpinning the last pin removes the «Festet» label', unpinned[0].label === null && unpinned[0].names.includes('gone.pdf'))

    // ---------- 6. Housekeeping ----------
    console.log('\n6. housekeeping')
    const files = readdirSync(join(profile, 'recent-thumbs'))
    check(
      'nothing but entry files in the store',
      files.every((f) => /^[0-9a-f]{40}\.(jpg|json)$/.test(f)),
      files.join(', ')
    )
  } finally {
    await app.cleanup()
    rmSync(dir, { recursive: true, force: true })
  }
}

run()
  .then(() => {
    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('\ntest-recents-grid failed:', err)
    process.exit(1)
  })
