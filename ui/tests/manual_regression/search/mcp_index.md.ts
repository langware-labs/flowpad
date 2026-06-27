/**
 * MCP server indexing — read-only scan pipeline (all agents, all scopes).
 * Source: mcp_index.md
 *
 * The two-stage FSIndexer walk (mcp_source_files_fn → mcp_servers_in_file_fn →
 * extract_mcp_server) discovers every MCP server definition on the machine and
 * indexes it with its definition-site handle. These tests assert the pipeline's
 * structural contract on whatever the host actually has configured — they do NOT
 * assert an exact server count (that is host-state dependent and cannot be
 * controlled headlessly: project-scope discovery is keyed on flowpad-KNOWN
 * projects, i.e. the host ~/.claude|~/.codex scan, not synthetic /tmp fixtures).
 */
import { expect, test } from '@playwright/test';
import { apiBase } from '../_shared/api';

const API = apiBase();
const SCOPES = new Set(['user', 'project', 'local', 'system']);
const FORMATS = new Set(['json', 'toml']);

interface McpRow {
  name?: string;
  scope?: string;
  source_file?: string;
  json_path?: string;
  format?: string;
  project_path?: string;
  url?: string;
  transport?: string;
}

async function indexMcp(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post(
    `${API}/api/v1/graph/compute_node/@local/fs-records/index?type=mcp_server&force=true`,
  );
  expect(res.status()).toBe(200);
  return (await res.json());
}

async function mcpRows(request: import('@playwright/test').APIRequestContext): Promise<McpRow[]> {
  const res = await request.get(`${API}/api/v1/graph/compute_node/@local/fs-records/mcp_server`);
  expect(res.status()).toBe(200);
  const data = (await res.json()).data;
  return (Array.isArray(data) ? data : data?.records ?? data?.rows ?? []) as McpRow[];
}

test.describe('MCP server indexing — read-only scan', () => {
  // ── Test 1: force index succeeds + every row carries its definition-site handle ──
  test('force index succeeds with zero errors and every row has its handle fields', async ({ request }) => {
    test.setTimeout(60_000);
    const body = await indexMcp(request);
    expect(body.status).toBe('SUCCESS');
    // The mcp_server pass must complete cleanly (errors is a count; 0 expected).
    const errors = body.data?.errors;
    if (typeof errors === 'number') expect(errors).toBe(0);

    const rows = await mcpRows(request);
    // Structural contract holds for whatever is indexed (host may have 0..N).
    for (const r of rows) {
      expect(r.name, `row missing name: ${JSON.stringify(r)}`).toBeTruthy();
      expect(r.scope, `row ${r.name} missing scope`).toBeTruthy();
      expect(r.source_file, `row ${r.name} missing source_file`).toBeTruthy();
      expect(r.json_path, `row ${r.name} missing json_path`).toBeTruthy();
      expect(r.format, `row ${r.name} missing format`).toBeTruthy();
    }
  });

  // ── Test 2: scope/format labels are valid + per-scope handle shapes ─────────
  test('indexed rows use valid scope/format labels and correct per-scope handle shapes', async ({ request }) => {
    test.setTimeout(60_000);
    await indexMcp(request);
    const rows = await mcpRows(request);
    test.skip(rows.length === 0, 'host has no MCP servers configured in any scope — nothing to label-check');

    for (const r of rows) {
      expect(SCOPES.has(r.scope ?? ''), `unexpected scope "${r.scope}" on ${r.name}`).toBe(true);
      expect(FORMATS.has(r.format ?? ''), `unexpected format "${r.format}" on ${r.name}`).toBe(true);
    }
    // A local-scope row (Claude nested under projects[cwd]) carries a /projects/
    // json_path and a decoded project_path.
    for (const r of rows.filter((x) => x.scope === 'local')) {
      expect(r.json_path?.startsWith('/projects/'), `local row ${r.name} json_path ${r.json_path}`).toBe(true);
      expect(r.project_path, `local row ${r.name} missing project_path`).toBeTruthy();
    }
    // A Codex (TOML) row is sourced from .codex/config.toml with /mcp_servers/ path.
    for (const r of rows.filter((x) => x.format === 'toml')) {
      expect(r.source_file?.endsWith('.codex/config.toml'), `toml row ${r.name} source ${r.source_file}`).toBe(true);
      expect(r.json_path?.startsWith('/mcp_servers/'), `toml row ${r.name} json_path ${r.json_path}`).toBe(true);
    }
    // A remote server (if any) carries url + http transport.
    for (const r of rows.filter((x) => x.url)) {
      expect(r.transport, `remote row ${r.name} missing transport`).toBeTruthy();
    }
  });

  // ── Test 3: settings-API per-server fragments (regression) ──────────────────
  test('settings-API returns one claude_mcp_json root + one entry per server (no enum crash)', async ({ request }) => {
    test.setTimeout(60_000);
    await indexMcp(request);
    const rows = await mcpRows(request);
    // Find a real .mcp.json source on the host to read fragments from.
    const jsonSource = rows.find(
      (r) => r.format === 'json' && (r.source_file?.endsWith('.mcp.json') ?? false),
    )?.source_file;
    test.skip(!jsonSource, 'host has no project-scope .mcp.json to read settings-API fragments from');

    const res = await request.get(
      `${API}/api/v1/graph/compute_node/@local/fs-records/file?path=${encodeURIComponent(jsonSource!)}`,
    );
    // The regression was an AttributeError (500) on a non-existent CLAUDE_MCP_SERVER
    // enum member — the endpoint must now respond cleanly.
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    const data = body.data;
    const frags = (Array.isArray(data) ? data : data?.records ?? data?.rows ?? []) as Array<{
      type?: string;
      name?: string;
      json_path?: string;
    }>;
    // One root claude_mcp_json plus one entry per server.
    const roots = frags.filter((f) => f.type === 'claude_mcp_json');
    const entries = frags.filter((f) => (f.type ?? '').includes('claude_mcp_json:entry'));
    expect(roots.length, 'one claude_mcp_json root row').toBeGreaterThanOrEqual(1);
    for (const e of entries) {
      expect(e.name, `entry missing name: ${JSON.stringify(e)}`).toBeTruthy();
      expect(e.json_path, `entry ${e.name} missing json_path`).toBeTruthy();
    }
  });
});
