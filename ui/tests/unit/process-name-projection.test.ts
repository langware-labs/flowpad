import { AgenticProcess, dataManager } from '@sdk';
import { pickHistoryTitle } from '@src/components/entity-execution-panel/history-row';
import { resolveProcessDisplayName } from '@src/components/terminal/process-display-name';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { agenticProcessName } from '@src/navigation/agentic-process-open';
import { afterEach, describe, expect, it } from 'vitest';

const ID = 'f0167230-4fa7-4dc0-bfe0-f0d13f71a423';
const history = (name: string | null): WorkerHistoryEntry => ({
  worker_type: 'codex', worker_id: ID, agentic_process_id: ID,
  project_id: null, project_name: null, project_cwd: null,
  last_active_time: '', name, last_prompt: 'Later prompt must not become the title',
  git_branch: null, message_count: 2,
});

afterEach(() => dataManager.clearCache());

describe('backend process name projection', () => {
  it.each(['Chosen name', `agentic_process-${ID}`, ID, '123', 'Claude Code']) (
    'preserves explicit names across header, history and navigation: %s', (name) => {
      const process = new AgenticProcess({
        id: ID, name, context_data: { display_name: 'Stale context title' },
        instruction_content: 'Stale instruction title',
      });
      expect(resolveProcessDisplayName(process)).toBe(name);
      expect(pickHistoryTitle(process, history('Stale history title'))).toBe(name);
      expect(agenticProcessName(ID)).toBe(name);
    },
  );

  it('uses only the resolved history name while the process is not loaded', () => {
    expect(pickHistoryTitle(null, history('Provider title'))).toBe('Provider title');
    expect(pickHistoryTitle(null, history(null))).toBe(`Session ${ID.slice(0, 6)}`);
  });

  it('does not synthesize an unbound process name from legacy fields', () => {
    const process = new AgenticProcess({
      id: ID, context_data: { display_name: 'Legacy title' }, instruction_content: 'Prompt',
    });
    expect(resolveProcessDisplayName(process)).toBe('Session');
    expect(agenticProcessName(ID)).toBeNull();
    expect(pickHistoryTitle(process, history('Stale history title'))).toBe(`Session ${ID.slice(0, 6)}`);
  });
});
