# PDF Scholar — Privacy Policy

_Last updated: 2026-09-02_

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

The AI features only work if you enter **your own API key** for a provider, or
point the app at a local model server. Nothing is sent in the background:
document content leaves your machine only when you use an AI action, and each
request goes **directly from your machine to the provider you chose** under
your key and their privacy terms. There is no intermediary server operated by
PDF Scholar. Your key is sent to that one provider, as the credential on your
own request, and to no one else — never to us.

**What an AI action sends.** Asking the assistant a question, the one-click
document summary, the AI search, and the quick actions on a selected passage or
a snipped region all send document content with the request. Normally that is
the **whole extractable text** of the document (for documents larger than the
model's context window, an automatically chosen excerpt of the pages) — plus,
depending on the action, the selected text, your question and the conversation
so far, your annotations (for the annotations question), or images: a snipped
region, or pages you attach so a scanned document can be read. Note that some
quick actions (Explain, Simplify, Critique, Find the reference,
snip-to-explain) fire as soon as they are chosen — choosing the action **is**
the request. The assistant labels what rides along (a "whole document" or
excerpt chip on the answer). The optional web search — off by default — lets
the provider run searches on its side while it answers, and those search
queries can be derived from the document.

**Who receives it.** The provider you configured: Anthropic, OpenAI,
Azure OpenAI, OpenRouter, Google Gemini, xAI (Grok), Mistral, Groq, or any
OpenAI-compatible endpoint you point the app at. With a **local** server
(Ollama, LM Studio) the content stays on your machine. What a hosted provider
does with received content — retention, training, region — is governed by your
agreement with that provider, not by the app.

**The AI access switch.** The AI settings hold a three-position switch: **On**
(AI actions fire when used), **Confirm before sharing** (the first time a
document is sent to a provider in a session — one-click actions included — the
request pauses and names the model and what is about to be attached; follow-up
questions about the same document to the same provider then pass, since nothing
new leaves the machine, and a new document or a new provider asks again), and
**Off** (no request is sent at all: the app refuses
in the transport layer, not just in the interface, so a stored key cannot leak
content by accident). If your licence to a document does not permit sharing it
with an AI service, use Confirm or Off — the app cannot know what your
subscriptions and licences allow.

How the key is protected where it is stored depends on what the platform offers,
and the app uses the strongest option available on each. The assistant's key
settings state which of the cases below applies on your machine:

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
  stored. It is a layer against copies of the profile rather than the equivalent
  of an OS keychain. Where the encryption is unavailable altogether (a hardened
  profile, some private modes), the extension behaves as Linux without a keyring
  does: the key stays in memory for the session and nothing is written.
- **Keys stored by an older version.** Earlier versions wrote the key to a file
  unencrypted where no key store was available. The app now takes any such
  plaintext off disk on first launch — re-encrypting it in the key store, or
  moving it into memory for the session where there is none. If that rewrite
  cannot be saved (a read-only profile, a full disk), the settings panel reports
  the key as unencrypted, so you can re-enter it and move it to safe storage.

None of these stop a program already running as your user: it can ask for the key
to be decrypted, exactly as the app does. That is the ceiling for anything that
remembers a credential without asking you for a master password every time, so
set a spending cap in the provider's console as well — the app's key settings link
straight to it.

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
