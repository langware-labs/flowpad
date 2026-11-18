/**
 * The editor gives each paragraph the direction most of its words have, like the read-only
 * markdown view — not `dir="auto"`, which let one leading English word (`Hub:`) flip a Hebrew
 * bullet to LTR.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Editor, defaultValueCtx, rootCtx } from '@milkdown/core';
import { commonmark } from '@milkdown/preset-commonmark';
import { bidiPlugins } from '@src/components/milkdown-editor/plugins/bidi';

let editor: Editor | null = null;
afterEach(async () => {
  await editor?.destroy();
  editor = null;
});

async function mount(markdown: string): Promise<HTMLElement> {
  const root = document.createElement('div');
  editor = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, root);
      ctx.set(defaultValueCtx, markdown);
    })
    .use(commonmark)
    .use(bidiPlugins)
    .create();
  return root;
}

describe('editor paragraph direction', () => {
  it('a Hebrew bullet that opens with an English word stays RTL', async () => {
    const root = await mount('- Hub: קוד אבטחה דורש אישור מפורש, בכל שינוי.\n- oss: data drivers\n');
    const [hebrew, english] = root.querySelectorAll('li > p');
    expect(hebrew.getAttribute('dir')).toBe('rtl');
    expect(english.getAttribute('dir')).toBe('ltr');
  });

  it('inline code does not vote', async () => {
    const root = await mount('נשמר דרך `flow_sdk schema data_spec register_builtin_kinds`\n');
    expect(root.querySelector('p')?.getAttribute('dir')).toBe('rtl');
  });

  it('an explicit dir wins', async () => {
    const root = await mount('<p dir="ltr">\n\nשלום עולם\n\n</p>\n');
    expect(root.querySelector('p')?.getAttribute('dir')).toBe('ltr');
  });
});
