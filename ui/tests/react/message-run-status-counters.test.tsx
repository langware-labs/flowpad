/**
 * MessageRunStatus renders the live agent-progress counters one-liner from the
 * run's backend-computed `statusReport`. The exact numbers match the backend
 * fixture totals (test_process_counters.py) — proving the projection reaches
 * the rendered pixel unchanged.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { AgenticProcess } from '@sdk';
import { AttachmentType } from '@sdk';
import { MessageRunStatus } from '@src/components/conversation/MessageRunStatus';

const EXECUTED_FM = {
  attachment: [{ attachment_type: AttachmentType.PROMPT }],
} as any;

function runWithReport(counters: Record<string, number> | null, id: string) {
  return new AgenticProcess({
    id,
    status: 'running',
    status_report: counters
      ? { counters, focused_asset: null, worker_status: 'thinking', process_status: 'running' }
      : null,
  });
}

describe('MessageRunStatus counters one-liner', () => {
  it('renders the exact token/message counts from statusReport', () => {
    const run = runWithReport({
      input_tokens: 8,
      output_tokens: 4331,
      cache_read_tokens: 215526,
      cache_write_tokens: 3941,
      assistant_messages: 3,
      tool_calls: 1,
    }, '44444444-4444-4444-8444-444444444444');
    render(<MessageRunStatus fm={EXECUTED_FM} run={run} />);
    // total = 223806 → "224k tok · 3 msgs"
    expect(screen.getByTestId('message-run-counters').textContent).toBe('224k tok · 3 msgs');
  });

  it('hides the counters until there is a non-empty snapshot', () => {
    const run = runWithReport(null, '55555555-5555-4555-8555-555555555555');
    render(<MessageRunStatus fm={EXECUTED_FM} run={run} />);
    expect(screen.queryByTestId('message-run-counters')).toBeNull();
  });
});
