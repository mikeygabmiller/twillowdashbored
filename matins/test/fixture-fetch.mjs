// A fetch stand-in that answers from test/fixtures instead of the network.
// Used by `npm run preview --offline` and by the tests, so the full readings +
// verse path can be exercised without depending on anyone's uptime.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, 'fixtures');

const ROUTES = [
  [/\/readings\/2026\/08-05\.json$/, 'readings-2026-08-05.json'],
  [/bible-api[^?]*Matthew%2015%3A21/i, 'dra-matthew-15-21.json'],
];

export function fixtureFetch({ fail = [] } = {}) {
  return async function fetchImpl(url) {
    const href = String(url);
    for (const pattern of fail) {
      if (pattern.test(href)) return new Response('upstream is down', { status: 503 });
    }
    for (const [pattern, file] of ROUTES) {
      if (pattern.test(href)) {
        return new Response(await readFile(resolve(fixtures, file), 'utf8'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('not found', { status: 404 });
  };
}
