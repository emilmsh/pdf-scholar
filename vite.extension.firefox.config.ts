// Firefox flavour of the browser-extension build → dist-extension-firefox/.
// Reuses the exact same build as the Chromium target (vite.extension.config.ts);
// only the `target` differs, which switches the output dir and swaps in the
// Firefox manifest (event page + blocking webRequest + gecko settings).
//
//   npm run build:ext:firefox
//
// See docs/BROWSER-EXTENSION.md for loading via about:debugging and AMO signing.
import { defineConfig } from 'vite'
import { makeExtensionConfig } from './vite.extension.config'

export default defineConfig(makeExtensionConfig('firefox'))
