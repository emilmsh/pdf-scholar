// The icon on the BROWSER TAB a document is read in — the extension's
// counterpart to the Explorer file icon (shared/file-icon.ts, issue #26). A
// tab in Edge or Chrome is where the browser user sees a document's icon, so
// the gear menu offers the same choices there: the six document variants, the
// app logo (what the tab has always worn — the extension icon), or a picture
// of the reader's own. The variants are the SAME renders Explorer's .ico files
// hold (scripts/render-file-icon.cjs writes 16 and 32 px copies for this), so
// the tab and the file look alike.
//
// Nothing here touches storage: the choice lives in Settings (tabIcon,
// tabIconImage) like every other preference; this module turns it into
// <link rel="icon"> elements and turns a picked file into a stored picture.
import { tabIconSizeProblem, type FileIconChoice, type TabIconErrorCode } from '../../shared/file-icon'
import appIcon16 from '../../extension/icons/icon-16.png'
import appIcon32 from '../../extension/icons/icon-32.png'

const RENDERS = import.meta.glob<string>('./assets/tab-icons/*.png', { eager: true, import: 'default' })

/** The pixel size a custom picture is stored at: a tab draws 16 px at 1x and
 *  32 at 2x, and 64 leaves headroom for 3x and the browser's own downscale
 *  without storing more than a few KB in settings. */
export const TAB_ICON_STORE_PX = 64

/** The <link rel="icon"> sources for a choice, by the size each is drawn for.
 *  A custom choice without a stored picture falls back to the app logo — the
 *  tab must always have SOME icon, and that one was the tab's before. */
export function tabIconSources(choice: FileIconChoice, image: string): { size?: number; href: string }[] {
  if (choice === 'custom') {
    return image ? [{ href: image }] : tabIconSources('app', '')
  }
  if (choice === 'app') {
    return [
      { size: 16, href: appIcon16 },
      { size: 32, href: appIcon32 }
    ]
  }
  const at = (size: number): string | undefined => RENDERS[`./assets/tab-icons/${choice}-${size}.png`]
  const s16 = at(16)
  const s32 = at(32)
  // An unknown stored value (a variant renamed in a later version) reads as
  // the logo rather than leaving the tab blank
  if (!s16 || !s32) return tabIconSources('app', '')
  return [
    { size: 16, href: s16 },
    { size: 32, href: s32 }
  ]
}

/** Replace the page's icon links with the ones for this choice. Elements are
 *  swapped rather than re-pointed: Chromium does not reliably notice an href
 *  change on an existing icon link, but it always notices a new one. */
export function applyTabIcon(choice: FileIconChoice, image: string): void {
  if (typeof document === 'undefined') return
  for (const old of document.head.querySelectorAll('link[rel~="icon"]')) old.remove()
  for (const src of tabIconSources(choice, image)) {
    const link = document.createElement('link')
    link.rel = 'icon'
    link.type = 'image/png'
    if (src.size) link.sizes.value = `${src.size}x${src.size}`
    link.href = src.href
    document.head.appendChild(link)
  }
}

/** What the file picker offers: the formats a browser decodes into an <img>,
 *  .ico included (few people have one; everyone has a PNG). */
export const TAB_ICON_ACCEPT = '.png,.ico,.svg,.webp,.jpg,.jpeg,image/png,image/x-icon,image/svg+xml,image/webp,image/jpeg'

/** Ask for a picture with the browser's own file picker. Resolves null when
 *  the reader closes it without choosing — not an error, nothing changes. */
export function pickTabIconFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = TAB_ICON_ACCEPT
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}

/** Turn a picked file into the stored picture: decoded through an <img> (the
 *  one decoder that takes .ico and .svg too), checked, and drawn down to
 *  TAB_ICON_STORE_PX as a PNG data URL — halving step by step, since a single
 *  large-ratio drawImage samples too few source pixels and comes out jagged. */
export async function readTabIconFile(
  file: File
): Promise<{ ok: true; image: string } | { ok: false; code: TabIconErrorCode }> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.src = url
    try {
      await img.decode()
    } catch {
      return { ok: false, code: 'tab-icon-bad-file' }
    }
    const problem = tabIconSizeProblem(img.naturalWidth, img.naturalHeight)
    if (problem) return { ok: false, code: problem }
    let source: CanvasImageSource = img
    let size = img.naturalWidth || TAB_ICON_STORE_PX
    while (size / 2 >= TAB_ICON_STORE_PX) {
      size = Math.round(size / 2)
      source = drawAt(source, size)
    }
    const target = Math.min(size, TAB_ICON_STORE_PX)
    return { ok: true, image: drawAt(source, target).toDataURL('image/png') }
  } finally {
    URL.revokeObjectURL(url)
  }
}

function drawAt(source: CanvasImageSource, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, 0, 0, size, size)
  }
  return canvas
}
