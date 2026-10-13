// What a link annotation can be copied as. The point menu (right-click over a
// link) offers «Kopier e-postadresse» for a mailto: link and «Kopier
// lenkeadresse» for a web address — the page shows the link's TEXT, which is
// often not what the link points at (a «click here» over a URL, an address
// split across two lines), so the target is read from the annotation itself.

export interface CopyableLink {
  kind: 'email' | 'web'
  /** What goes on the clipboard: the bare address for a mailto: link, the URL
   *  as the file wrote it for a web link */
  text: string
}

/** The recipients of a mailto: URL — «mailto:a@b.no?subject=Hi» is just
 *  «a@b.no». A broken percent escape keeps the raw text rather than failing:
 *  something copyable beats nothing. */
function mailtoRecipients(url: string): string {
  const rest = url.slice('mailto:'.length)
  const end = rest.search(/[?#]/)
  const raw = end === -1 ? rest : rest.slice(0, end)
  let text = raw
  try {
    text = decodeURIComponent(raw)
  } catch {
    /* keep the raw form */
  }
  return text.trim()
}

/** null for anything the menu has no copy action for — an empty mailto:, or a
 *  scheme a reader has no use for on the clipboard (javascript:, file:, …). */
export function copyableLink(url: string | undefined | null): CopyableLink | null {
  const u = (url ?? '').trim()
  if (!u) return null
  if (/^mailto:/i.test(u)) {
    const text = mailtoRecipients(u)
    return text ? { kind: 'email', text } : null
  }
  if (/^https?:\/\//i.test(u)) return { kind: 'web', text: u }
  return null
}
