/**
 * Dead-route redirect targets (X9b) — the canonical URLs the router rewrites
 * `/dock/skills` and `/dock/markdown/<id>` to. Targets are built through the
 * DockPointer / AssetDocPointer grammar, so these assertions also pin that the
 * dead slugs land on the lean Assets routes (not the full Home dashboard).
 */
import { describe, expect, it } from 'vitest';
import { markdownRedirectTarget, skillsRedirectTarget } from '@src/navigation/dead-route-redirects';

// Valid v4-shaped UUID (TypeId enforces the entity-id policy: v4/v5 only).
const U = (h: string) => `${h.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-000000000000`;

describe('skillsRedirectTarget', () => {
  it('redirects /dock/skills to the Assets browser filtered to skills', () => {
    expect(skillsRedirectTarget()).toBe('/dock/assets/list/skill');
  });
});

describe('markdownRedirectTarget', () => {
  it('redirects a bare <uuid> to the canonical markdown asset editor', () => {
    const id = U('30c0');
    expect(markdownRedirectTarget(id)).toBe(`/dock/assets/editor/markdown/typeid/markdown-${id}`);
  });

  it('accepts a full markdown-<uuid> TypeId', () => {
    const id = U('aa11');
    expect(markdownRedirectTarget(`markdown-${id}`)).toBe(
      `/dock/assets/editor/markdown/typeid/markdown-${id}`,
    );
  });

  it('returns null for a non-markdown TypeId (caller renders NotFound)', () => {
    expect(markdownRedirectTarget(`agent-${U('beef')}`)).toBeNull();
  });

  it('returns null for an unparseable / empty id', () => {
    expect(markdownRedirectTarget('not-a-valid-id')).toBeNull();
    expect(markdownRedirectTarget(undefined)).toBeNull();
  });
});
