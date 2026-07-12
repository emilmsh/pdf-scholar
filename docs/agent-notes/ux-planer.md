# UX-arkitektplaner (agentlevert 2026-07-12) — besluttet grunnlag for implementasjon

## 1. Selektering + flytting av annoteringer
- **Anbefaling: klikk-for-å-selektere med ramme; drag flytter (generalisert noteDrag). INGEN gummistrikk på default-flaten** — tekstlaget dekker hele siden og brukere starter tekstseleksjon i marger; heuristikken ville blitt janky. Ev. senere: dedikert `DrawToolType:'select'`-verktøy (marquee via draw-layer, konfliktfritt). Ikke bygg før behov.
- Nøkkel: **kant-basert hit-test** (`annotationHitTest` i annotations.ts): square/circle treffes kun nær omrisset (±width/2+3pt), line/arrow via pointToSegmentDistance, ink via inkHitTest, note/freetext bbox; tekst-markup selekterbar men IKKE flyttbar.
- State: `selectedAnnot {pageNumber, localId}`; `annotDragRef` (rename av noteDragRef) med mode 'rect'|'strokes'; 3px-terskel skiller klikk (→ popover) fra drag; Delete-tast utvides til `annotPopover ?? selectedAnnot`.
- PdfPage: prop `selectedId` → seleksjonsramme (bbox + hjørnemarkører) i egen pointer-events:none-overlay (også for file-annots). Ingen resize i v1.
- Engine: note/freetext/square/circle OK via rect; **line/arrow trenger `line?: [[x,y],[x,y]]` → setLine; ink trenger `strokes` → setInkList** i ModifyAnnotationRequest/updateAnnotation. AnnotPatch utvides med strokes for undo. File-inks: selekterbare, ikke flyttbare (mangler strokes i record).

## 2. Auto-skjult fanelinje
- **Permanent overlay** (`.tab-bar-overlay`: absolute, translateY(-100%) skjult, z-index 31 over toolbar-wrap 30) — ALDRI i layoutflyten (peek-oscillasjonslærdommen).
- App eier `tabPeek` + `.top-strip` (6px, alltid når tabs>0). Strip-hover → vis; leave fra baren med ~250ms delay → skjul.
- Distraksjonsfri: viewerens `.reveal-zone`/`peek` erstattes av felles `topPeek`-prop fra App; toolbar peeker på konstant top:44px under fanelinja. Én felles trigger = ingen utakt.
- TabBar-komponenten gjenbrukes; `hidden`-prop + max-height-kollaps-CSS fjernes.

## 3. Chat-scroll pinning (AiPanel)
- `pinnedRef` oppdateres i onScroll: `scrollHeight - scrollTop - clientHeight < 48`. Autoscroll-effekt (bytt til useLayoutEffect) kun når pinned. send() tvinger pin. «Hopp til bunn»-knapp (`.ai-jump-bottom`) når !pinned && busy. Instant scroll under streaming, smooth kun for knappen.

## 4. Nettsøk i sidepanel
- **WebContentsView i main** (webview-tag frarådet, BrowserView deprecated). Ny modul src/main/web-search.ts; én lazy view; addChildView/removeChildView; bounds synkes fra renderer via ResizeObserver → `webSearch.setBounds`.
- Sikkerhet: egen `persist:websearch`-partition, sandbox, ingen preload/node; permission-handler avslår alt; will-download kanselleres; windowOpenHandler → naviger samme view (kun http/s). Default søkemotor DuckDuckGo.
- PdfxApi: `webSearch.open(query)/close()/setBounds(r)/navigate(back|forward|reload)/openCurrentExternal()` + `onWebSearchState(cb)`.
- Renderer: WebSearchPanel.tsx (~380px, header med nav/tittel/åpne-eksternt/✕ + tom body som view'en dekker). Gjensidig utelukkende med AiPanel. Kontekstmenyens «Søk på nettet» → panelet (ekstern nettleser via header-knapp).
- Caveats: view'en ligger over ALT i sitt rektangel — flytt .search-bar når panelet er åpent; lukk panelet i distraksjonsfri; skjul view ved inaktiv fane.

## 5. KI-semantisk søk i SearchBar
- **Gjenbruk ai:chat-pipelinen — ingen ny IPC.** Kritisk cache-detalj: bruk SAMME system (chatSystem()) som chatten og legg søkeinstruksen i brukermeldingen → deler prompt-cache med chatten.
- SearchBar får modus-toggle «Ord»/«KI»; KI: Enter-trigget, spinner, kostnadshint (estimat før, faktisk etter).
- `semanticSearchPrompt(query)`: «Finn de 3–8 stedene som best omtaler X; nummerert liste, ≤15 ord per sted, siter hvert sted ordrett.» Høst `parts[].citations` → resolveCitation → {pageNumber,start,end,label}; null droppes; 0 treff = egen tomtilstand.
- Klikk → eksisterende `jumpToAiCitation`. Abort forrige ved nytt søk. Ingen embeddings i v1.

## Anbefalt rekkefølge: 3 → 2 → 1 (engine først) → 5 → 4.
