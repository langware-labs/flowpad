/**
 * Returning to Vibe from the terminal must show the turn the terminal produced.
 *
 * Reported symptom: start a session in Vibe, send a message; switch to the
 * terminal and send another there; come back to Vibe — the terminal's message
 * and its answer are simply not in the chat, and stay missing.
 *
 * The surfaces are two TRANSPORTS of one session (same session_id, one
 * transcript). Vibe renders `flowDataStream`, which is fed by `prompt()` for a
 * turn this client sent and by `observeTurn()` for one it is watching — neither
 * covers a turn that ran to completion while the Vibe pane was off screen. The
 * only thing that can recover it is a transcript reconcile
 * (`loadHistory({ force: true })`) when the surface comes back.
 *
 * Entry point is the real one: `useProcessSurface` (mounted by `vibe-workspace`
 * at the session, and by `TabbedTerminal` for the terminal) driven by a real
 * `?viewMode=` dock URL — the only thing the footer ViewToggle does on a dock
 * route is navigate to the same pointer with the new mode. The rendered node is
 * what the Vibe chat pane renders: `useAgenticProcessStream` items, plus the
 * mount-time `loadHistory()` the panel issues.
 *
 * No mocks: one real claude worker, a real headless→PTY `switchMode`, and the
 * second turn delivered to the PTY through `submit()` — which does NOT stream
 * back to this client, exactly like a human typing into the xterm. Backend
 * ground truth for "the terminal turn really happened" is `get-history`, not a
 * UI heuristic.
 *
 * Backend = FLOW_INSTANCE. Spawns one real worker.
 */
import React, { useEffect } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import {
  AgenticProcess,
  ComputeNode,
  GRAPH_API_PREFIX,
  WorkerModelTier,
  apiClient,
  dataContext,
  isReadyForInput,
} from '@sdk';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { useProcessSurface } from '@src/components/terminal/interactive-terminal/use-process-surface';
import { useAgenticProcessStream } from '@src/hooks/use-agentic-process-stream';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const BOOT_MS = 60_000;
const TURN_MS = 90_000;
/** Generous room for the ONE async reconcile the return is allowed to make. */
const RECONCILE_MS = 20_000;

/**
 * The Vibe session surface, reduced to the two things that decide what the user
 * sees: the transport reconciler `vibe-workspace` mounts around the session, and
 * the stream + mount-time history load `EntityExecutionPanel` renders it from.
 */
function VibeSurface({ process }: { process: AgenticProcess | null }) {
  useProcessSurface({ process });
  const items = useAgenticProcessStream(process);
  useEffect(() => {
    void process?.loadHistory().catch(() => undefined);
  }, [process]);
  return <div data-testid="vibe-chat">{items.map((item) => item.content ?? '').join('\n')}</div>;
}

describe('vibe ⇄ terminal — the terminal turn is there when Vibe comes back', () => {
  let ap: AgenticProcess | null = null;

  beforeAll(async () => {
    await apiTestSetup(getTestSignupInfo());
  }, 60_000);

  afterAll(async () => {
    cleanup();
    try {
      await ap?.stop();
    } catch {
      /* best-effort */
    }
  });

  it(
    'shows the message typed in the terminal after switching back to vibe',
    async () => {
      const cn = dataContext.computeNode as ComputeNode;
      expect(cn, 'compute node from apiTestSetup').toBeTruthy();

      // A Vibe session is born headless — the PTY only appears when the user
      // asks for the terminal (that is the switch under test).
      ap = await cn.createProcess(
        { workerType: 'claude_code', model: WorkerModelTier.SM, permissionMode: 'bypassPermissions' },
        {
          pty_mode: false,
          visible: false,
          launchPrompt: 'You are a counter. When asked, reply with ONLY the exact token you are given.',
        },
      );
      await vi.waitFor(() => expect(ap!.session_id).toBeTruthy(), { timeout: BOOT_MS, interval: 500 });

      const stamp = ap.id.replace(/-/g, '').slice(0, 6).toUpperCase();
      const VIBE_TOKEN = `VIBE${stamp}END`;
      const TERM_TOKEN = `TERM${stamp}END`;
      const say = (token: string) => `Reply with ONLY this exact token and nothing else: ${token}`;

      /** Mount the session at a dock URL carrying `?viewMode=<mode>` — what the
       *  footer ViewToggle navigates to, and what swaps the surface on screen. */
      const openAt = (mode: string) =>
        render(
          <MemoryRouter initialEntries={[`/dock/shell/agentic_process-${ap!.id}?viewMode=${mode}`]}>
            <Routes>
              <Route path="/dock/:viewType/*" element={<VibeSurface process={ap} />} />
            </Routes>
          </MemoryRouter>,
        );
      const chatText = () => screen.getByTestId('vibe-chat').textContent ?? '';

      // ── 1. A first turn, then open Vibe on it. The pane fills itself from the
      //      transcript on mount (`EntityExecutionPanel`'s loadHistory), which
      //      also latches `_historyLoaded` — the latch that makes every later
      //      plain load a no-op, and the reason a remount cannot self-heal.
      await ap.submit(say(VIBE_TOKEN));
      const entityUrl = `${GRAPH_API_PREFIX}/${AgenticProcess.type}/${ap.id}`;
      const historyUrl = `${entityUrl}/get-history`;
      const transcript = async (): Promise<string> => {
        const res: any = await apiClient.get(historyUrl).catch(() => null);
        return JSON.stringify(res?.history ?? []);
      };
      const transcriptHas = async (token: string) => expect(await transcript()).toContain(token);
      /** Same ground truth as `transcriptHas`, as a predicate a retry can branch on. */
      const inTranscript = async (token: string): Promise<boolean> => (await transcript()).includes(token);
      await vi.waitFor(() => transcriptHas(VIBE_TOKEN), { timeout: TURN_MS, interval: 2_000 });

      const vibeView = openAt('vibe');
      await vi.waitFor(() => expect(chatText()).toContain(VIBE_TOKEN), { timeout: RECONCILE_MS, interval: 250 });

      // ── 2. Switch to the terminal. The Vibe surface leaves the screen and the
      //      terminal surface takes over — a real headless→PTY transport switch.
      vibeView.unmount();
      const termView = openAt('advanced');
      // Backend ground truth, not a UI heuristic: the transport really is a PTY
      // and the resumed worker is back at its prompt. (Also the proof that the
      // surface reached the reconciler at all — nothing else flips pty_mode.)
      await vi.waitFor(
        async () => {
          const row: any = await apiClient.get(entityUrl).catch(() => null);
          expect(row?.pty_mode, 'switched to the PTY transport').toBe(true);
          expect(isReadyForInput(row), `PTY ready (status=${row?.status} worker=${row?.worker_status})`).toBe(true);
        },
        { timeout: BOOT_MS, interval: 1_000 },
      );

      // ── 3. Type the next message in the terminal. `submit()` on a PTY process
      //      goes to the terminal's stdin and streams nothing back here — the
      //      same position a human at the xterm leaves this client in.
      //      Typing at a TUI that has resumed but not finished painting its
      //      input box is silently dropped (the same terminal-input drop
      //      `chat_terminal_switch_stress` documents), so confirm both that the
      //      keystrokes reached the terminal — the PTY echoes what was typed —
      //      AND that the turn actually left the composer, before waiting on it.
      //      This gates the SETUP, not the symptom.
      const shellId: string = String(((await apiClient.get(entityUrl)) as any)?.shell_id ?? '');
      expect(shellId, 'PTY shell bound').toBeTruthy();
      const ptyShows = async (token: string): Promise<boolean> => {
        const stream: any = await apiClient.get(`/shell/${shellId}/pty-stream`).catch(() => null);
        const dec = new TextDecoder('utf-8', { fatal: false });
        const text = (stream?.events ?? [])
          .filter((e: any[]) => e[0] === 'o' && typeof e[1] === 'string')
          .map((e: any[]) => dec.decode(Uint8Array.from(atob(e[1]), (c: string) => c.charCodeAt(0)), { stream: true }))
          .join('');
        return text.includes(token);
      };
      await ap.submit(say(TERM_TOKEN));
      await vi.waitFor(async () => expect(await ptyShows(TERM_TOKEN)).toBe(true), {
        timeout: 20_000,
        interval: 1_000,
      });

      // The echo above proves the KEYSTROKES landed — it cannot prove the turn
      // was SENT, because a terminal echoes what you type whether or not the
      // Enter took. A TUI still painting (`/rc connecting…` in the status bar)
      // swallows exactly that Enter, leaving the message drafted in the
      // composer forever: typed, echoed, never run. Ground truth for "sent" is
      // therefore the transcript, and the repair is a discrete Enter — a bare
      // `submit()` fires whatever is already staged in the input, and is a
      // harmless no-op once the turn is away.
      for (let attempt = 0; attempt < 4 && !(await inTranscript(TERM_TOKEN)); attempt++) {
        await ap.submit();
        await vi.waitFor(async () => expect(await inTranscript(TERM_TOKEN)).toBe(true), {
          timeout: 15_000,
          interval: 1_000,
        }).catch(() => undefined);
      }
      expect(await inTranscript(TERM_TOKEN), 'the terminal turn was submitted, not left in the composer').toBe(true);
      await vi.waitFor(() => transcriptHas(TERM_TOKEN), { timeout: TURN_MS, interval: 2_000 });

      // ── 4. Back to Vibe.
      termView.unmount();
      openAt('vibe');
      await act(async () => {});

      // The whole session is one conversation: both turns belong in the chat.
      await vi.waitFor(() => expect(chatText()).toContain(TERM_TOKEN), {
        timeout: RECONCILE_MS,
        interval: 250,
      });
      expect(chatText(), 'the vibe turn is still there too').toContain(VIBE_TOKEN);
    },
    240_000,
  );
});
