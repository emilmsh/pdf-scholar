// The one drag payload that crosses component boundaries inside a window.
//
// A tab dragged out of the strip carries its document path under this MIME
// type; a pages column that sees it offers «Åpne i delt visning» and opens the
// document beside the one it shows. The type is private on purpose: `text/plain`
// is set too (some platforms cancel a drag with no data), but text/plain is also
// what a URL or a stray sentence dragged in from a browser looks like, and a
// column must never try to open THAT as a file.
export const TAB_DRAG_MIME = 'application/x-pdf-scholar-tab'

/** Does this drag carry a tab? Cheap enough to run on every dragover. */
export function dragCarriesTab(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes(TAB_DRAG_MIME)
}

/** Does this drag carry OS files? */
export function dragCarriesFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes('Files')
}
