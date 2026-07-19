# PDF Scholar — Privacy Policy

_Last updated: 2026-07-19_

PDF Scholar (the desktop app and the browser extension) is a local-first PDF
reader and annotator. **It collects no data about you.**

## What the app does with your data

- **Your documents stay on your machine.** PDFs are opened, rendered and
  annotated locally. Annotations are written into the PDF file itself. Nothing
  is uploaded anywhere by the reader or the annotator.
- **No telemetry, no analytics, no tracking.** The app phones home to no one and
  contains no advertising or analytics SDKs.
- **Settings and reading positions** (recent files, per-file positions, theme,
  window size) are stored locally on your device and never transmitted.

## AI assistant (optional, off by default)

The AI features only work if you enter **your own API key** for a provider
(Anthropic, OpenAI or Azure OpenAI). When — and only when — you explicitly ask
the assistant a question, the relevant document text is sent **directly from
your machine to that provider** under your key and their privacy terms. There is
no intermediary server operated by PDF Scholar. Your API keys are stored
encrypted on your device (Windows DPAPI / macOS Keychain / Linux Secret
Service) and never leave it.

## Automatic updates (desktop app)

The Windows and Linux desktop builds check GitHub Releases
(`github.com/emilmsh/pdf-scholar`) for new versions. This is an ordinary HTTPS
request to GitHub and includes no personal data. Microsoft Store installs update
through the Store instead and perform no self-update checks.

The browser extension performs the same anonymous GitHub version check (at most
once per day) **only when it is sideloaded** ("Load unpacked"), to show a
"new version available" notice — store installs are updated by the store and
never check.

## Browser extension permissions

- **Read and change data on websites / file URLs** (`<all_urls>`, `file:///*`):
  used solely to detect PDF navigations and open them in the PDF Scholar viewer
  instead of the browser's built-in one. Page content on non-PDF sites is never
  read, collected or altered.
- **declarativeNetRequest**: used to redirect PDF requests to the viewer. No
  browsing history is recorded or transmitted.
- The extension has no background data collection of any kind.

## Contact

Questions: open an issue at
[github.com/emilmsh/pdf-scholar](https://github.com/emilmsh/pdf-scholar/issues).
