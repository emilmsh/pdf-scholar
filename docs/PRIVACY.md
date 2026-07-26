# PDF Scholar — Privacy Policy

_Last updated: 2026-07-26_

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
no intermediary server operated by PDF Scholar. Your key is sent to that one
provider, as the credential on your own request, and to no one else — never to
us.

How the key is protected where it is stored depends on what the platform actually
offers, and the app uses the strongest option available on each. The assistant's key settings always
state which of these applies on your machine — we would rather tell you exactly
what is true than promise "encrypted" everywhere:

- **Desktop app (Windows, macOS, and Linux with a keyring).** The key is
  encrypted at rest by the operating system's own key store — Windows DPAPI,
  macOS Keychain, or Linux Secret Service via gnome-keyring or kwallet. Only your
  user account on that machine can decrypt it, so copying the file elsewhere
  yields nothing useful.
- **Desktop app on Linux with no keyring daemon.** There is no key store to
  encrypt with, and no safe place to keep an encryption key either — so the app
  keeps the API key in memory for that session only and writes nothing to disk.
  You re-enter it next launch.
- **Browser extension.** An extension has no access to the operating system's key
  store. The key is therefore encrypted with AES-GCM under a key that no script
  can read out (a non-extractable WebCrypto key). That protects it from anything
  which merely *reads* the browser profile — a backup, a synced copy, another
  program on disk. It does **not** protect it from code running inside that
  browser profile, which can use the key without ever seeing it, and the browser
  makes no guarantee that the encryption key itself is encrypted where it is
  stored. This is a meaningful extra layer, not the equivalent of a keychain.
  Where that encryption is unavailable altogether (a hardened profile, some
  private modes), the extension does the same as Linux without a keyring: the key
  stays in memory for the session and nothing is written.
- **Keys stored by an older version.** Earlier versions wrote the key to a file
  unencrypted where no key store was available. The app now takes any such
  plaintext off disk on first launch — re-encrypting it in the key store, or
  moving it into memory for the session where there is none. If that rewrite
  cannot be saved (a read-only profile, a full disk), the settings panel reports
  the key as unencrypted rather than claiming a protection it did not achieve.

No mechanism above stops a program already running as you: it can ask for the key
to be decrypted, exactly as the app does. That is the ceiling for anything that
remembers a credential without asking you for a master password every time. The
protection that does not depend on any of this is a spending cap set in the
provider's console, which is why the app's key settings link straight to it.

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
