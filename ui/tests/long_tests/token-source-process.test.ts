/** Real SDK funding proof. Run only against a disposable instance with TOKEN_SOURCE_CASES.
 * The manifest contains source IDs/models, never credentials. No skipped cell counts as a pass.
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgenticProcess, FlowElementTypes, WorkerStatus, llmSourcesService } from '@sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { apiTestSetup } from '../utils/test-utils';

interface SourceCase {
  name: string;
  worker: string;
  endpoint: string;
  kind: 'device' | 'api_key' | 'hub';
  /** Null means genuinely omitted, distinct from the native device default's empty string. */
  model: string | null;
  resolvedModel: string | null;
  public?: boolean;
}

const manifest = process.env.TOKEN_SOURCE_CASES;
const cases: SourceCase[] = manifest ? JSON.parse(readFileSync(manifest, 'utf8')) : [];
if (manifest && (!Array.isArray(cases) || !cases.length)) throw new Error('Required source matrix is empty');
for (const cell of cases) {
  if (!cell.name || !cell.worker || !cell.endpoint || (cell.model !== null && typeof cell.model !== 'string')
    || (cell.model === '' && cell.kind !== 'device') || !['device', 'api_key', 'hub'].includes(cell.kind)) {
    throw new Error('Invalid token source matrix cell');
  }
}

describe.skipIf(!manifest)('token sources through the local TypeScript SDK', () => {
  beforeAll(async () => {
    if (!process.env.FLOW_INSTANCE?.startsWith('token-sources-')) {
      throw new Error('Select a disposable token-sources-* instance before running paid source tests');
    }
    await apiTestSetup();
  });

  it.each(cases)('$name', async (cell) => {
    const funding = await llmSourcesService.fetchStatus();
    const source = funding?.available.find((row) => `llm_endpoint-${row.id}` === cell.endpoint)
      ?? funding?.endpoints[cell.endpoint];
    // A public hub pin may not be listed for a signed-out local consumer.
    if (!cell.public) {
      expect(source?.kind).toBe(cell.kind);
    }
    const proc = await AgenticProcess.newHeadless({
      worker_type: cell.worker,
      workdir: mkdtempSync(join(tmpdir(), 'token-source-ts-')),
      cli_config: { ...(cell.model === null ? {} : { model: cell.model }), permission_mode: 'bypassPermissions' },
      llm_endpoint_typeid: cell.endpoint,
      llm_endpoint_public: cell.public ?? false,
      load_flowpad_assistant: false,
    }).save();
    try {
      await proc.watch();
      await proc.prompt('Reply with only the digit that equals seven minus four. Do not use tools.');
      if (!proc.busy && proc.workerStatus === WorkerStatus.COMPLETE) expect(proc.completed).toBe(true);
      await proc.reload();
      await proc.waitForComplete();
      const frames = proc.flowDataStream.items;
      const answer = frames.filter((item) => item.elementType === FlowElementTypes.CHAT
        && item.attributes.role === 'assistant').map((item) => item.content).join('');
      expect(answer.trim()).toMatch(/^3[.!]?$/);
      expect(frames.some((item) => item.elementType === FlowElementTypes.END)).toBe(true);
      expect(proc.error).toBeNull();
      expect(proc.resolved_llm_endpoint_typeid).toBe(cell.endpoint);
      expect(proc.resolved_model_slug).toBe(cell.resolvedModel);
      if (cell.model === null) expect(proc.cli_config?.model ?? '').toBe('');
      console.log(JSON.stringify({ entry: 'typescript', case: cell.name, process: proc.id,
        endpoint: proc.resolved_llm_endpoint_typeid, requestedModel: cell.model,
        model: proc.resolved_model_slug, answer, outcome: 'PASS' }));
    } finally {
      await proc.exit();
      await proc.delete();
    }
  });
});
