# Implementeringsplan — tilbakemeldingsbatch 2026-07-12

> Status: agenter kjører på spor A–E; quick wins (spor Q) implementeres direkte.
> Rekkefølgen under er avhengighetsstyrt: bugfiks og API-fakta først, så UX-byggene.

## Spor Q — quick wins (gjøres direkte, denne økta)

| # | Hva | Merknad |
|---|-----|---------|
| Q1 | Konsekvent **PDF Scholar**-navn | `productName` i package.json + electron-builder (exe, installer, snarvei). AppId beholdes (`no.emil.pdfx`) så oppgraderinger gjenkjennes. **userData-migrering**: state flyttes fra `%APPDATA%/pdfx` første gang. |
| Q2 | **Push til personlig GitHub** | Privat repo `pdf-scholar` via gh CLI; kan gjøres offentlig senere. |
| Q3 | **Klikkbar zoom-prosent** | Klikk på tallet → input, Enter setter eksakt zoom. |
| Q4 | **Penn/tusj-cursor** | SVG-cursors med spiss i riktig punkt, i stedet for crosshair. |
| Q5 | **Hex-felt i fargerader** | Lite #-felt ved «+» i alle fargerader; Enter bruker fargen og lagrer som sist brukt. |
| Q6 | **Zotero-notat** | Tankeboksen i ROADMAP. |

## Spor A — bugjakt (agent)
1. **Freetext flytter seg ved klikk-ut** — rotårsak + minimal fix.
2. **Kildechips døde med gpt-5.1** — parseQuoteContract/quote-matching robustgjøres (typografiske anførselstegn, whitespace-normalisering, soft hyphens).

## Spor B — modeller og tenkeinnsats (agent → deretter implementasjon)
- Anthropic: Opus 4.8, Sonnet, Haiku, **Fable 5** (alltid-på-tenking + server-side fallback) med verifiserte ID-er.
- OpenAI: gpt-5.6-familien **Luna/Terra/Sol** med verifiserte ID-er + reasoning-parametre.
- Innstillinger får kuratert modelliste per leverandør + «Tenkeinnsats» (Av/Lav/Middels/Høy) mappet riktig per API.
- Deretter: **samtalehistorikk** (tråder lagres i state, liste i panelet, auto-navngiving) og **scroll uten jank** (pin-to-bottom kun når man er nederst, «hopp ned»-knapp ellers — design fra spor C).

## Spor C — UX-arkitektur (agent → diskuteres kort → implementeres)
1. **Selektering + flytting av annoteringer** (freetext/notat/former/penn): klikk-for-å-selektere med ramme, drag flytter, Delete sletter, farge via popover. Anbefaling om «drag utenfor tekst = gummistrikk-selektering» vs. dedikert verktøy kommer fra agenten — avklares med Emil før bygging hvis anbefalingen er kontroversiell.
2. **Auto-skjult fanelinje** — overlay ved hover i toppmarg (aldri layout-skift; lærdom fra peek-oscillasjonen).
3. **Chat-scroll pinning**.
4. **Nettsøk i sidepanel** (Bing-sidebar-aktig, WebContentsView) — trigges fra kontekstmenyen.
5. **KI-semantisk søk** i søkefeltet («ta meg dit X omtales»): LLM-oppslag med ordrette sitater → hopp-liste. Ingen RAG for enkeltdokumenter; kryssdokument senere.

## Spor D — prompt-revisjon (agent → implementeres rett inn)
- Ny systemprompt: **korte svar som default** (sidepanel-kontekst), be-om-mer-mønster.
- Tydeligere Forklar/Forenkle/Definer (+ tooltips).
- **Referanseoppslag**: markér en sitering → hvorfor siteres den her + mikrooppsummering av verket, med eksplisitt epistemisk merking (i dokumentet / fra modellkunnskap / ukjent). Kontekstmeny-inngang «Slå opp referanse».

## Spor E — «ancient scroll»-estetikk (agent → Emil velger)
- Pergament-varianter av temavariablene + tre scroll-baserte ikonkonsepter (SVG). Emil velger retning før noe endres.

## Rekkefølge etter agentretur
1. A-fiksene (bugs) → 2. D (prompter, raskt) → 3. B (modeller/innstillinger, historikk, scroll-pin) → 4. C1 selektering → 5. C5 KI-søk → 6. C2 fanelinje → 7. C4 nettsøk-panel → 8. E når Emil har valgt.
Rotasjon + tosiders visning (forrige batch) ligger fortsatt i ROADMAP og tas mellom 3 og 4.
