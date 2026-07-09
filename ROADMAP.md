# PDFX — Veikart

Mål: en så tro kopi av PDF Expert (Readdle) som mulig, for Windows. Hver fase skal gi en brukbar app. Detaljert funksjonsspesifikasjon: [docs/SPEC.md](docs/SPEC.md).

**Arkitektur (besluttet 2026-07-09):** Electron + electron-vite + React + TypeScript. pdf.js (pdfjs-dist v6) er **lesemotoren** (rendering, tekstlag, søk, TOC). mupdf (offisiell WASM, npm) blir **annoteringsmotoren** (skriver standard PDF-annotasjoner med appearance streams, inkrementell lagring) bak et typet `AnnotationEngine`-grensesnitt i hovedprosessen. Annotasjoner tegnes av vårt eget React-overlegg — vi bruker ikke pdf.js sitt redigeringslag (det mangler underline/strikeout/notater og har kjente feil). Dette er samme arkitektur som Zotero/Okular. Merk: mupdf er AGPL — uproblematisk for personlig bruk; beslutning om ev. distribusjon tas ved fase 8 (åpen kildekode, kommersiell lisens, eller bytte til EmbedPDF/PDFium bak grensesnittet).

## Fase 1 — Skjelett + minimal leser ✅ (påbegynt 2026-07-09, kjernen ferdig)
- [x] Electron + React + TS-oppsett med typesjekk og produksjonsbygg
- [x] pdf.js-rendering med virtualisert kontinuerlig rulling, tekstlag (markering), zoom (Ctrl+hjul/pinch, tilpass bredde)
- [x] Husker siste leseposisjon + zoom per fil; nylige filer; tema lagres
- [x] Åpning via kommandolinje/«Åpne med» (argv), single-instance med `second-instance`-ruting
- [x] Vindusstørrelse/-posisjon huskes; dra-og-slipp av PDF
- [x] Lesemodus: Dag/Sepia/Natt + distraksjonsfri modus (verktøylinjen skjules, vises ved å peke mot toppen, Esc avslutter)
- [x] Myk zoom: pinch/Ctrl+hjul som CSS-transform under gesten, skarp gjentegning ved ro, fokuspunkt bevares; canvas-bytte uten hvit blink; horisontal panorering ved zoom (levert 2026-07-09)
- [x] Fullskjerm via F11/knapp/Esc (levert 2026-07-09)
- [ ] electron-builder NSIS-installer med `fileAssociations` for .pdf (per-bruker, uten admin)
- [ ] Jump List («Recent»-kategori) i oppgavelinjen

## Fase 2 — Leseopplevelse + temaer (Emils prioritet nr. 1)
- Justerbar **kontrast** (og lysstyrke) per lesemodus; Auto-tema som følger Windows
- «aA»-panel: rulleretning (vertikal kontinuerlig / horisontal én-side), to-siders oppslag, beskjær marger, hold skjermen våken
- Distraksjonsfri: klikk midt på siden skjuler/viser alt; flytende sidetall-pille nede til høyre (klikk = gå til side)
- Venstre sidepanel med Miniatyrer + Innholdsfortegnelse (TOC); klikk for å hoppe

## Fase 3 — Navigasjonsdybde + søk
- Navigasjonshistorikk: «Tilbake til s. N»-pille etter alle hopp (lenker, TOC, søk, gå-til-side); full tilbake-stakk
- Søkelinje: skill store/små bokstaver, hele ord, marker alle, resultatliste, søkehistorikk
- Bokmerker-fane
- ~~Kontekstmeny ved tekstmarkering v1: Kopier, Nettsøk, Ordbok, Oversett~~ ✅ levert 2026-07-09 (høyreklikk eller meny som spretter opp ved markering) utvalg

## Fase 4 — Annoteringsfundament (Emils prioritet nr. 2)
Grunnmuren ble levert 2026-07-09: mupdf `AnnotationEngine` i hovedprosessen bak typet IPC skriver Highlight (5 farger)/Underline/StrikeOut/notater som standard PDF-annotasjoner med appearance streams, inkrementell lagring og atomisk filbytte (rundtur verifisert med mupdf-gjenåpning); overlegg tegner dem umiddelbart. Gjenstår:
- Eksisterende annotasjoner leses inn ved åpning og tegnes i overlegget (nå vises de via pdf.js-rendering)
- Squiggly; «armert verktøy»-flyt (verktøy stays on for gjentatt bruk)
- 5-felts fargepaletter per verktøy + egendefinert velger, opasitet; klikk på eksisterende annotasjon → egenskaper/slett (også annotasjoner fra andre apper)
- **Interop-port**: åpne PDFX-annoterte filer i Acrobat/SumatraPDF/PDF Expert (iPad) og verifiser identisk visning

## Fase 5 — Fullt annoteringsverktøysett
- Penn (fast bredde + trykkfølsom via Pointer Events), markeringstusj, viskelær, lasso-multivalg for blekk
- Popup-notater, fritekst, former (rektangel/ellipse/linje/pil)
- Angre/gjør om som inverterbare motor-operasjoner; hurtigtaster
- Verktøysett-system i verktøylinjen

## Fase 6 — Annotasjonspanel + eksport (Emils prioritet nr. 3)
- Annotasjoner-fane: liste gruppert per side med faktisk markert tekst + notatinnhold; klikk for å hoppe
- Søk i annotasjoner + fargefilter; slett enkeltvis; tøm alle
- **Eksporter annotasjonssammendrag** som HTML, tekst og Markdown
- «Annoterte sider»: ny PDF med kun sider som har annotasjoner

## Fase 7 — Skall-paritet og polering
- Fanelinje for flere dokumenter; delt visning
- Stempler, signatur, verktøylinje-tilpasning
- Designgjennomgang mot PDF Expert: avstander, ikoner, animasjoner, mørkt app-chrome

## Fase 8 — Filhåndtering + sky (Emils prioritet nr. 4)
- Hjemskjerm: Nylige (20) + Favoritter med egendefinert rekkefølge og fargeetiketter
- Innholdssøk på tvers av filer i valgt mappe
- Sky: primært via synkmapper (OneDrive/Dropbox) + filovervåking; API-integrasjon bare hvis nødvendig
- **Beslutningsport for distribusjon**: mupdf AGPL-avklaring, kodesignering, auto-oppdatering

## Viktigste risikoer (med tiltak)
1. **Koordinat-mapping** pdf.js-viewport ↔ PDF-sideflate (y-flipp, rotasjon, cropbox) — én delt, enhetstestet transformmodul; la mupdf beregne quads selv.
2. **Utseende på tvers av visere** — interop-testmatrise som fasekrav for hver annotasjonstype.
3. **To parsere** (pdf.js leser, mupdf skriver) kan divergere — overlegget eier annotasjonspiksler, pdf.js lastes aldri på nytt etter lagring; test tidlig med 1000+ siders dokumenter.
4. **Inkrementell lagring-kanttilfeller** — sjekk `canBeSavedIncrementally()`, fall tilbake til full lagring; alltid temp-fil + atomisk rename.
5. **pdf.js API-endringer** (månedlige major-versjoner) — pin eksakt versjon, all pdf.js-bruk bak egen modul.
6. **Windows-integrasjon**: `second-instance`-argv får Chromium-brytere injisert — defensiv parser; single-instance-lås feiler når første instans kjører forhøyet (kjent Electron-bug).
7. **Omfang vs. én utvikler** — strengt «brukbar app per fase»; AI/OCR/reflow/skjemaer eksplisitt utenfor omfang.
