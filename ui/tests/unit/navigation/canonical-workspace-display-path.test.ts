/**
 * The host segments are vibe-only: in standard mode a shown document falls back
 * to its natural asset address. Pure URL in / URL out, so it can run before
 * `DockPointer.fromUrl` and nothing downstream ever sees a host in standard mode.
 */
import { describe, expect, it } from 'vitest';
import { canonicalWorkspaceDisplayPath } from '@src/navigation/workspace-display-canonicalization';

const PROJ = 'dd682350-c185-52c9-a92b-d0667141b069';
const ASSET = 'a684848a-af63-4c8a-988e-37a2c01b20b5';
const HOST = 'agentic_process-abc1e873-1ae2-4c55-9242-6b4ddea51420';
const TAIL = `editor/markdown/typeid/markdown-${ASSET}`;
const hosted = `/dock/project/${PROJ}/process/${HOST}/display/${TAIL}`;

describe('canonicalWorkspaceDisplayPath', () => {
  it('strips the host when the URL is not explicitly vibe', () => {
    expect(canonicalWorkspaceDisplayPath(hosted, '')).toBe(`/dock/project/${PROJ}/${TAIL}`);
    expect(canonicalWorkspaceDisplayPath(hosted, '?viewMode=standard')).toBe(
      `/dock/project/${PROJ}/${TAIL}?viewMode=standard`,
    );
  });

  it('leaves an explicitly vibe URL alone', () => {
    expect(canonicalWorkspaceDisplayPath(hosted, '?viewMode=vibe')).toBeNull();
  });

  it('preserves the rest of the query, including scope', () => {
    const search = '?viewMode=standard&scope-mode=project&highlight=Plan';
    expect(canonicalWorkspaceDisplayPath(hosted, search)).toBe(`/dock/project/${PROJ}/${TAIL}${search}`);
  });

  it('keeps the layout keyword and any base path', () => {
    expect(canonicalWorkspaceDisplayPath(`/win/project/${PROJ}/process/${HOST}/display/${TAIL}`, '')).toBe(
      `/win/project/${PROJ}/${TAIL}`,
    );
    expect(canonicalWorkspaceDisplayPath(`/agent/a/flow/f/dock/project/${PROJ}/process/${HOST}/display/${TAIL}`, '')).toBe(
      `/agent/a/flow/f/dock/project/${PROJ}/${TAIL}`,
    );
  });

  it('ignores URLs that carry no host', () => {
    expect(canonicalWorkspaceDisplayPath(`/dock/project/${PROJ}/${TAIL}`, '')).toBeNull();
    expect(canonicalWorkspaceDisplayPath(`/dock/project/${PROJ}`, '')).toBeNull();
    expect(canonicalWorkspaceDisplayPath('/dock/shell/shell-1', '?host=x')).toBeNull();
    // A room pointer is a different composite entirely — never touched.
    expect(canonicalWorkspaceDisplayPath(`/dock/project/${PROJ}/collaboration_room/r1/tab/shell-1`, '')).toBeNull();
  });

  it('does not strip a host with nothing displayed (not an address)', () => {
    expect(canonicalWorkspaceDisplayPath(`/dock/project/${PROJ}/process/${HOST}/display/`, '')).toBeNull();
  });
});
