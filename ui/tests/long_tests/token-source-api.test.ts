/** Explicit, paid local-source lifecycle proof; credentials never enter evidence. */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { lmKeysService, llmSourcesService, LMApiProvider } from '@sdk';
import type { LocalEndpointConfig } from '@sdk/services/lm-keys-service';
import { apiTestSetup } from '../utils/test-utils';

interface SetupCase {
  provider: LMApiProvider;
  credentialFile?: string;
  credentialEnv?: string;
  config: LocalEndpointConfig;
  model: string;
}

const manifest = process.env.TOKEN_SOURCE_SETUP;
const cases: SetupCase[] = manifest ? JSON.parse(readFileSync(manifest, 'utf8')) : [];
if (manifest && (!Array.isArray(cases) || !cases.length)) throw new Error('Required source setup matrix is empty');

describe.skipIf(!manifest)('local token source lifecycle through the TypeScript SDK', () => {
  beforeAll(async () => {
    if (!process.env.FLOW_INSTANCE?.startsWith('token-sources-')) {
      throw new Error('Select a disposable token-sources-* instance');
    }
    await apiTestSetup();
  });

  it.each(cases)('$provider', async (cell) => {
    const key = cell.credentialFile ? readFileSync(cell.credentialFile, 'utf8') : process.env[cell.credentialEnv ?? ''];
    if (!key) throw new Error(`Missing credential for required provider ${cell.provider}`);
    const saved = await lmKeysService.saveEndpoint(cell.provider, { key, config: cell.config });
    expect(saved.ok).toBe(true);
    if (cell.provider === LMApiProvider.Vertex) expect(saved.validation_stage).toBe('configuration');
    else expect(saved.valid).toBe(true);
    const edited = await lmKeysService.saveEndpoint(cell.provider, { config: cell.config });
    expect(edited.endpoint_id).toBe(saved.endpoint_id);
    const catalog = await lmKeysService.listModels(cell.provider);
    expect(catalog.some((model) => model.id === cell.model)).toBe(true);
    const tested = await lmKeysService.testLmApi(cell.provider);
    expect(tested.valid).toBe(true);
    const funding = await llmSourcesService.fetchStatus();
    const row = funding?.available.find((item) => item.id === saved.endpoint_id);
    expect(row?.kind).toBe('api_key');
    expect(row?.tiers.sm).toBe(cell.config.tiers?.sm);
    expect(JSON.stringify({ saved, edited, catalog, tested, funding }).includes(key)).toBe(false);
    await lmKeysService.deleteLmApi(cell.provider);
    expect((await lmKeysService.list()).find((item) => item.provider === String(cell.provider))?.configured).not.toBe(true);
    expect((await llmSourcesService.fetchStatus())?.available.some((item) => item.id === saved.endpoint_id)).toBe(false);
    // Leave a test-owned source available for the independently run process-entry matrix.
    const recreated = await lmKeysService.saveEndpoint(cell.provider, { key, config: cell.config });
    expect(recreated.ok).toBe(true);
    console.log(JSON.stringify({ entry: 'typescript-source-api', provider: cell.provider,
      endpoint: `llm_endpoint-${recreated.endpoint_id}`, outcome: 'PASS', lifecycle: 'create/edit/test/catalog/delete/recreate' }));
  });
});
