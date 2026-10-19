/**
 * MermaidChartView — RTL coverage.
 *
 *   1. Opening renders the diagram from CHART.md's mermaid fence and writes nothing.
 *   2. An edit to the source rewrites the chart's own fence in place — no auto block appended.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { renderMock } = vi.hoisted(() => ({
  renderMock: vi.fn(async (code: string, host: HTMLElement) => {
    host.innerHTML = `<svg data-testid="rendered">${code.length}</svg>`;
  }),
}));
vi.mock('@src/components/milkdown-editor/plugins/fence-render/renderers/mermaid', () => ({
  mermaidRenderer: { language: 'mermaid', render: renderMock },
}));

// eslint-disable-next-line import/first
import { MermaidChartView } from '@src/components/assets/editor/chart/MermaidChartView';

const DOC = '---\nformat: mermaid\n---\nIntro prose.\n\n```mermaid\nflowchart LR\n  a --> b\n```\n\nMore prose.\n';

function makeFsRef(files: Record<string, string>, writes: string[]) {
  return {
    path: '/w/p/agentic-assets/chart/net',
    child(name: string) {
      return {
        async readDocument() {
          return { body: files[name], fields: {}, revision: files[name] };
        },
        async updateDocument(patch: { body: string }) {
          files[name] = patch.body;
          writes.push(name);
          return { body: patch.body, fields: {}, revision: patch.body };
        },
      };
    },
    open: vi.fn(),
  } as unknown as import('@sdk').FSRef;
}

describe('MermaidChartView', () => {
  let files: Record<string, string>;
  let writes: string[];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderMock.mockClear();
    files = { 'CHART.md': DOC };
    writes = [];
  });
  afterEach(() => vi.useRealTimers());

  it('renders the diagram on open and writes nothing', async () => {
    render(<MermaidChartView fsRef={makeFsRef(files, writes)} />);
    await waitFor(() => expect(screen.getByTestId('rendered')).toBeInTheDocument());
    expect(renderMock.mock.calls[0][0]).toBe('flowchart LR\n  a --> b\n');
    expect((screen.getByTestId('chart-mermaid-source') as HTMLTextAreaElement).value).toContain('flowchart LR');
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
    });
    expect(writes).toHaveLength(0);
  });

  it('an edit rewrites the chart’s own fence in place', async () => {
    render(<MermaidChartView fsRef={makeFsRef(files, writes)} chart={{ markEdit: vi.fn() } as unknown as import('@sdk').Chart} />);
    const source = await screen.findByTestId('chart-mermaid-source');
    fireEvent.change(source, { target: { value: 'flowchart LR\n  a --> c\n' } });
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    await waitFor(() => expect(writes).toEqual(['CHART.md']));
    expect(files['CHART.md']).toBe(DOC.replace('a --> b', 'a --> c'));
    expect(files['CHART.md']).not.toContain('chart:auto');
  });
});
