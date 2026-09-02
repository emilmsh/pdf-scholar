// Desktop half of the Zotero bridge: the shared client wired to real fetch.
//
// HTTP to Zotero's local API lives in MAIN, not the renderer — the API's CORS
// behaviour is undocumented, and keeping the client here gives the app one
// session cache and one timeout policy. All logic (path→key, URL building,
// response parsing, error codes) is in src/shared/zotero.ts where the pure-Node
// test can reach it; this file is only the wiring.

import { createZoteroClient, httpZoteroFetch } from '../shared/zotero'

const client = createZoteroClient(httpZoteroFetch)

export const zoteroInfo = client.info
export const zoteroSelectUrlFor = client.selectUrl
