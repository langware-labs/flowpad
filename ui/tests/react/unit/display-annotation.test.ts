import { describe, expect, it } from 'vitest';
import { ViewType } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import {
  buildDisplayAnnotationPrompt,
  displayAnnotationContextForDock,
  displayAnnotationContextForPath,
  displayAnnotationContextForWebsite,
  displayAnnotationImageName,
} from '@src/pages/flow-page/display-annotation';

describe('display annotation prompts', () => {
  it('builds a website instruction for the active agent', () => {
    const context = displayAnnotationContextForWebsite('http://localhost:3300/', {
      name: 'Todo app',
      typeid: 'service_endpoint-6ba7b810-9dad-41d1-80b4-00c04fd430c8',
    });
    const prompt = buildDisplayAnnotationPrompt({
      fileName: 'website-annotation.png',
      filePath: '/tmp/agent-input/website-annotation.png',
      context,
    });

    expect(prompt).toContain('Target kind: website.');
    expect(prompt).toContain('Apply the annotation to the website/web app currently shown in the active display.');
    expect(prompt).toContain('Target: Todo app.');
    expect(prompt).toContain('Target URL: http://localhost:3300/');
    // The endpoint the app was shown by — what the agent resolves the app from.
    expect(prompt).toContain('Target typeid: service_endpoint-6ba7b810-9dad-41d1-80b4-00c04fd430c8');
    expect(prompt).not.toContain('port');
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

    expect(displayAnnotationImageName(displayAnnotationContextForWebsite(null, { name: 'Todo app' }), date)).toBe(
      'website-todo-app-2026-07-05T12-34-56-789Z.png',
    );
    expect(displayAnnotationImageName(displayAnnotationContextForPath('/tmp/spec.md'), date)).toBe(
      'markdown-document-tmp-spec-md-2026-07-05T12-34-56-789Z.png',
    );
  });
});
