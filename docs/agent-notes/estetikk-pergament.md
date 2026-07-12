# «Ancient scroll»-estetikk (agentlevert 2026-07-12) — VENTER PÅ EMILS VALG

Anbefaling: Gandalf-følelsen i TEMAET, ikke logoen. Innfør Pergament-tema + dobbeltlinje-detalj.
Av ikonene bevarer (b) «rull + gul markering» merkevaren best (samme blå bakgrunn/komposisjon som i dag).
Night røres ikke. Ingen pergament-tekstur/serif i brødtekst — det bryter PDF Expert-roen.

## Pergament (erstatter sepia-verdiene i app.css)

```css
:root[data-theme='sepia'] {
  --bg-chrome: #efe3cc;
  --bg-canvas: #e3d5b8;
  --bg-elevated: #f9f1dd;
  --border: rgba(88, 62, 30, 0.18);
  --text: #3f3323;
  --text-secondary: #85714f;
  --accent: #96601f;
  --accent-text: #fffaf0;
  --hover: rgba(88, 62, 30, 0.08);
  --active: rgba(88, 62, 30, 0.15);
  --page-bg: #f5ecd6;
  --page-filter: sepia(0.5) brightness(0.985) contrast(0.93) saturate(1.05);
  --shadow-page: 0 1px 2px rgba(74, 52, 20, 0.18), 0 4px 16px rgba(74, 52, 20, 0.14);
  --shadow-menu: 0 8px 30px rgba(74, 52, 20, 0.22), 0 0 1px rgba(74, 52, 20, 0.32);
}
```

## Day — varme mikrojusteringer (valgfritt)
Nøytraler mot papir-grå, aksentblå uendret: --bg-chrome #f8f7f4, --bg-canvas #eceae4,
--border rgba(45,35,15,.09), --text #201d18, --text-secondary #716a5e, hover/active rgba(45,35,15,…).

## Scholarly detalj (kun sepia)

```css
:root[data-theme='sepia'] .ai-header { border-bottom: 3px double var(--border); }
:root[data-theme='sepia'] .welcome-logo {
  font-family: 'Palatino Linotype', Cambria, Georgia, serif;
  letter-spacing: 1px;
  background: linear-gradient(135deg, var(--accent), #6e4a1a);
  -webkit-background-clip: text; background-clip: text;
}
:root[data-theme='sepia'] .welcome-tagline::after {
  content: ''; display: block; width: 72px; margin: 18px auto 0;
  border-top: 3px double var(--border);
}
```

## Anbefalt ikon (b): «rull + markering» — komplett SVG (512×512)

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3a5ba8"/><stop offset="1" stop-color="#22386e"/>
    </linearGradient>
    <linearGradient id="sheet" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#faf3e0"/><stop offset="1" stop-color="#eaddba"/>
    </linearGradient>
    <linearGradient id="roll" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fdf8ea"/><stop offset="0.5" stop-color="#f1e5c4"/><stop offset="1" stop-color="#c9b586"/>
    </linearGradient>
    <filter id="scrollShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.28"/>
    </filter>
  </defs>
  <rect width="512" height="512" rx="104" fill="url(#bg)"/>
  <g filter="url(#scrollShadow)">
    <rect x="152" y="132" width="208" height="236" fill="url(#sheet)"/>
    <rect x="152" y="132" width="10" height="236" fill="#c9b586" opacity="0.35"/>
    <rect x="350" y="132" width="10" height="236" fill="#c9b586" opacity="0.35"/>
    <g fill="#b8a273">
      <rect x="184" y="192" width="144" height="12" rx="6"/>
      <rect x="184" y="222" width="144" height="12" rx="6"/>
      <rect x="184" y="288" width="144" height="12" rx="6"/>
      <rect x="184" y="318" width="104" height="12" rx="6"/>
    </g>
    <rect x="176" y="245" width="160" height="26" rx="9" fill="#ffd54a"/>
    <rect x="184" y="252" width="144" height="12" rx="6" fill="#8a7430" opacity="0.55"/>
    <rect x="152" y="342" width="208" height="10" fill="#8f7a4e" opacity="0.22"/>
    <rect x="140" y="350" width="232" height="36" rx="18" fill="url(#roll)"/>
    <circle cx="158" cy="368" r="10" fill="#e3d3a6"/><circle cx="158" cy="368" r="4" fill="#a98f5c"/>
    <circle cx="354" cy="368" r="10" fill="#e3d3a6"/><circle cx="354" cy="368" r="4" fill="#a98f5c"/>
    <rect x="152" y="146" width="208" height="10" fill="#8f7a4e" opacity="0.22"/>
    <rect x="134" y="108" width="244" height="40" rx="20" fill="url(#roll)"/>
    <circle cx="154" cy="128" r="11" fill="#e3d3a6"/><circle cx="154" cy="128" r="4.5" fill="#a98f5c"/>
    <circle cx="358" cy="128" r="11" fill="#e3d3a6"/><circle cx="358" cy="128" r="4.5" fill="#a98f5c"/>
  </g>
</svg>
```

Alternativer (a) ren pergamentrull og (c) blå rull-silhuett: se agentrapport i sesjonsloggen om ønskelig.
