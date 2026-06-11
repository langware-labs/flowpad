import type { AgenticProcess, Shell as ShellEntity } from '@sdk';
import { Shell } from '@sdk';
import type { TerminalTab } from '@src/tabs/useTabs';

const TYPEID_RX = /^[a-z][a-z0-9_-]*-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function allowRename(name: string | null | undefined): boolean {
  const n = (name ?? '').trim();
  if (!n) return false;
  if (TYPEID_RX.test(n)) return false;
  if (n.includes('Claude Code')) return false;
  return true;
}

/** Find the first available "Tab N" name, filling gaps from closed tabs.
 *  Lives here (not in TabbedTerminal.tsx) so component files export only
 *  components — mixed exports break Vite Fast Refresh and escalate every
 *  HMR update to a full page reload. */
export function nextTerminalName(sessions: { name: string }[]): string {
  const usedNumbers = new Set<number>();
  sessions.forEach((s) => {
    const match = s.name.match(/^Tab (\d+)$/);
    if (match) usedNumbers.add(parseInt(match[1], 10));
  });
  let n = 1;
  while (usedNumbers.has(n)) n++;
  return `Tab ${n}`;
}

function isCodexProcess(process?: AgenticProcess | null): boolean {
  return process?.worker_type?.trim().toLowerCase() === 'codex';
}

function isCopilotProcess(process?: AgenticProcess | null): boolean {
  return process?.worker_type?.trim().toLowerCase() === 'copilot';
}

/** PTY OSC title auto-save rule: plain shells and Claude processes only
 *  (Codex/Copilot emit unstable titles). Same Fast Refresh rationale as
 *  nextTerminalName for living in this module. */
export function shouldAutoSavePtyTitle(session: TerminalTab, process?: AgenticProcess | null): boolean {
  const resolvedProcess = process ?? session.agenticProcess ?? null;
  if (!resolvedProcess) return session.targetTypeId.type === Shell.type;
  return !isCodexProcess(resolvedProcess) && !isCopilotProcess(resolvedProcess);
}
