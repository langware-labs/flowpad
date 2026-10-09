/**
 * `useAgentContext` names the process from the URL, on the first render.
 *
 * It used to fall back to `dataContext.agenticProcess` — a global that does not
 * re-render. A view that rendered before the loader set it kept no process for
 * good: a lesson shown in a vibe display never learned which chat it sat beside,
 * so its "Neti explains" button had nowhere to send. Off a process URL the same
 * global handed out whatever process was opened last.
 */
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The global holds some OTHER process throughout — the one opened last.
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dataContext: {
    agenticProcess: { id: '11111111-2222-4333-8444-555555555555' },
    activeEntity: null,
    computeNode: null,
    project: null,
  },
}));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useEntity: () => ({ data: null }),
}));

import { useAgentContext } from '@src/contexts/agent-context';

const ID = '66f10de3-5baa-4435-9035-e95b6d116691';
const PROJECT = '562cef65-e039-45e5-a8a4-88283d6666bf';

function flowIdsAt(url: string): (string | null)[] {
  const seen: (string | null)[] = [];
  function Probe() {
    seen.push(useAgentContext().flowId);
    return null;
  }
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/dock/:viewType/*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
  return seen;
}

describe('useAgentContext flowId', () => {
  afterEach(cleanup);

  it('reads the host from a vibe display url on the first render', () => {
    const url =
      `/dock/project/${PROJECT}/process/agentic_process-${ID}/display/editor/html/vfs/` +
      'compute_node-%40local/Users/u/course/index.html?viewMode=vibe&activeDisplay=1';
    expect(flowIdsAt(url)[0]).toBe(ID);
  });

  it("reads the process's own shell dock", () => {
    expect(flowIdsAt(`/dock/shell/agentic_process-${ID}`)[0]).toBe(ID);
  });

  it('ignores a stale process in dataContext when the url names none', () => {
    expect(flowIdsAt('/dock/editor/html/vfs/compute_node-%40local/tmp/page.html').every((id) => id === null)).toBe(
      true,
    );
  });
});
