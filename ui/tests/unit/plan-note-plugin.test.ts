import { remarkPlanNote, transformPlanNoteChildren } from '@/components/spec-editor/plan-note-plugin';
import type { MarkdownNode } from '@milkdown/transformer';
import { describe, expect, it } from 'vitest';

/** Helper to build an MDAST text node */
function text(value: string): MarkdownNode {
  return { type: 'text', value } as MarkdownNode;
}

/** Helper to build an MDAST html inline node */
function html(value: string): MarkdownNode {
  return { type: 'html', value } as MarkdownNode;
}

/** Helper to build an MDAST paragraph node */
function paragraph(...children: MarkdownNode[]): MarkdownNode {
  return { type: 'paragraph', children } as MarkdownNode;
}

// ---------------------------------------------------------------------------
// transformPlanNoteChildren
// ---------------------------------------------------------------------------

describe('transformPlanNoteChildren', () => {
  it('returns children unchanged when no <plan-note> tags present', () => {
    const input = [text('hello'), text(' world')];
    const result = transformPlanNoteChildren(input);
    expect(result).toEqual(input);
  });

  it('wraps content between <plan-note> and </plan-note> into a planNote node', () => {
    const input = [text('before '), html('<plan-note>'), text('user note'), html('</plan-note>'), text(' after')];
    const result = transformPlanNoteChildren(input);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(text('before '));
    expect(result[1]!.type).toBe('planNote');
    expect(result[1]!.children).toEqual([text('user note')]);
    expect(result[2]).toEqual(text(' after'));
  });

  it('handles multiple <plan-note> sections', () => {
    const input = [
      html('<plan-note>'),
      text('first'),
      html('</plan-note>'),
      text(' gap '),
      html('<plan-note>'),
      text('second'),
      html('</plan-note>'),
    ];
    const result = transformPlanNoteChildren(input);

    expect(result).toHaveLength(3);
    expect(result[0]!.type).toBe('planNote');
    expect(result[0]!.children).toEqual([text('first')]);
    expect(result[1]).toEqual(text(' gap '));
    expect(result[2]!.type).toBe('planNote');
    expect(result[2]!.children).toEqual([text('second')]);
  });

  it('handles <plan-note> with multiple child nodes', () => {
    const bold: MarkdownNode = { type: 'strong', children: [text('bold')] } as MarkdownNode;
    const input = [html('<plan-note>'), text('before '), bold, text(' after'), html('</plan-note>')];
    const result = transformPlanNoteChildren(input);

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('planNote');
    expect(result[0]!.children).toHaveLength(3);
    expect(result[0]!.children![0]).toEqual(text('before '));
    expect(result[0]!.children![1]).toEqual(bold);
    expect(result[0]!.children![2]).toEqual(text(' after'));
  });

  it('handles unclosed <plan-note> gracefully (collects remaining nodes)', () => {
    const input = [html('<plan-note>'), text('no close tag')];
    const result = transformPlanNoteChildren(input);

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('planNote');
    expect(result[0]!.children).toEqual([text('no close tag')]);
  });

  it('handles empty <plan-note></plan-note>', () => {
    const input = [html('<plan-note>'), html('</plan-note>')];
    const result = transformPlanNoteChildren(input);

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('planNote');
    expect(result[0]!.children).toEqual([]);
  });

  it('recurses into paragraph children', () => {
    const para = paragraph(text('text '), html('<plan-note>'), text('note'), html('</plan-note>'));
    const input = [para];
    const result = transformPlanNoteChildren(input);

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('paragraph');
    expect(result[0]!.children).toHaveLength(2);
    expect(result[0]!.children![0]).toEqual(text('text '));
    expect(result[0]!.children![1]!.type).toBe('planNote');
    expect(result[0]!.children![1]!.children).toEqual([text('note')]);
  });

  it('handles whitespace around tags', () => {
    const input = [html('  <plan-note>  '), text('trimmed'), html('  </plan-note>  ')];
    const result = transformPlanNoteChildren(input);

    expect(result).toHaveLength(1);
    expect(result[0]!.type).toBe('planNote');
    expect(result[0]!.children).toEqual([text('trimmed')]);
  });

  it('does not transform unrelated html nodes', () => {
    const input = [html('<div>'), text('content'), html('</div>')];
    const result = transformPlanNoteChildren(input);

    // Should pass through unchanged
    expect(result).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// remarkPlanNote (remark plugin)
// ---------------------------------------------------------------------------

describe('remarkPlanNote', () => {
  it('transforms tree root children', () => {
    const tree = {
      type: 'root',
      children: [paragraph(html('<plan-note>'), text('note'), html('</plan-note>'))],
    };

    const plugin = remarkPlanNote();
    plugin(tree);

    const para = tree.children[0] as MarkdownNode;
    expect(para.children).toHaveLength(1);
    expect(para.children![0]!.type).toBe('planNote');
  });

  it('is a no-op on a tree without children', () => {
    const tree = { type: 'root' };
    const plugin = remarkPlanNote();
    // Should not throw
    plugin(tree);
    expect(tree).toEqual({ type: 'root' });
  });

  it('preserves non-plan-note content in tree', () => {
    const tree = {
      type: 'root',
      children: [paragraph(text('plain text'))],
    };

    const plugin = remarkPlanNote();
    plugin(tree);

    const para = tree.children[0] as MarkdownNode;
    expect(para.children).toHaveLength(1);
    expect(para.children![0]).toEqual(text('plain text'));
  });
});
