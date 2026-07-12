// Tiny hand-rolled i18n: flat key → string dictionaries for bokmål and
// English, a module-level store, and a hook so components re-render on
// language change (several components are memoized — prop cascades are not
// enough). Non-React modules (exports, prompts) call t() at use time.
import { useSyncExternalStore } from 'react'

export type Lang = 'nb' | 'en'
/** User's choice — 'auto' follows the OS/browser language */
export type LanguagePreference = Lang | 'auto'

const nb = {
  // Generic
  'app.cancel': 'Avbryt',
  'app.save': 'Lagre',
  'app.close': 'Lukk',
  'app.delete': 'Slett',
  'app.back': 'Tilbake',
  'app.pageAbbrev': 's.',

  // Welcome
  'welcome.tagline': 'For deg som leser, forstår og arbeider med teksten.',
  'welcome.openPdf': 'Åpne PDF …',
  'welcome.openSample': 'Åpne eksempeldokument',
  'welcome.dragHint': '… eller dra og slipp en PDF hvor som helst i vinduet',
  'welcome.recents': 'Nylig lest',

  // Tabs
  'tabs.close': 'Lukk fane',
  'tabs.new': 'Åpne PDF (Ctrl+O)',

  // Toolbar
  'tb.library': 'Bibliotek',
  'tb.libraryTip': 'Tilbake til biblioteket',
  'tb.sidebarTip': 'Sidepanel (miniatyrer og innhold)',
  'tb.navBackTip': 'Tilbake (Alt+←)',
  'tb.navForwardTip': 'Frem (Alt+→)',
  'tb.penTip': 'Penn (klikk igjen for valg, Esc avslutter)',
  'tb.markerTip': 'Tusj (klikk igjen for valg, Esc avslutter)',
  'tb.eraserTip': 'Viskelær — sletter pennestrøk (Esc avslutter)',
  'tb.shapesTip': 'Former: rektangel, ellipse, linje, pil',
  'tb.textTip': 'Tekst på siden — klikk der teksten skal stå (Esc avslutter)',
  'tb.pen': 'Penn',
  'tb.marker': 'Tusj',
  'tb.shapes': 'Former',
  'tb.width': 'Bredde',
  'tb.strokeWidth': 'Strekbredde',
  'tb.toolOptionsTip': 'Farge og bredde',
  'tb.printTip': 'Skriv ut',
  'tb.readAloudTip': 'Høytlesing',
  'tb.goToPage': 'Gå til side',
  'tb.zoomOutTip': 'Zoom ut (Ctrl+-)',
  'tb.zoomInTip': 'Zoom inn (Ctrl++)',
  'tb.fitWidthTip': 'Tilpass bredde (Ctrl+0)',
  'tb.fitPageTip': 'Tilpass hel side',
  'tb.zoomExactTip': 'Skriv inn nøyaktig zoom',
  'tb.searchTip': 'Søk i dokumentet (Ctrl+F)',
  'tb.aiTip': 'Assistent — spør om dokumentet',
  'tb.viewTip': 'Visningsinnstillinger',
  'tb.readingMode': 'Lesemodus',
  'tb.themeDay': 'Dag',
  'tb.themeSepia': 'Sepia',
  'tb.themeNight': 'Natt',
  'tb.themeAuto': 'Auto',
  'tb.contrast': 'Kontrast',
  'tb.brightness': 'Lysstyrke',
  'tb.reset': 'Nullstill',
  'tb.keepAwake': 'Hold skjermen våken',
  'tb.language': 'Språk',
  'tb.langAuto': 'Auto',
  'tb.distractionTip': 'Distraksjonsfri lesing (Esc avslutter)',
  'tb.fullscreenTip': 'Fullskjerm (F11)',

  // Shapes
  'shape.square': 'Rektangel',
  'shape.circle': 'Ellipse',
  'shape.line': 'Linje',
  'shape.arrow': 'Pil',

  // Colors
  'color.yellow': 'Gul',
  'color.green': 'Grønn',
  'color.blue': 'Blå',
  'color.pink': 'Rosa',
  'color.purple': 'Lilla',
  'color.red': 'Rød',
  'color.orange': 'Oransje',

  // Annotation types
  'annot.highlight': 'Markering',
  'annot.underline': 'Understreking',
  'annot.strikeout': 'Gjennomstreking',
  'annot.squiggly': 'Bølgestrek',
  'annot.note': 'Notat',
  'annot.ink': 'Penn',
  'annot.square': 'Rektangel',
  'annot.circle': 'Ellipse',
  'annot.line': 'Linje',
  'annot.arrow': 'Pil',
  'annot.freetext': 'Tekst',

  // Selection menu
  'menu.marker': 'Marker',
  'menu.markerTip': 'Marker ({color})',
  'menu.underline': 'Understrek',
  'menu.underlineTip': 'Understrek ({color})',
  'menu.strikeout': 'Gjennomstrek',
  'menu.strikeoutTip': 'Gjennomstrek ({color})',
  'menu.squiggly': 'Bølgestrek',
  'menu.squigglyTip': 'Bølgestrek ({color})',
  'menu.customColor': 'Velg farge …',
  'menu.aiSection': 'Assistent',
  'menu.note': 'Notat',
  'menu.copy': 'Kopier',
  'menu.aiExplain': 'Forklar',
  'menu.aiSimplify': 'Forenkle',
  'menu.aiDefine': 'Definer i kontekst',
  'menu.webSearch': 'Søk på nettet',
  'menu.dictionary': 'Slå opp i ordbok',
  'menu.translate': 'Oversett',
  'menu.newNoteHere': 'Nytt notat her',
  'menu.notePlaceholder': 'Skriv et notat …',

  // Annotation popover
  'popover.notePlaceholder': 'Notattekst …',
  'popover.commentPlaceholder': 'Legg til kommentar …',
  'popover.colorTip': '{color}',

  // Sidebar
  'side.pages': 'Sider',
  'side.contents': 'Innhold',
  'side.annots': 'Merknader',
  'side.loading': 'Laster …',
  'side.noOutline': 'Dokumentet har ingen innholdsfortegnelse.',
  'side.noAnnots': 'Ingen merknader i dokumentet ennå.',
  'side.export': 'Eksporter',
  'side.exportMdTip': 'Eksporter sammendrag som Markdown',
  'side.exportHtmlTip': 'Eksporter sammendrag som HTML',
  'side.exportTxtTip': 'Eksporter sammendrag som ren tekst',
  'side.searchAnnots': 'Søk i merknader …',
  'side.showOnly': 'Vis kun {color}',
  'side.noMatches': 'Ingen treff i merknadene.',
  'side.page': 'Side {page}',
  'side.deleteAnnot': 'Slett merknad',
  'side.collapse': 'Lukk',
  'side.expand': 'Åpne',

  // Search
  'search.placeholder': 'Søk i dokumentet …',
  'search.searching': 'Søker …',
  'search.noMatches': 'Ingen treff',
  'search.count': '{index} av {count}',
  'search.prevTip': 'Forrige (Shift+Enter)',
  'search.nextTip': 'Neste (Enter)',
  'search.matchCaseTip': 'Skill mellom store og små bokstaver',
  'search.wholeWordsTip': 'Bare hele ord',
  'search.closeTip': 'Lukk (Esc)',

  // Viewer
  'viewer.errorTitle': 'Kunne ikke vise dokumentet.',
  'viewer.opening': 'Åpner {name} …',
  'viewer.backToPage': '‹ Tilbake til s. {page}',
  'viewer.forwardToPage': 'Frem til s. {page} ›',
  'viewer.ofPages': 'av {count}',
  'viewer.annotSaveFailed': 'Kunne ikke lagre annotasjonen: {error}',
  'viewer.annotDeleteFailed': 'Kunne ikke slette annotasjonen: {error}',
  'viewer.annotStillSaving': 'Annotasjonen lagres fortsatt — prøv igjen straks',
  'viewer.annotChangeFailed': 'Kunne ikke endre annotasjonen: {error}',
  'viewer.distractionToast': 'Distraksjonsfri lesing — trykk Esc for å vise verktøylinjen',
  'viewer.fullscreenToast': 'Fullskjerm — trykk Esc eller F11 for å avslutte',
  'viewer.nothingToExport': 'Ingen merknader å eksportere',
  'viewer.saveFailed': 'Kunne ikke lagre: {error}',
  'viewer.exported': 'Merknader eksportert: {path}',
  'viewer.printFailed': 'Kunne ikke skrive ut: {error}',

  // Read aloud
  'ra.playPause': 'Spill av / pause',
  'ra.stop': 'Stopp høytlesing',
  'ra.rate': 'Hastighet',
  'ra.voice': 'Stemme',

  // Export documents
  'export.title': 'Merknader — {name}',
  'export.byline': 'Eksportert {date} fra PDF Scholar',
  'export.page': 'Side {page}',
  'export.suffix': 'merknader',

  // AI panel
  'ai.assistant': 'Assistent',
  'ai.settingsTip': 'KI-innstillinger',
  'ai.closeTip': 'Lukk (Esc)',
  'ai.emptyIntro':
    'Still spørsmål om dokumentet. Svarene får kildehenvisninger du kan klikke på for å hoppe til riktig sted.',
  'ai.suggestion1': 'Oppsummer dokumentet kort',
  'ai.suggestion2': 'Hva er forskningsspørsmålet og hovedfunnene?',
  'ai.suggestion3': 'Forklar metoden enkelt',
  'ai.readingDoc': 'Leser dokumentet …',
  'ai.thinking': 'Tenker …',
  'ai.composerPlaceholder': 'Spør om dokumentet …',
  'ai.sendTip': 'Send (Enter)',
  'ai.stopTip': 'Stopp',
  'ai.totalCost': 'Samtalen har kostet ≈ {cost}',
  'ai.sourceChip': 'kilde',
  'ai.chipTip': 'Hopp til kilden i dokumentet',
  'ai.provider': 'Leverandør',
  'ai.providerMock': 'Test uten nøkkel (mock)',
  'ai.apiKey': 'API-nøkkel',
  'ai.keySaved': '•••••••• (lagret)',
  'ai.keyNew': 'Lim inn nøkkelen din',
  'ai.model': 'Modell',
  'ai.endpoint': 'Endepunkt',
  'ai.deployment': 'Deployment',
  'ai.settingsNote':
    'Nøkkelen lagres kryptert på denne maskinen og brukes kun direkte mot leverandørens API. Dokumentteksten sendes til leverandøren først når du stiller et spørsmål.',
  'ai.encryptionWarn': ' Merk: systemkryptering er utilgjengelig her; nøkkelen lagres uten kryptering.',
  'ai.sendToChat': 'Send til chat',
  'ai.summaryBtn': 'Strukturert sammendrag',
  'ai.summaryTip': 'Strukturert artikkelsammendrag med kildehenvisninger',
  'ai.annotsBtn': 'Oppsummer merknadene mine',
  'ai.annotsTip': 'Spør assistenten om merknadene dine',
  'ai.quickExplain': 'Forklar',
  'ai.quickSimplify': 'Forenkle',
  'ai.quickDefine': 'Definer',
  'ai.quickQuestion': '{title}: «{selection}» (s. {page})',
  'ai.mockOnlyWeb': 'Nettleser-forhåndsvisningen støtter kun mock-leverandøren. Bruk appen for ekte KI.',
  'ai.aborted': 'Avbrutt'
}

export type MsgKey = keyof typeof nb
type Dict = Record<MsgKey, string>

const en: Dict = {
  'app.cancel': 'Cancel',
  'app.save': 'Save',
  'app.close': 'Close',
  'app.delete': 'Delete',
  'app.back': 'Back',
  'app.pageAbbrev': 'p.',

  'welcome.tagline': 'For those who read, understand and work with the text.',
  'welcome.openPdf': 'Open PDF …',
  'welcome.openSample': 'Open sample document',
  'welcome.dragHint': '… or drag and drop a PDF anywhere in the window',
  'welcome.recents': 'Recently read',

  'tabs.close': 'Close tab',
  'tabs.new': 'Open PDF (Ctrl+O)',

  'tb.library': 'Library',
  'tb.libraryTip': 'Back to the library',
  'tb.sidebarTip': 'Sidebar (thumbnails and contents)',
  'tb.navBackTip': 'Back (Alt+←)',
  'tb.navForwardTip': 'Forward (Alt+→)',
  'tb.penTip': 'Pen (click again for options, Esc to finish)',
  'tb.markerTip': 'Highlighter pen (click again for options, Esc to finish)',
  'tb.eraserTip': 'Eraser — removes pen strokes (Esc to finish)',
  'tb.shapesTip': 'Shapes: rectangle, ellipse, line, arrow',
  'tb.textTip': 'Text on the page — click where the text should go (Esc to finish)',
  'tb.pen': 'Pen',
  'tb.marker': 'Highlighter',
  'tb.shapes': 'Shapes',
  'tb.width': 'Width',
  'tb.strokeWidth': 'Stroke width',
  'tb.toolOptionsTip': 'Color and width',
  'tb.printTip': 'Print',
  'tb.readAloudTip': 'Read aloud',
  'tb.goToPage': 'Go to page',
  'tb.zoomOutTip': 'Zoom out (Ctrl+-)',
  'tb.zoomInTip': 'Zoom in (Ctrl++)',
  'tb.fitWidthTip': 'Fit width (Ctrl+0)',
  'tb.fitPageTip': 'Fit whole page',
  'tb.zoomExactTip': 'Enter exact zoom',
  'tb.searchTip': 'Search the document (Ctrl+F)',
  'tb.aiTip': 'Assistant — ask about the document',
  'tb.viewTip': 'View settings',
  'tb.readingMode': 'Reading mode',
  'tb.themeDay': 'Day',
  'tb.themeSepia': 'Sepia',
  'tb.themeNight': 'Night',
  'tb.themeAuto': 'Auto',
  'tb.contrast': 'Contrast',
  'tb.brightness': 'Brightness',
  'tb.reset': 'Reset',
  'tb.keepAwake': 'Keep the screen awake',
  'tb.language': 'Language',
  'tb.langAuto': 'Auto',
  'tb.distractionTip': 'Distraction-free reading (Esc to exit)',
  'tb.fullscreenTip': 'Full screen (F11)',

  'shape.square': 'Rectangle',
  'shape.circle': 'Ellipse',
  'shape.line': 'Line',
  'shape.arrow': 'Arrow',

  'color.yellow': 'Yellow',
  'color.green': 'Green',
  'color.blue': 'Blue',
  'color.pink': 'Pink',
  'color.purple': 'Purple',
  'color.red': 'Red',
  'color.orange': 'Orange',

  'annot.highlight': 'Highlight',
  'annot.underline': 'Underline',
  'annot.strikeout': 'Strikethrough',
  'annot.squiggly': 'Squiggly underline',
  'annot.note': 'Note',
  'annot.ink': 'Pen',
  'annot.square': 'Rectangle',
  'annot.circle': 'Ellipse',
  'annot.line': 'Line',
  'annot.arrow': 'Arrow',
  'annot.freetext': 'Text',

  'menu.marker': 'Highlight',
  'menu.markerTip': 'Highlight ({color})',
  'menu.underline': 'Underline',
  'menu.underlineTip': 'Underline ({color})',
  'menu.strikeout': 'Strike through',
  'menu.strikeoutTip': 'Strike through ({color})',
  'menu.squiggly': 'Squiggly underline',
  'menu.squigglyTip': 'Squiggly underline ({color})',
  'menu.customColor': 'Pick a color …',
  'menu.aiSection': 'Assistant',
  'menu.note': 'Note',
  'menu.copy': 'Copy',
  'menu.aiExplain': 'Explain',
  'menu.aiSimplify': 'Simplify',
  'menu.aiDefine': 'Define in context',
  'menu.webSearch': 'Search the web',
  'menu.dictionary': 'Look up in dictionary',
  'menu.translate': 'Translate',
  'menu.newNoteHere': 'New note here',
  'menu.notePlaceholder': 'Write a note …',

  'popover.notePlaceholder': 'Note text …',
  'popover.commentPlaceholder': 'Add a comment …',
  'popover.colorTip': '{color}',

  'side.pages': 'Pages',
  'side.contents': 'Contents',
  'side.annots': 'Annotations',
  'side.loading': 'Loading …',
  'side.noOutline': 'The document has no table of contents.',
  'side.noAnnots': 'No annotations in the document yet.',
  'side.export': 'Export',
  'side.exportMdTip': 'Export summary as Markdown',
  'side.exportHtmlTip': 'Export summary as HTML',
  'side.exportTxtTip': 'Export summary as plain text',
  'side.searchAnnots': 'Search annotations …',
  'side.showOnly': 'Show only {color}',
  'side.noMatches': 'No matches in the annotations.',
  'side.page': 'Page {page}',
  'side.deleteAnnot': 'Delete annotation',
  'side.collapse': 'Collapse',
  'side.expand': 'Expand',

  'search.placeholder': 'Search the document …',
  'search.searching': 'Searching …',
  'search.noMatches': 'No matches',
  'search.count': '{index} of {count}',
  'search.prevTip': 'Previous (Shift+Enter)',
  'search.nextTip': 'Next (Enter)',
  'search.matchCaseTip': 'Match case',
  'search.wholeWordsTip': 'Whole words only',
  'search.closeTip': 'Close (Esc)',

  'viewer.errorTitle': 'Could not display the document.',
  'viewer.opening': 'Opening {name} …',
  'viewer.backToPage': '‹ Back to p. {page}',
  'viewer.forwardToPage': 'Forward to p. {page} ›',
  'viewer.ofPages': 'of {count}',
  'viewer.annotSaveFailed': 'Could not save the annotation: {error}',
  'viewer.annotDeleteFailed': 'Could not delete the annotation: {error}',
  'viewer.annotStillSaving': 'The annotation is still saving — try again in a moment',
  'viewer.annotChangeFailed': 'Could not change the annotation: {error}',
  'viewer.distractionToast': 'Distraction-free reading — press Esc to show the toolbar',
  'viewer.fullscreenToast': 'Full screen — press Esc or F11 to exit',
  'viewer.nothingToExport': 'No annotations to export',
  'viewer.saveFailed': 'Could not save: {error}',
  'viewer.exported': 'Annotations exported: {path}',
  'viewer.printFailed': 'Could not print: {error}',

  'ra.playPause': 'Play / pause',
  'ra.stop': 'Stop reading aloud',
  'ra.rate': 'Speed',
  'ra.voice': 'Voice',

  'export.title': 'Annotations — {name}',
  'export.byline': 'Exported {date} from PDF Scholar',
  'export.page': 'Page {page}',
  'export.suffix': 'annotations',

  'ai.assistant': 'Assistant',
  'ai.settingsTip': 'AI settings',
  'ai.closeTip': 'Close (Esc)',
  'ai.emptyIntro':
    'Ask questions about the document. Answers come with source references you can click to jump to the right place.',
  'ai.suggestion1': 'Summarize the document briefly',
  'ai.suggestion2': 'What is the research question and the main findings?',
  'ai.suggestion3': 'Explain the method simply',
  'ai.readingDoc': 'Reading the document …',
  'ai.thinking': 'Thinking …',
  'ai.composerPlaceholder': 'Ask about the document …',
  'ai.sendTip': 'Send (Enter)',
  'ai.stopTip': 'Stop',
  'ai.totalCost': 'This conversation has cost ≈ {cost}',
  'ai.sourceChip': 'source',
  'ai.chipTip': 'Jump to the source in the document',
  'ai.provider': 'Provider',
  'ai.providerMock': 'Test without a key (mock)',
  'ai.apiKey': 'API key',
  'ai.keySaved': '•••••••• (saved)',
  'ai.keyNew': 'Paste your key',
  'ai.model': 'Model',
  'ai.endpoint': 'Endpoint',
  'ai.deployment': 'Deployment',
  'ai.settingsNote':
    'The key is stored encrypted on this machine and used only directly against the provider’s API. The document text is sent to the provider only when you ask a question.',
  'ai.encryptionWarn': ' Note: system encryption is unavailable here; the key is stored unencrypted.',
  'ai.sendToChat': 'Send to chat',
  'ai.summaryBtn': 'Structured summary',
  'ai.summaryTip': 'Structured article summary with source references',
  'ai.annotsBtn': 'Summarize my annotations',
  'ai.annotsTip': 'Ask the assistant about your annotations',
  'ai.quickExplain': 'Explain',
  'ai.quickSimplify': 'Simplify',
  'ai.quickDefine': 'Define',
  'ai.quickQuestion': '{title}: «{selection}» (p. {page})',
  'ai.mockOnlyWeb': 'The browser preview only supports the mock provider. Use the app for real AI.',
  'ai.aborted': 'Stopped'
}

const DICTIONARIES: Record<Lang, Dict> = { nb, en }

export function resolveLanguage(pref: LanguagePreference): Lang {
  if (pref !== 'auto') return pref
  const sys = (navigator.language || 'en').toLowerCase()
  return sys.startsWith('nb') || sys.startsWith('nn') || sys.startsWith('no') ? 'nb' : 'en'
}

let current: Lang = 'nb'
const listeners = new Set<() => void>()

export function setLanguage(pref: LanguagePreference): void {
  const next = resolveLanguage(pref)
  if (next === current) return
  current = next
  for (const cb of listeners) cb()
}

export function getLanguage(): Lang {
  return current
}

/** Subscribe a component to language changes (needed because several
 *  components are memoized and won't re-render via prop cascades). */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current
  )
}

export function t(key: MsgKey, vars?: Record<string, string | number>): string {
  let out = DICTIONARIES[current][key]
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.replaceAll(`{${name}}`, String(value))
    }
  }
  return out
}

/** Locale for date formatting etc. */
export function locale(): string {
  return current === 'nb' ? 'nb-NO' : 'en-GB'
}
