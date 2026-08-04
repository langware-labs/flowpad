import type { AgenticProcess } from '@sdk';
import { Shell } from '@sdk';

// `[45]` for the version nibble, matching the entity-id policy (ids are UUID v4
// or v5 — CLAUDE.md) and the SDK's own shape source (`ts_sdk/src/models/TypeId.ts`
// `uuidRegex`). Pinning `4` here let a v5-shaped `skill-<uuid>` through as a
// "label", which is exactly the address-as-a-name case these rules reject.
const TYPEID_RX = /^[a-z][a-z0-9_-]*-[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Strip the decoration PTY tools interleave with the real OSC title —
 *  spinner frames (Braille/box glyphs), emoji/icons, rotation arrows, ANSI
 *  escapes, and control bytes — so the durable name reflects only stable text.
 *  Script-agnostic: it removes symbols, never letters, so RTL/CJK titles pass
 *  through intact. Pair with the `\p{L}` gate in `allowRename`. */
export function cleanTitle(name: string | null | undefined): string {
  return (
    (name ?? '')
      // eslint-disable-next-line no-control-regex -- intentionally strips ANSI/control bytes
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // ANSI CSI escape sequences
      // eslint-disable-next-line no-control-regex -- intentionally strips ANSI/control bytes
      .replace(/[\x00-\x1f\x7f-\x9f]/g, '') // C0/C1 control chars, BEL, CR/LF
      .replace(/[⠀-⣿]/g, '') // Braille spinner block (⠋⠙⠹⠸)
      .replace(/[\p{Extended_Pictographic}\p{So}\p{Sk}]/gu, '') // emoji/icons/symbols
      .replace(/\uFE0F/g, '') // emoji variation selector
      .replace(/[←-⇿─-╿]/g, '') // arrows/rotations, box-drawing
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** True when a name is shaped like a TypeId — an address, not a label.
 *
 *  Exported because both rename paths must reject it and they no longer share
 *  code: the PTY auto-title mirror gates on `allowRename` below, while a USER
 *  rename goes TabStrip → the strip owner's `onRename`. The unified-tab-strip
 *  refactor moved the user path off `TabbedTerminal` and the check did not come
 *  with it. */
export function isTypeIdLikeName(name: string | null | undefined): boolean {
  return TYPEID_RX.test(cleanTitle(name));
}

export function allowRename(name: string | null | undefined): boolean {
  const n = cleanTitle(name);
  if (!n) return false;
  if (!/\p{L}/u.test(n)) return false; // must carry a real letter in some script
  if (isTypeIdLikeName(n)) return false; // `cleanTitle` is idempotent, so re-cleaning is free
  if (n.includes('Claude Code')) return false;
  return true;
}

/** OS default console title: an absolute path to the spawned executable
 *  (e.g. `C:\WINDOWS\system32\cmd.exe`), emitted before the program says
 *  anything. Deliberately Windows-shaped — unix shells title with the cwd,
 *  which IS a meaningful title. */
const EXE_PATH_RX = /^(?:[a-z]:[\\/]|\\\\)[^:*?"<>|]*\.exe$/i;

/** True when a (cleaned) OSC title is merely the running program announcing
 *  itself — the worker CLI's startup title (`claude`) or the console's default
 *  exe-path title — rather than a tag. Identity titles say nothing about the
 *  session, but a worker re-emits one on every restart; adopting it would
 *  clobber a tag-derived name (the "session renamed itself to claude" bug).
 *  Applies only to the auto-title mirror: a user manually naming a tab
 *  "claude" goes through `Tab.rename`, not this gate. */
export function isProgramIdentityTitle(title: string, process?: AgenticProcess | null): boolean {
  const n = cleanTitle(title).toLowerCase();
  if (!n) return false;
  if (EXE_PATH_RX.test(n)) return true;
  const worker = process?.worker_type?.trim().toLowerCase();
  return !!worker && (n === worker || n === `${worker}.exe`);
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

/** PTY OSC title auto-save rule: a plain shell always auto-titles; a process
 *  auto-titles unless it is Codex/Copilot (they emit unstable titles). The Tab
 *  body renders from `TabRow` + the panel's live entity, so the rule keys on the
 *  target type + that entity, not a `TerminalTab`. */
export function shouldAutoSaveTitleForTarget(
  targetType: string | null | undefined,
  process?: AgenticProcess | null,
): boolean {
  if (!process) return targetType === Shell.type;
  return !isCodexProcess(process) && !isCopilotProcess(process);
}
