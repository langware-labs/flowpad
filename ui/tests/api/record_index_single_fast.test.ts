/**
 * `flow record index <path>` SLO: indexing a SINGLE file must be scoped + fast.
 *
 * Bug (proven by RCA): POST /fs-records/index ignores the file path and walks the
 * full known-root set, so on an instance with a large workspace it hangs (120s read
 * timeout) and never returns the indexed file's TypeId. That strands "open it" — the
 * agent can't get a TypeId to `flow navigate` to.
 *
 * Contract: indexing one file completes well under 1s and returns that file's TypeId.
 *
 * Requires: a running backend at localhost:$LOCAL_SERVER_PORT (api project).
 */

import { apiClient, GRAPH_API_PREFIX } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('fs-records/index — single file is scoped, fast, and returns its TypeId', () => {
  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
  });

  it('indexing one markdown file completes < 1s and returns the file TypeId', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idx-one-'));
    const file = path.join(dir, 'hello.md');
    fs.writeFileSync(file, '# hello\n\nhello world\n');

    const url =
      `${GRAPH_API_PREFIX}/compute_node/@local/fs-records/index` +
      `?type=markdown&path=${encodeURIComponent(file)}`;

    const started = performance.now();
    // The 1s cap IS the asserted SLO for a single-file index — not a mask.
    // Do not raise it: a single file taking >1s means the path scoping is broken.
    const result: any = await Promise.race([
      apiClient.post(url, {}),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('single-file index exceeded its 1s SLO')), 1000),
      ),
    ]);
    const elapsedMs = performance.now() - started;

    expect(elapsedMs, 'single-file index must be under 1s').toBeLessThan(1000);
    const typeid = result?.typeid ?? result?.typeids?.[0];
    expect(typeid, 'index must return the indexed file TypeId').toMatch(
      /^markdown-[0-9a-f-]{36}$/,
    );
  }, 15000);
});
