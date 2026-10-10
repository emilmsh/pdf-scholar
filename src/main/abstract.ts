// Desktop half of the abstract behind a citation (issue #31): the shared
// client wired to real fetch. In MAIN for the same reasons as the DOI reserve —
// one session cache and one arXiv queue for the whole app (arXiv's terms allow
// one request every three seconds, however many windows ask), and the renderer
// hands over only the entry's text, never a URL. All logic lives in
// src/shared/abstract.ts where scripts/test-abstract.mjs can reach it.

import { createAbstractClient } from '../shared/abstract'
import { httpDoiFetch } from '../shared/doi'

const client = createAbstractClient(httpDoiFetch)

export const citationAbstract = client.lookup
