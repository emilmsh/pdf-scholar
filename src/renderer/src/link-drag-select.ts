// A drag that STARTS on a link must still select text.
//
// The link rects sit above the text layer (.link-host, z-index 3), so a press
// on a linked address lands on an empty <a>, not on a text span. The browser
// then anchors the selection in that anchor — which comes after the whole text
// layer in the DOM — and dragging to the end of the address selected
// everything from there to the end of the page. This takes the press over:
// the caret under the pointer (looked up with the links out of the way) is the
// anchor, and the drag extends from it like any other selection.
//
// A press that never moves is left alone, so it stays a click that follows the
// link; a drag that did select swallows the click that would otherwise open it.

const DRAG_PX = 4

interface Caret {
  node: Node
  offset: number
}

/** The text caret under (x, y) with the link rects hidden from hit-testing.
 *  Only a caret inside a text-layer span counts: between lines the hit is the
 *  layer itself, and a selection end there would reach a whole block. */
function caretBelowLinks(linkHost: HTMLElement, x: number, y: number): Caret | null {
  linkHost.classList.add('probing')
  try {
    let node: Node | null = null
    let offset = 0
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y)
      if (pos) {
        node = pos.offsetNode
        offset = pos.offset
      }
    } else if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y)
      if (range) {
        node = range.startContainer
        offset = range.startOffset
      }
    }
    if (!node) return null
    const el = node instanceof Element ? node : node.parentElement
    return el?.closest('.textLayer span') ? { node, offset } : null
  } finally {
    linkHost.classList.remove('probing')
  }
}

/** Wire one link anchor. Returns the check its click handler runs: true when
 *  the click closes a drag-selection and must not follow the link. */
export function selectFromLink(anchor: HTMLElement, linkHost: HTMLElement): () => boolean {
  let dragged = false

  anchor.addEventListener('mousedown', (e) => {
    dragged = false
    // Plain primary button only: Ctrl/Cmd+click means «open over there», and
    // Shift extends a selection the browser already knows how to extend.
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
    const start = caretBelowLinks(linkHost, e.clientX, e.clientY)
    if (!start) return
    // Taking the press over also stops the browser dragging the link itself
    e.preventDefault()
    const downX = e.clientX
    const downY = e.clientY

    const move = (m: MouseEvent): void => {
      if (!dragged && Math.hypot(m.clientX - downX, m.clientY - downY) < DRAG_PX) return
      dragged = true
      const end = caretBelowLinks(linkHost, m.clientX, m.clientY)
      if (!end) return
      window.getSelection()?.setBaseAndExtent(start.node, start.offset, end.node, end.offset)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })

  return () => {
    const wasDrag = dragged
    dragged = false
    return wasDrag
  }
}
