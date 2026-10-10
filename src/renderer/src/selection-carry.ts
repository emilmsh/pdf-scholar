// Keeping a live text selection across a text-layer rebuild.
//
// A page's text layer is rebuilt whenever the pdf.js document under it is
// swapped, and a swap is what every re-read does: another window annotated the
// same file (`annots:changed-elsewhere`), the shared draft was saved or
// discarded elsewhere, another tab's split column wrote to it, or this window
// edited a mark the file already painted. None of those change a single
// character of the page's text — but the rebuild replaces every span, and a
// selection anchored in a removed node collapses. So text the reader had just
// selected (or was dragging across) vanished under them, with no menu and no
// way to tell why. test:windows tripped over it one run in three (2026-10-10):
// window B's selection was taken 12 ms after it was made by the re-read that
// window A's highlight caused.
//
// The new layer is built from the same text content, so it has the same DOM
// shape: an endpoint is carried over by its child-index path from the layer
// root, and only when the node at the end of that path holds exactly the same
// text. Anything else (a page whose text really changed) is left alone.

/** Child-index path from `root` down to `node`, or null when `node` is not inside it */
function pathWithin(root: Node, node: Node): number[] | null {
  const path: number[] = []
  let n: Node | null = node
  while (n && n !== root) {
    const parent: Node | null = n.parentNode
    if (!parent) return null
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, n))
    n = parent
  }
  return n === root ? path : null
}

/** The node at `path` under `root`, if it holds the same text as `like` */
function nodeAt(root: Node, path: number[], like: Node): Node | null {
  let n: Node | undefined = root
  for (const i of path) {
    n = n.childNodes[i]
    if (!n) return null
  }
  if (n.nodeType !== like.nodeType || n.textContent !== like.textContent) return null
  return n
}

/**
 * Call BEFORE replacing `oldLayer` with `newLayer`; run what it returns right
 * AFTER the swap. Restores the window's selection onto the same characters of
 * the new layer — direction kept, an endpoint outside this layer (a selection
 * running on to another page) untouched. Returns null when there is nothing to
 * carry: no selection, or none touching this layer.
 */
export function carrySelection(oldLayer: Node | null, newLayer: Node): (() => void) | null {
  if (!oldLayer) return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
  const { anchorNode, anchorOffset, focusNode, focusOffset } = sel
  if (!anchorNode || !focusNode) return null
  const anchorPath = pathWithin(oldLayer, anchorNode)
  const focusPath = pathWithin(oldLayer, focusNode)
  if (!anchorPath && !focusPath) return null
  return () => {
    const anchor = anchorPath ? nodeAt(newLayer, anchorPath, anchorNode) : anchorNode
    const focus = focusPath ? nodeAt(newLayer, focusPath, focusNode) : focusNode
    if (!anchor?.isConnected || !focus?.isConnected) return
    try {
      sel.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
    } catch {
      // An offset past the node's end: the layer is not the same after all
    }
  }
}
