/**
 * Fast-path test: Record Search View
 * Scenario: search/record_search_view.md (test 4)
 *
 * Validates the core backend contract for the search API:
 * 1. GET /api/v1/search?q=test&limit=5 returns HTTP 200
 * 2. Response body has status "SUCCESS"
 * 3. data.results is an array (may be empty — NoOpIndexer returns [])
 * 4. data.indexer_ready is a boolean
 *
 * Exit 0 = pass, non-zero = fail (run full Playwright path)
 */

const API_URL = process.env.API_URL || "http://localhost:9007";

interface SearchResult {
  id?: string;
  name?: string;
  record_type?: string;
  [key: string]: unknown;
}

interface SearchData {
  results: SearchResult[];
  query?: string;
  total?: number;
  indexer_ready: boolean;
}

interface ApiResponse<T = unknown> {
  status: string;
  data?: T;
  message?: string;
}

async function main() {
  // 1. Hit the search endpoint
  const searchRes = await fetch(`${API_URL}/api/v1/search?q=test&limit=5`);

  if (!searchRes.ok) {
    console.error(`Search API returned HTTP ${searchRes.status}`);
    process.exit(1);
  }

  let body: ApiResponse<SearchData>;
  try {
    body = (await searchRes.json()) as ApiResponse<SearchData>;
  } catch (err) {
    console.error("Search API response is not valid JSON:", err);
    process.exit(1);
  }

  // 2. status must be "SUCCESS"
  if (body.status !== "SUCCESS") {
    console.error(`Search API returned non-SUCCESS status: ${body.status} — ${body.message ?? ""}`);
    process.exit(1);
  }

  // 3. data must exist
  if (!body.data) {
    console.error("Search API response missing 'data' field");
    process.exit(1);
  }

  // 4. data.results must be an array
  if (!Array.isArray(body.data.results)) {
    console.error(
      `data.results is not an array — got: ${JSON.stringify(body.data.results)}`
    );
    process.exit(1);
  }

  console.log(`data.results is an array with ${body.data.results.length} item(s)`);

  // 5. data.indexer_ready must be a boolean
  if (typeof body.data.indexer_ready !== "boolean") {
    console.error(
      `data.indexer_ready is not a boolean — got: ${JSON.stringify(body.data.indexer_ready)}`
    );
    process.exit(1);
  }

  console.log(`data.indexer_ready = ${body.data.indexer_ready}`);

  console.log("Fast path passed — search API backend contract verified");
  process.exit(0);
}

main().catch((err: Error) => {
  console.error("Fast path error:", err.message);
  process.exit(1);
});
