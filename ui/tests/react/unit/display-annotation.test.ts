import { describe, expect, it } from 'vitest';
import { ViewType } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import {
  buildDisplayAnnotationPrompt,
  displayAnnotationContextForDock,
  displayAnnotationContextForPath,
  displayAnnotationContextForWebapp,
  displayAnnotationImageName,
} from '@src/pages/flow-page/display-annotation';

describe('display annotation prompts', () => {
  it('builds a website instruction for the active agent', () => {
    const context = displayAnnotationContextForWebapp('/api/v1/get-host?port=3300', 3300);
    const prompt = buildDisplayAnnotationPrompt({
      fileName: 'website-annotation.png',
      filePath: '/tmp/agent-input/website-annotation.png',
      context,
    });

    expect(prompt).toContain('Target kind: website.');
    expect(prompt).toContain('Apply the annotation to the website/web app currently shown in the active display.');
    expect(prompt).toContain('Target URL: /api/v1/get-host?port=3300');
    expect(prompt).toContain('Target port: 3300');
    expect(prompt).toContain('File path: /tmp/agent-input/website-annotation.png');
  });

  it('builds a Markdown document instruction for the active agent', () => {
    const context = displayAnnotationContextForPath('/Users/test/project/docs/overview.md');
    const prompt = buildDisplayAnnotationPrompt({
      fileName: 'markdown-annotation.png',
      filePath: '/tmp/agent-input/markdown-annotation.png',
      context,
    });

    expect(context.kind).toBe('markdown-document');
    expect(prompt).toContain('Target kind: Markdown document.');
    expect(prompt).toContain('Apply the annotation to the Markdown document currently shown in the active display.');
    expect(prompt).toContain('Target path: /Users/test/project/docs/overview.md');
    expect(prompt).toContain('File path: /tmp/agent-input/markdown-annotation.png');
  });

  it('recognizes Markdown asset child docks as Markdown document targets', () => {
    const dock = new DockPointer(
      ViewType.ASSETS,
      'editor/markdown/vfs/compute_node-@local/Users/test/project/docs/overview.md',
    );
    const context = displayAnnotationContextForDock(dock);

    expect(context.kind).toBe('markdown-document');
    expect(context.path).toBe('compute_node-@local/Users/test/project/docs/overview.md');
  });

  it('uses target-specific screenshot filenames', () => {
    const date = new Date('2026-07-05T12:34:56.789Z');

    expect(displayAnnotationImageName(displayAnnotationContextForWebapp(null, 5173), date)).toBe(
      'website-website-on-port-5173-2026-07-05T12-34-56-789Z.png',
    );
    expect(displayAnnotationImageName(displayAnnotationContextForPath('/tmp/spec.md'), date)).toBe(
      'markdown-document-tmp-spec-md-2026-07-05T12-34-56-789Z.png',
    );
  });
});
