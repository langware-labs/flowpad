/**
 * `resolveAppHost` — what a served page is FOR, read off its own URL.
 *
 * Every served app is served by a ServiceEndpoint at
 * `…/service_endpoint/<id>/service/…`. An endpoint serving a webapp ASSET names
 * its definition (`webapp_id`), and the definition's parent is what an editor
 * edits. An endpoint with no definition (a bare dev server) is its own app.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager } from '@sdk/APIEntity';
import { appTypeId, resolveAppHost } from '@sdk/apps/host';

const ENDPOINT = '9a1c2b3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const WEBAPP = 'c6f0e1a2-1111-4222-8333-444455556666';
const SUBJECT = 'data_source-6ba7b810-9dad-41d1-80b4-00c04fd430c8';

function servedAt(pathname: string) {
  window.history.replaceState(null, '', pathname);
}

/** Stub the lookup with a fixed table of rows by `<type>-<id>`. */
function rows(table: Record<string, Record<string, unknown>>) {
  return vi
    .spyOn(dataManager, 'getByTypeId')
    .mockImplementation(async (typeId: { toString(): string }) => (table[typeId.toString()] ?? null) as never);
}

describe('appTypeId', () => {
  it('reads the endpoint off a service path', () => {
    const id = appTypeId(`/api/v1/graph/service_endpoint/${ENDPOINT}/service/index.html`);
    expect(id?.toString()).toBe(`service_endpoint-${ENDPOINT}`);
  });

  it('does not read the retired micro_app view path', () => {
    // `micro_app/<id>/view` is gone: every app is served by its endpoint now.
    expect(appTypeId(`/api/v1/graph/micro_app/${WEBAPP}/view/index.html`)).toBeNull();
  });
});

describe('resolveAppHost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    servedAt('/');
  });

  it('resolves a webapp asset to its definition, and the definition to its parent', async () => {
    servedAt(`/api/v1/graph/service_endpoint/${ENDPOINT}/service/`);
    const definition = { id: WEBAPP, type: 'micro_app', parent_type_id: SUBJECT };
    const subject = { id: 'x', type: 'data_source' };
    rows({
      [`service_endpoint-${ENDPOINT}`]: { id: ENDPOINT, type: 'service_endpoint', webapp_id: WEBAPP },
      [`micro_app-${WEBAPP}`]: definition,
      [SUBJECT]: subject,
    });

    const host = await resolveAppHost();
    expect(host.app).toBe(definition);
    expect(host.subject).toBe(subject);
  });

  it('treats an endpoint that serves no definition as the app itself', async () => {
    servedAt(`/api/v1/graph/service_endpoint/${ENDPOINT}/service/`);
    const endpoint = { id: ENDPOINT, type: 'service_endpoint', webapp_id: null };
    rows({ [`service_endpoint-${ENDPOINT}`]: endpoint });

    const host = await resolveAppHost();
    expect(host.app).toBe(endpoint);
    expect(host.subject).toBeNull();
  });

  it('refuses a page that was not served by an endpoint', async () => {
    servedAt('/somewhere/else');
    await expect(resolveAppHost()).rejects.toThrow(/not served by a service endpoint/);
  });
});
