import { remarkBidi, transformBidiChildren } from '@src/components/milkdown-editor/plugins/bidi/parser';
import type { MarkdownNode } from '@milkdown/transformer';
import { describe, expect, it } from 'vitest';

function text(value: string): MarkdownNode {
  return { type: 'text', value } as MarkdownNode;
}

function html(value: string): MarkdownNode {
  return { type: 'html', value } as MarkdownNode;
}

function paragraph(...children: MarkdownNode[]): MarkdownNode {
  return { type: 'paragraph', children } as MarkdownNode;
}

// ── transformBidiChildren ───────────────────────────────────────────────────

describe('transformBidiChildren', () => {
  it('returns input unchanged when no bidi wrappers present', () => {
    const input = [paragraph(text('hello'))];
    expect(transformBidiChildren(input)).toEqual(input);
  });

  it('lifts blank-line-wrapped <p dir="rtl"> into a paragraph with data.bidi', () => {
    const input = [
      html('<p dir="rtl">'),
      paragraph(text('שלום עולם')),
      html('</p>'),
    ];
    const result = transformBidiChildren(input);

    expect(result).toHaveLength(1);
    const para = result[0] as MarkdownNode & { data?: { bidi?: { dir: string | null; align: string | null } } };
    expect(para.type).toBe('paragraph');
    expect(para.data?.bidi).toEqual({ dir: 'rtl', align: null });
    expect(para.children).toEqual([text('שלום עולם')]);
  });

  it('lifts <h2 dir="rtl"> into a heading with depth + data.bidi', () => {
    const input = [
      html('<h2 dir="rtl">'),
      paragraph(text('כותרת')),
      html('</h2>'),
    ];
    const result = transformBidiChildren(input);

    expect(result).toHaveLength(1);
    const heading = result[0] as MarkdownNode & { depth?: number; data?: { bidi?: { dir: string | null } } };
    expect(heading.type).toBe('heading');
    expect(heading.depth).toBe(2);
    expect(heading.data?.bidi).toEqual({ dir: 'rtl', align: null });
    expect(heading.children).toEqual([text('כותרת')]);
  });

  it('extracts text-align from style attribute', () => {
    const input = [
      html('<p dir="rtl" style="text-align: end">'),
      paragraph(text('aligned')),
      html('</p>'),
    ];
    const result = transformBidiChildren(input);
    const para = result[0] as MarkdownNode & { data?: { bidi?: { dir: string; align: string } } };
    expect(para.data?.bidi).toEqual({ dir: 'rtl', align: 'end' });
  });

  it('accepts align-only wrappers (no dir)', () => {
    const input = [
      html('<p style="text-align: center">'),
      paragraph(text('centered')),
      html('</p>'),
    ];
    const result = transformBidiChildren(input);
    const para = result[0] as MarkdownNode & { data?: { bidi?: { dir: string | null; align: string } } };
    expect(para.data?.bidi).toEqual({ dir: null, align: 'center' });
  });

  it('inline form: single html block <p dir="rtl">CONTENT</p>', () => {
    const input = [html('<p dir="rtl">שלום</p>')];
    const result = transformBidiChildren(input);

    expect(result).toHaveLength(1);
    const para = result[0] as MarkdownNode & { data?: { bidi?: { dir: string } } };
    expect(para.type).toBe('paragraph');
    expect(para.data?.bidi).toEqual({ dir: 'rtl', align: null });
    expect(para.children).toEqual([text('שלום')]);
  });

  it('leaves unrelated HTML untouched (no dir/align attrs)', () => {
    // Project invariant says no HTML in markdown, but if someone *does* hand-author
    // some, we must not mangle it. A plain <p> wrapper without bidi attrs falls
    // through as a raw html block.
    const input = [
      html('<p>'),
      paragraph(text('content')),
      html('</p>'),
    ];
    expect(transformBidiChildren(input)).toEqual(input);
  });

  it('leaves non-p/h tags untouched even with dir attr', () => {
    // Only paragraph and heading are scoped for phase 3. Other tags pass through.
    const input = [html('<div dir="rtl">arbitrary html</div>')];
    expect(transformBidiChildren(input)).toEqual(input);
  });

  it('rejects unknown dir values (treats as plain html)', () => {
    const input = [
      html('<p dir="upside-down">'),
      paragraph(text('weird')),
      html('</p>'),
    ];
    // No dir or align matched → not a bidi wrapper → pass through.
    expect(transformBidiChildren(input)).toEqual(input);
  });

  it('handles whitespace around tags', () => {
    const input = [
      html('  <p dir="rtl">  '),
      paragraph(text('whitespace')),
      html('  </p>  '),
    ];
    const result = transformBidiChildren(input);
    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('paragraph');
  });

  it('recurses into block container children', () => {
    // A bidi wrapper inside a blockquote should still be lifted.
    const quote: MarkdownNode = {
      type: 'blockquote',
      children: [html('<p dir="rtl">'), paragraph(text('quoted')), html('</p>')],
    } as MarkdownNode;
    const result = transformBidiChildren([quote]);
    const innerChildren = (result[0]! as MarkdownNode).children!;
    expect(innerChildren).toHaveLength(1);
    const lifted = innerChildren[0] as MarkdownNode & { data?: { bidi?: { dir: string } } };
    expect(lifted.type).toBe('paragraph');
    expect(lifted.data?.bidi?.dir).toBe('rtl');
  });
});

// ── remarkBidi (full plugin) ───────────────────────────────────────────────

describe('remarkBidi', () => {
  it('transforms tree root children', () => {
    const tree = {
      type: 'root',
      children: [html('<p dir="rtl">'), paragraph(text('hi')), html('</p>')],
    };
    remarkBidi()(tree);
    expect(tree.children).toHaveLength(1);
    const para = tree.children[0] as MarkdownNode & { data?: { bidi?: { dir: string } } };
    expect(para.type).toBe('paragraph');
    expect(para.data?.bidi?.dir).toBe('rtl');
  });

  it('is a no-op on a tree with no children', () => {
    const tree = { type: 'root' };
    remarkBidi()(tree);
    expect(tree).toEqual({ type: 'root' });
  });

  it('preserves plain markdown content', () => {
    const tree = {
      type: 'root',
      children: [paragraph(text('plain English paragraph'))],
    };
    remarkBidi()(tree);
    expect(tree.children).toHaveLength(1);
    const para = tree.children[0] as MarkdownNode & { data?: unknown };
    expect(para.type).toBe('paragraph');
    expect(para.data).toBeUndefined();
  });
});
