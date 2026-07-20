import type { AgenticProcess } from '@sdk';
import type { Shell } from '@sdk/entities/shell';

export interface ProcessEntry {
  process: AgenticProcess;
  /**
   * Only set for Interactive-mode (PTY) entries. CLI-mode runs (post the CLI-mode switch) leave this undefined — the status line + navigation
   * flow handle the terminal attach on demand.
   */
  shell?: Shell;
}
