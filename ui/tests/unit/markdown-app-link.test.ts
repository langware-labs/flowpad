import { describe, expect, it } from 'vitest';
import { pointerForAppLink } from '@src/components/assets/editor/markdown/smart-link';

describe('markdown in-app link', () => {
  it('opens the record, not a file named after the route', () => {
    expect(pointerForAppLink('/dock/assets/editor/markdown/typeid/markdown-b173e37b-1f99-5c17-b5d1-c7aa93c29c6d')?.pointer).toBe(
      'editor/markdown/typeid/markdown-b173e37b-1f99-5c17-b5d1-c7aa93c29c6d',
    );
  });

  it('leaves a plain /path to the file handler', () => {
    expect(pointerForAppLink('/docs/arch.md')).toBeNull();
  });
});
