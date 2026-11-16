/** Which files get an "Open in browser" globe: HTML on a machine's own disk, nothing else. */
import { describe, expect, it } from 'vitest';
import { TypeId } from '@sdk';
import { localHtmlRef } from '@src/lib/open-in-browser';

describe('localHtmlRef', () => {
  it('gives a ref for an HTML file on the local machine', () => {
    expect(localHtmlRef('/Users/me/site/index.html')?.localComputeNodeId).toBeTruthy();
    expect(localHtmlRef('/Users/me/site/old.HTM')).not.toBeNull();
  });

  it('gives none for other files, no path, or a hub-backed ref', () => {
    expect(localHtmlRef('/Users/me/notes.md')).toBeNull();
    expect(localHtmlRef(null)).toBeNull();
    expect(localHtmlRef('/deck/index.html', new TypeId('project', '3f2a1b4c-0000-4000-8000-0000000000aa'))).toBeNull();
  });
});
