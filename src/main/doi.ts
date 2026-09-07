// Desktop half of the DOI reserve: the shared client wired to real fetch.
//
// Runs in MAIN for the same reason the Zotero client does — one session cache
// and one timeout policy per app, and the renderer never builds a URL out of
// its own input: the DOI is validated (shared/doi.ts isDoi) before anything is
// fetched. All logic lives in src/shared/doi.ts where the pure-Node test can
// reach it; this file is only the wiring.

import { createDoiClient, httpDoiFetch } from '../shared/doi'

const client = createDoiClient(httpDoiFetch)

export const doiCite = client.cite
