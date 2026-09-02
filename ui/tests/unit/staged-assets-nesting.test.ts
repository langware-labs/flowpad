/**
 * The agent-resources "MCP servers" panel offered one logical server three
 * times: once for real, and once per agent that had attached it.
 *
 * Those extra rows are an agent's OWN copies — `Agent.add_mcp` writes them on
 * purpose so a shared agent carries its servers — and the staging scan walks the
 * project tree, so it finds them. Unlike the `/search` surface there is no
 * `parent_type_id` to filter on here: these rows come from the filesystem half
 * of the scan (`disk_asset_descriptors`), which lists assets that have no entity
 * row at all. The path shape is the only signal, and it is the same one the
 * backend `repo_assets_fn` walker recurses on.
 *
 * Paths below are the real ones from the reported screenshot.
 */
import { describe, expect, it } from 'vitest';
import { isNestedAssetPath } from '@src/components/agent-resources/useStagedAssets';

const W = 'C:/Users/Langware-Ishay/Flowpad workspace';

const CANONICAL = [
  `${W}/testing-agent-deployment/agentic-assets/mcp/my-very-first-mcp`,
  `${W}/testing-mcp-feature/agentic-assets/mcp/my-very-first-mcp`,
  `${W}/testing-mcp-feature/agentic-assets/mcp/pong-mcp-server`,
  `${W}/demo-agent-01092026/agentic-assets/mcp/first-mcp-server`,
];

const AGENT_OWNED = [
  `${W}/testing-agent-deployment/agentic-assets/agent/ceo_assistant/agentic-assets/mcp/my-very-first-mcp`,
  `${W}/testing-agent-deployment/agentic-assets/agent/ceo_assistant/agentic-assets/mcp/pong-mcp-server`,
  `${W}/testing-mcp-feature/agentic-assets/agent/ceo-assistant/agentic-assets/mcp/my-very-first-mcp`,
  `${W}/testing-mcp-feature/agentic-assets/agent/mcp-tester/agentic-assets/mcp/pong-mcp-server`,
];

describe('isNestedAssetPath', () => {
  it.each(CANONICAL)('keeps the canonical asset %s', (path) => {
    expect(isNestedAssetPath(path)).toBe(false);
  });

  it.each(AGENT_OWNED)('drops the agent-owned copy %s', (path) => {
    expect(isNestedAssetPath(path)).toBe(true);
  });

  it('collapses the reported panel from 7 rows to 3', () => {
    // The exact set the screenshot showed: 3 project-scoped + 4 user-scoped.
    const shown = [
      `${W}/testing-agent-deployment/agentic-assets/agent/ceo_assistant/agentic-assets/mcp/my-very-first-mcp`,
      `${W}/testing-agent-deployment/agentic-assets/agent/ceo_assistant/agentic-assets/mcp/pong-mcp-server`,
      `${W}/testing-agent-deployment/agentic-assets/mcp/my-very-first-mcp`,
      `${W}/testing-mcp-feature/agentic-assets/mcp/my-very-first-mcp`,
      `${W}/testing-mcp-feature/agentic-assets/mcp/pong-mcp-server`,
      `${W}/testing-mcp-feature/agentic-assets/agent/mcp-tester/agentic-assets/mcp/my-very-first-mcp`,
      `${W}/testing-mcp-feature/agentic-assets/agent/mcp-tester/agentic-assets/mcp/pong-mcp-server`,
    ];
    const kept = shown.filter((p) => !isNestedAssetPath(p));
    // Two same-named survivors remain on purpose: they are different files in
    // different projects, told apart by the panel's own scope chip.
    expect(kept).toEqual([
      `${W}/testing-agent-deployment/agentic-assets/mcp/my-very-first-mcp`,
      `${W}/testing-mcp-feature/agentic-assets/mcp/my-very-first-mcp`,
      `${W}/testing-mcp-feature/agentic-assets/mcp/pong-mcp-server`,
    ]);
  });

  it('reads a Windows backslash path the same way', () => {
    expect(isNestedAssetPath(String.raw`C:\w\proj\agentic-assets\agent\a\agentic-assets\mcp\x`)).toBe(true);
    expect(isNestedAssetPath(String.raw`C:\w\proj\agentic-assets\mcp\x`)).toBe(false);
  });

  it('treats a row with no path (INLINE/EMBEDDED) as not nested', () => {
    expect(isNestedAssetPath(null)).toBe(false);
    expect(isNestedAssetPath(undefined)).toBe(false);
    expect(isNestedAssetPath('')).toBe(false);
  });

  it('does not match a folder that merely CONTAINS the segment name', () => {
    expect(isNestedAssetPath(`${W}/p/agentic-assets/mcp/my-agentic-assets-server`)).toBe(false);
    expect(isNestedAssetPath(`${W}/agentic-assets-backup/agentic-assets/mcp/x`)).toBe(false);
  });
});
