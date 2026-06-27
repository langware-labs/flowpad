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
 *
 * The force index is a full filesystem walk, so it runs ONCE in beforeAll and
 * the result (body + rows) is shared across the read-only assertions.
 */
import { expect, test } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';

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

/** Unwrap the fs-records list envelope (array | {records} | {rows}). */
function rowsOf<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const d = data as { records?: T[]; rows?: T[] } | null;
  return d?.records ?? d?.rows ?? [];
}

// Shared across tests — the force index (a full host FS walk) runs once.
let indexBody: { status?: string; data?: { errors?: number } };
let rows: McpRow[];

test.describe('MCP server indexing — read-only scan', () => {
  test.beforeAll(async () => {
    const rq = await apiContext();
    const idx = await rq.post(
      `${API}/api/v1/graph/compute_node/@local/fs-records/index?type=mcp_server&force=true`,
    );
    expect(idx.status()).toBe(200);
    indexBody = await idx.json();
    const got = await rq.get(`${API}/api/v1/graph/compute_node/@local/fs-records/mcp_server`);
    expect(got.status()).toBe(200);
    rows = rowsOf<McpRow>((await got.json()).data);
    await rq.dispose();
  });

  // ── Test 1: force index succeeds + every row carries its definition-site handle ──
  test('force index succeeds with zero errors and every row has its handle fields', async () => {
    expect(indexBody.status).toBe('SUCCESS');
    // The mcp_server pass must complete cleanly (errors is a count; 0 expected).
    const errors = indexBody.data?.errors;
    if (typeof errors === 'number') expect(errors).toBe(0);

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
  test('indexed rows use valid scope/format labels and correct per-scope handle shapes', async () => {
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
    const frags = rowsOf<{ type?: string; name?: string; json_path?: string }>(body.data);
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
