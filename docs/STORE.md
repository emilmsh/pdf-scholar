# Store distribution guide

Three store tracks, all without recurring costs. Account registration and the
one-time fees are personal steps Emil does himself; everything technical is
prepared in the repo. Status lives in the checklists below — tick them off as
they happen.

## Why stores at all

- **Microsoft Store** solves the two real problems with the GitHub exe: no more
  SmartScreen "unknown publisher" scare (the Store signs the package on
  ingestion) and updates handled by the Store. SmartScreen reputation for the
  unsigned GitHub exe builds per-file and resets with every release, so it will
  keep warning users — the Store listing is the proper fix, and registration is
  now free.
- **Edge Add-ons / Chrome Web Store** turn the extension's four-step
  "Load unpacked" install into one click, and stores auto-update extensions.

---

## Track A — Microsoft Store (desktop app, MSIX)

**Cost: FREE.** Microsoft dropped the individual-developer registration fee — an
Individual account now costs nothing.

> **Don't start from `partner.microsoft.com`'s generic dashboard.** That lands
> you in the Cloud Partner Program (for companies with Entra admin roles) — it
> looks empty and says you have no admin access. That is the WRONG program.
> Use the dedicated Microsoft Store enrollment door below.

1. **[Emil]** Enroll via **<https://developer.microsoft.com/microsoft-store/register>**
   (Microsoft Learn walkthrough:
   <https://learn.microsoft.com/windows/apps/publish/partner-center/open-a-developer-account>).
   Choose the **Individual** account type (for non-commercial / personal apps —
   fits a free open-source project). It **requires a personal Microsoft account
   (MSA)**, not a work/Entra account; a Gmail address works as long as it's
   registered as a Microsoft account. Individual enrollment now includes
   **identity verification** (government-issued ID + a selfie). Note: an
   Individual account can't later be converted to Company — but Individual is
   the right choice here.
2. **[Emil]** Once enrolled, open the Microsoft Store dashboard: **Apps and
   games → New product → MSIX or PWA app**, reserve the name **PDF Scholar**.
3. **DONE** — the three identity values are filled into
   `electron-builder.store.yml` (Store ID `9N75CPC0G9M2`, PFN
   `EmilMathiasStrmHalseth.PDFScholar_9ddn91dy4x8sa`).
4. Run `npm run dist:store` → `release/PDF-Scholar-<version>-x64.appx` and
   `…-arm64.appx` (both **unsigned** — the Store signs on ingestion; the log
   line "AppX is not signed — reason=Windows Store only build" is expected). A
   NSIS `.exe` is also emitted as a byproduct — ignore it; only the `.appx`
   files go to the Store.
5. **[Emil]** In the submission's **Packages** step, upload **both** `.appx`
   files (same version, different architecture — the Store serves the right one
   per device). Fill in the listing (screenshots under `docs/screenshots/`),
   set the privacy policy URL to
   `https://github.com/emilmsh/pdf-scholar/blob/master/docs/PRIVACY.md`, and submit
   for certification (typically 1–3 days).
6. Notes already handled in code/config: electron-updater disables itself in
   Store installs (`process.windowsStore`); the `.pdf` file association rides
   along in the MSIX manifest via `fileAssociations`.

Version bumps: run `dist:store` again and add the new packages to a new
submission. (This can be folded into `release.yml` later once the identity
values are in the repo.)

## Track B — Edge Add-ons (extension)

**Cost: free.** Uses the same Partner Center account (the Edge program is a
separate, free enrollment).

1. **[Emil]** Enroll: <https://partner.microsoft.com/dashboard/microsoftedge/> —
   free.
2. Build the store zip: it is produced by the release workflow as
   `pdf-scholar-extension-store.zip` (manifest at the zip root — the
   folder-wrapped `pdf-scholar-extension.zip` is for Load-unpacked and will be
   REJECTED by store uploaders).
3. **[Emil]** New extension → upload the store zip → listing (Norwegian +
   English descriptions), privacy policy URL as above.
4. Permission justifications the reviewer will ask about (copy-paste ready):
   - `<all_urls>` + `declarativeNetRequest`: "Detects navigations to PDF files
     and opens them in the extension's viewer instead of the browser's built-in
     one. No page content on non-PDF sites is read or modified."
   - `file:///*`: "Lets users open local PDF files in the viewer (users must
     additionally enable 'Allow access to file URLs' themselves)."
5. Review typically takes up to ~7 days.

## Track C — Chrome Web Store (extension)

**One-time cost: USD 5** (developer registration).

1. **[Emil]** Register:
   <https://chrome.google.com/webstore/devconsole> with a Google account, pay
   the one-time USD 5 fee.
2. Upload the same `pdf-scholar-extension-store.zip`.
3. **[Emil]** Fill the **Privacy practices** tab: single purpose ("Open and
   annotate PDF files in a custom viewer"), the permission justifications from
   Track B, privacy policy URL, and "no remote code" / data-usage declarations
   (the extension collects nothing — see `docs/PRIVACY.md`).
4. Broad host permissions (`<all_urls>`) usually route the review to the slower
   queue — expect days to a few weeks on first submission.

---

## Listing assets checklist (shared)

- [ ] Screenshots 1280×800 (crop/re-shoot from `docs/screenshots/` as needed)
- [ ] Chrome small promo tile 440×280 (optional but helps)
- [ ] Store icon: `build/icon.png` (512×512) works everywhere
- [ ] Short description (NO + EN) — reuse the README tagline
