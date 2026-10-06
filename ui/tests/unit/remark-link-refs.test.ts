/** Markdown detection: file references in prose and whole-span inline code become links. */
import { describe, expect, it } from 'vitest';
import type { Link, Root } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import remarkLinkRefs from '@src/lib/remark-link-refs';

function links(markdown: string): Array<{ url: string; code: boolean; ref?: string }> {
  const processor = unified().use(remarkParse).use(remarkGfm).use(remarkLinkRefs);
  const tree = processor.runSync(processor.parse(markdown)) as Root;
  const out: Array<{ url: string; code: boolean; ref?: string }> = [];
  const walk = (node: { type: string; children?: unknown[] }) => {
    if (node.type === 'link') {
      const link = node as Link;
      const ref = (link.data?.hProperties as { dataLinkRef?: string } | undefined)?.dataLinkRef;
      out.push({ url: link.url, code: link.children[0]?.type === 'inlineCode', ...(ref !== link.url ? { ref } : {}) });
    }
    for (const child of (node.children ?? []) as Array<{ type: string; children?: unknown[] }>) walk(child);
  };
  walk(tree);
  return out;
}

describe('remarkLinkRefs', () => {
  it('links a path in prose, keeping the text around it', () => {
    expect(links('Edited ui/src/a.ts:42 and /tmp/x.')).toEqual([
      { url: 'ui/src/a.ts:42', code: false },
      { url: '/tmp/x', code: false },
    ]);
  });

  it('links inline code only when the whole span is one reference', () => {
    expect(links('See `ui/src/a.ts:42` then run `cat a/b.txt`.')).toEqual([{ url: 'ui/src/a.ts:42', code: true }]);
  });

  it('leaves authored links and gfm URLs as they are, and never links inside a link', () => {
    expect(links('[the file](src/a.ts#L3) and https://example.org/src/main.py')).toEqual([
      { url: 'src/a.ts#L3', code: false },
      { url: 'https://example.org/src/main.py', code: false },
    ]);
  });

  it('shares the terminal rules: placeholders and prose abbreviations are not links', () => {
    expect(links('Open `/dock/...` e.g. later')).toEqual([]);
  });

  it('finds a path glued to Hebrew prose', () => {
    expect(links('ערכתי את ב-src/a.ts עכשיו')).toEqual([{ url: 'src/a.ts', code: false }]);
  });

  it('leaves fenced code alone', () => {
    expect(links('```\nsrc/a.ts:3\n```')).toEqual([]);
  });

  it('a position is a reference, not a URL scheme: it survives as the link ref', () => {
    expect(links('At code.py:12:3 and `code.py:3` and C:\\x\\y.txt')).toEqual([
      { url: 'code.py:12:3', code: false },
      { url: 'code.py:3', code: true },
      { url: 'C:\\x\\y.txt', code: false },
    ]);
  });

  it('leaves a browser-owned scheme a plain link', () => {
    expect(links('Mail [me](mailto:me@x.test)')).toEqual([{ url: 'mailto:me@x.test', code: false, ref: undefined }]);
  });
});
