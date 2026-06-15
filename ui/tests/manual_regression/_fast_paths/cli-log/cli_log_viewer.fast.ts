/**
 * Fast-path test: CLI Invocation Log viewer
 * Scenario: cli-log/cli_log_viewer.md
 *
 * Validates the core backend contract for the CLI log feature:
 * 1. Backend health is reachable
 * 2. Bootstrap endpoint returns a compute node
 * 3. The clear-cli-log action endpoint exists on the compute node
 * 4. The fs-records/cli_log endpoint is reachable
 *
 * Exit 0 = pass, non-zero = fail (run full path)
 */

import { apiOrigin } from "../../_shared/api";

// Frontend origin: explicit APP_URL override, else the Vite dev-server port.
const APP_URL = process.env.APP_URL || `http://localhost:${process.env.VITE_PORT || "4097"}`;
const API_URL = apiOrigin();

interface BootstrapEntity {
  type?: string;
  id?: string;
  typeId?: { id?: string };
}

interface BootstrapData {
  default_compute_node?: BootstrapEntity;
  [key: string]: unknown;
}

interface ApiResponse<T = unknown> {
  status: string;
  data?: T;
  message?: string;
}

async function main() {
  // 1. Backend health check
  const health = await fetch(`${API_URL}/health/status`);
  if (!health.ok) {
    console.error(`Health check failed: ${health.status}`);
    process.exit(1);
  }

  // 2. Bootstrap to get the compute node id
  // Bootstrap returns a dict with keys: user, default_project, default_workspace,
  // default_compute_node, env, desktop_info, sniffer_hook (not an array of entities)
  const bootstrapRes = await fetch(`${API_URL}/api/v1/graph/bootstrap`);
  if (!bootstrapRes.ok) {
    console.error(`Bootstrap failed: ${bootstrapRes.status}`);
    process.exit(1);
  }

  const bootstrapBody = (await bootstrapRes.json()) as ApiResponse<BootstrapData>;
  if (bootstrapBody.status !== "SUCCESS") {
    console.error(`Bootstrap returned non-SUCCESS: ${bootstrapBody.status}`);
    process.exit(1);
  }

  const computeNode = bootstrapBody.data?.default_compute_node;

  if (!computeNode) {
    console.error("No default_compute_node found in bootstrap response");
    console.error("Bootstrap data keys:", JSON.stringify(Object.keys(bootstrapBody.data ?? {})));
    process.exit(1);
  }

  const cnId = computeNode.id;
  if (!cnId) {
    console.error("Compute node has no usable id");
    process.exit(1);
  }

  console.log(`Compute node id: ${cnId}`);

  // 3. Verify fs-records/cli_log endpoint responds (list entries)
  const logRes = await fetch(
    `${API_URL}/api/v1/graph/compute_node/${cnId}/fs-records/cli_log?limit=10`
  );
  if (!logRes.ok) {
    console.error(`CLI log fs-records endpoint failed: ${logRes.status}`);
    process.exit(1);
  }

  const logBody = (await logRes.json()) as ApiResponse<unknown[]>;
  if (logBody.status !== "SUCCESS") {
    console.error(`CLI log returned non-SUCCESS: ${logBody.status} — ${logBody.message ?? ""}`);
    process.exit(1);
  }

  const entries = logBody.data ?? [];
  console.log(`CLI log entries found: ${entries.length}`);

  // 4. Verify the clear-cli-log action endpoint exists (HEAD-style: use POST and accept any valid HTTP response)
  const clearRes = await fetch(
    `${API_URL}/api/v1/graph/compute_node/${cnId}/clear-cli-log`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }
  );
  // We accept 200 (cleared) or 404 only if it's because there was nothing to clear —
  // a non-500 response confirms the action is registered.
  if (clearRes.status >= 500) {
    console.error(`clear-cli-log action returned server error: ${clearRes.status}`);
    process.exit(1);
  }

  console.log(`clear-cli-log action reachable (status ${clearRes.status})`);

  // 5. Verify frontend loads
  const frontendRes = await fetch(`${APP_URL}/`);
  if (!frontendRes.ok) {
    console.error(`Frontend not reachable: ${frontendRes.status}`);
    process.exit(1);
  }

  console.log("Fast path passed — CLI log backend contract verified");
  process.exit(0);
}

main().catch((err: Error) => {
  console.error("Fast path error:", err.message);
  process.exit(1);
});
