// End-to-end test for «Bla side for side» (issue #29) in the real app.
//
//   npm run test:paged        (needs `npm run build` first)
//
// The slot geometry has a pure-Node test (test:rotation §8). What only the
// real Chromium can show is the SNAPPING — whether input lands on whole slots:
// a single wheel notch turns exactly one page (and never two, however fast),
// PageDown and → turn a page, the page field lands on its page, a neighbour is
// never in view, a zoomed-in page scrolls within itself before its edge turns
// it, the spread pairs up in slots of its own, and switching the view off and
// on keeps the reader on their page. The wheel here is CDP's mouseWheel — the
// browser's own input path, which is what snapping reacts to; a scrollTop
// written from script snaps differently (to the NEAREST slot, never past).
import { existsSync, mkdtempSync, copyFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cdp, openSocket, waitForPageTargets, launchApp, evaluate, sleep } from './lib/cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const PORT = 9344
const SAMPLE = join(ROOT, 'src', 'renderer', 'public', 'sample.pdf')

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
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`)
}

/** The scroller's state: where it is, its slots, and which pages show */
const view = (send) =>
  evaluate(
    send,
    `const el = document.querySelector('.tab-view.active .pages[data-pane="a"]');
     const slots = [...el.querySelectorAll('.page-slot')].map((s) => ({ top: s.offsetTop, height: s.offsetHeight }));
     const top = el.scrollTop, bottom = top + el.clientHeight;
     const visible = [...el.querySelectorAll('.pdf-page')]
       .map((p, i) => ({ i: i + 1, t: p.offsetTop, b: p.offsetTop + p.offsetHeight }))
       .filter((p) => p.b > top + 1 && p.t < bottom - 1)
       .map((p) => p.i);
     return { top: Math.round(top), height: el.clientHeight, slots, visible,
              paged: el.classList.contains('paged'),
              pageField: document.querySelector('.page-indicator input')?.value ?? null };`
  )

/** Wait until the scroll has stopped moving (snap animations included) */
async function settled(send) {
  let prev = -1
  for (let i = 0; i < 40; i++) {
    const v = await view(send)
    if (v.top === prev) return v
    prev = v.top
    await sleep(120)
  }
  return view(send)
}

async function wheel(send, deltaY, at) {
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY })
  return settled(send)
}

async function key(send, keyName, code, modifiers = 0, keyCode = 0) {
  await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: keyName, code, modifiers, windowsVirtualKeyCode: keyCode })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, modifiers, windowsVirtualKeyCode: keyCode })
  return settled(send)
}

// Within a pixel: at a fractional device pixel ratio the last slot's top can
// lie a hair past the scroller's maximum (780.4 px tall, 780 px slots)
const slotOf = (v) => v.slots.findIndex((s) => Math.abs(s.top - v.top) <= 1)

async function run() {
  if (!existsSync(SAMPLE)) throw new Error(`missing ${SAMPLE} — run npm run sample`)
  const dir = mkdtempSync(join(tmpdir(), 'pdfx-paged-'))
  const DOC = join(dir, 'paged.pdf')
  copyFileSync(SAMPLE, DOC)
  const app = launchApp({
    root: ROOT,
    mainJs: join(ROOT, 'out', 'main', 'index.js'),
    args: [DOC],
    port: PORT,
    prepareProfile: (p) =>
      writeFileSync(join(p, 'pdfx-state.json'), JSON.stringify({ settings: { language: 'nb', pagedView: true } }))
  })
  try {
    const [target] = await waitForPageTargets(PORT, 1)
    const send = cdp(await openSocket(target.webSocketDebuggerUrl))
    await send('Runtime.enable')
    const first = await waitFor(() => view(send).catch(() => null), (v) => v && v.slots.length > 0, 'the paged view')
    const at = await evaluate(
      send,
      `const r = document.querySelector('.tab-view.active .pages').getBoundingClientRect();
       return { x: r.left + r.width / 2, y: r.top + r.height / 2 };`
    )
    await evaluate(send, `document.querySelector('.tab-view.active .pages').focus()`)

    // ---------- 1. The layout ----------
    console.log('\n1. one page per slot, a viewport each')
    const pages = await evaluate(send, `return document.querySelectorAll('.tab-view.active .pdf-page').length`)
    check('one slot per page', first.slots.length === pages, `${first.slots.length} slots, ${pages} pages`)
    check('each slot a viewport tall', first.slots.every((s) => s.height === first.height), JSON.stringify(first.slots.map((s) => s.height)))
    check('only page 1 in view', first.visible.join() === '1', first.visible.join())

    // ---------- 2. Input lands on whole slots ----------
    console.log('\n2. turning pages')
    let v = await wheel(send, 100, at)
    check('one wheel notch turns exactly one page', slotOf(v) === 1 && v.visible.join() === '2', `top=${v.top} visible=${v.visible}`)
    v = await wheel(send, 100, at)
    check('…and the next notch the next one', slotOf(v) === 2, `slot=${slotOf(v)}`)
    // A spun wheel: one page per notch, and past the last page nothing
    for (let i = 0; i < 6; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: 100 })
      await sleep(70)
    }
    v = await settled(send)
    check('a spun wheel turns a page per notch and stops at the last', slotOf(v) === v.slots.length - 1 && v.visible.join() === String(pages), `slot=${slotOf(v)} visible=${v.visible}`)
    v = await wheel(send, -100, at)
    check('a notch up turns back one page', slotOf(v) === v.slots.length - 2, `slot=${slotOf(v)}`)
    // A trackpad: a stream of small deltas, then inertia — one swipe, one page
    const before = slotOf(v)
    for (let i = 0; i < 30; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY: -12 })
      await sleep(12)
    }
    v = await settled(send)
    check('one trackpad swipe turns one page, inertia and all', slotOf(v) === before - 1, `slot ${before} → ${slotOf(v)}`)
    v = await key(send, 'Home', 'Home', 0, 36)
    check('Home goes to the first page', slotOf(v) === 0, `slot=${slotOf(v)}`)
    v = await key(send, 'PageDown', 'PageDown', 0, 34)
    check('PageDown turns one page', slotOf(v) === 1, `slot=${slotOf(v)}`)
    v = await key(send, 'ArrowRight', 'ArrowRight', 0, 39)
    check('→ turns one page', slotOf(v) === 2, `slot=${slotOf(v)}`)
    check('the page field follows', v.pageField === '3', `field=${v.pageField}`)
    v = await key(send, 'ArrowDown', 'ArrowDown', 0, 40)
    check('↓ turns one page', slotOf(v) === 3, `slot=${slotOf(v)}`)
    const clean = []
    for (let i = 0; i < v.slots.length; i++) {
      await evaluate(send, `document.querySelector('.tab-view.active .pages').scrollTop = ${v.slots[i].top}`)
      const here = await settled(send)
      clean.push(here.visible.join() === String(i + 1))
    }
    check('at every slot, its page alone is in view', clean.every(Boolean), JSON.stringify(clean))

    // The page field lands on its page
    await evaluate(
      send,
      `const input = document.querySelector('.page-indicator input');
       const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
       input.focus(); set.call(input, '3'); input.dispatchEvent(new Event('input', { bubbles: true }));
       input.blur();`
    )
    v = await settled(send)
    check('the page field lands on page 3', slotOf(v) === 2 && v.visible.join() === '3', `slot=${slotOf(v)} visible=${v.visible}`)
    // (the scroller had the page field's focus; give it back)

    // ---------- 3. Zoomed in: scroll within the page, turn at its edge ----------
    console.log('\n3. zoomed in')
    await evaluate(send, `document.querySelector('.tab-view.active .pages').focus()`)
    for (let i = 0; i < 4; i++) await key(send, '=', 'Equal', 2, 187) // Ctrl+=
    await sleep(600)
    v = await settled(send)
    const zoomedSlot = v.slots.find((s) => s.top <= v.top && s.top + s.height > v.top)
    check('a zoomed-in page gets a slot taller than the viewport', zoomedSlot && zoomedSlot.height > v.height * 1.3, `slot ${zoomedSlot?.height} vs viewport ${v.height}`)
    const startTop = v.top
    v = await wheel(send, 100, at)
    const inSame = v.top > startTop && v.top + v.height <= zoomedSlot.top + zoomedSlot.height + 1
    check('a notch scrolls within the zoomed page', inSame, `${startTop} → ${v.top}`)
    // Down to the page's foot, then one more notch turns it
    let guard = 0
    while (v.top + v.height < zoomedSlot.top + zoomedSlot.height - 1 && guard++ < 60) v = await wheel(send, 100, at)
    check('the wheel reaches the foot of the zoomed page', v.top + v.height >= zoomedSlot.top + zoomedSlot.height - 1, `bottom ${v.top + v.height} vs ${zoomedSlot.top + zoomedSlot.height}`)
    v = await wheel(send, 100, at)
    check('one more notch turns to the next page, at its top', Math.abs(v.top - (zoomedSlot.top + zoomedSlot.height)) <= 1, `top=${v.top} want ${zoomedSlot.top + zoomedSlot.height}`)
    v = await wheel(send, -100, at)
    check('…and a notch back lands at the foot of the zoomed page', Math.abs(v.top + v.height - (zoomedSlot.top + zoomedSlot.height)) <= 1, `bottom=${v.top + v.height}`)
    await key(send, '0', 'Digit0', 2, 48) // Ctrl+0: back to a fitted page
    await sleep(600)

    // ---------- 4. With the spread ----------
    console.log('\n4. two pages side by side')
    const toggle = async (label) => {
      await evaluate(send, `document.querySelector('button[title^="Zoom og sidevisning"]').click()`)
      await sleep(200)
      await evaluate(
        send,
        `const row = [...document.querySelectorAll('.view-row-toggle')].find((l) => l.textContent.trim() === ${JSON.stringify(label)});
         if (!row) throw new Error('no row ' + ${JSON.stringify(label)});
         row.querySelector('input').click();`
      )
      await sleep(200)
      // The menu stays open for further choices; its own button closes it
      await evaluate(send, `document.querySelector('button[title^="Zoom og sidevisning"]').click()`)
      await sleep(600)
      return settled(send)
    }
    v = await toggle('To sider ved siden av hverandre')
    check('a pair per slot', v.slots.length === Math.ceil(pages / 2), `${v.slots.length} slots`)
    check('the pair alone is in view', v.visible.length === 2 && v.visible[1] === v.visible[0] + 1, v.visible.join())
    const pairAt = slotOf(v)
    v = await wheel(send, 100, at)
    check('a notch turns a whole spread', slotOf(v) === pairAt + 1 && v.visible.length >= 1, `slot ${pairAt} → ${slotOf(v)}, visible ${v.visible}`)
    v = await toggle('To sider ved siden av hverandre')

    // ---------- 5. Off and on again, keeping the page ----------
    console.log('\n5. switching the view')
    await evaluate(send, `document.querySelector('.tab-view.active .pages').scrollTop = ${v.slots[3].top}`)
    v = await settled(send)
    check('on page 4 before switching', v.visible.join() === '4', v.visible.join())
    v = await toggle('Bla side for side')
    check('off: no slots, no snapping', !v.paged && v.slots.length === 0)
    check('…still on page 4', v.pageField === '4', `field=${v.pageField}`)
    v = await toggle('Bla side for side')
    check('on again: back in slots', v.paged && v.slots.length === pages)
    check('…on page 4, alone', v.visible.join() === '4', v.visible.join())
    const settings = await evaluate(send, 'return window.api.getSettings()')
    check('the choice is the preference for every document', settings.pagedView === true)

    // ---------- 6. The split: both columns page ----------
    console.log('\n6. split view')
    await evaluate(send, `document.querySelector('.tab-view.active .pages').focus()`)
    await key(send, 's', 'KeyS', 0, 83)
    const paneB = () =>
      evaluate(
        send,
        `const el = document.querySelector('.tab-view.active .pages[data-pane="b"]');
         if (!el) return null;
         const slots = [...el.querySelectorAll('.page-slot')].map((s) => s.offsetTop);
         const r = el.getBoundingClientRect();
         return { paged: el.classList.contains('paged'), slots, top: Math.round(el.scrollTop), x: r.left + r.width / 2, y: r.top + r.height / 2, height: el.clientHeight,
                  pageH: el.querySelector('.pdf-page')?.offsetHeight ?? 0 };`
      )
    const b = await waitFor(paneB, (x) => x && x.slots.length === pages, 'the second column, paged')
    check('the second column pages too', b.paged && b.slots.length === pages)
    check('…at a whole page', b.pageH + 20 <= b.height + 1, `page ${b.pageH} in ${b.height}`)
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: b.x, y: b.y, deltaX: 0, deltaY: 100 })
    await sleep(500)
    const b2 = await paneB()
    check('a notch over it turns its page', Math.abs(b2.top - b2.slots[Math.min(1, b2.slots.length - 1)]) <= 1 || b2.top > b.top, `${b.top} → ${b2.top}`)
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
    console.error('\ntest-paged failed:', err)
    process.exit(1)
  })
