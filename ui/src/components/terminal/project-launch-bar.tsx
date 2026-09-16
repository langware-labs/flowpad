import { useLingui } from '@lingui/react/macro';
import { openTerminalFromComputeNode, workerLaunchCommandsFromComputeNode, type WorkerLaunchCommand } from '@sdk';
import { useContext } from '@src/hooks/useContext';
import { WORKER_LABELS, type WorkerType } from '@src/hooks/useWorkerHistory';
import { notify } from '@src/notifications';
import { providerKeyFor, providerMetaFor } from '@src/tabs/provider-meta';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * "Open this project OUTSIDE" — one glyph per harness plus the plain shell,
 * each launching that vendor's interactive CLI in a real OS terminal window
 * (Terminal.app / cmd / gnome-terminal) at the project's folder.
 *
 * It reads like the project home's "New session" bar and is deliberately NOT
 * one: those tiles start a Flowpad-owned PTY session, this one hands the same
 * command to the user's own shell and walks away. Nothing is created — no
 * AgenticProcess, no tab, no transcript. It is a debug affordance: the point is
 * to get the harness we would have run, where you can watch it.
 *
 * Which is why the commands are ASKED FOR rather than composed here. The
 * backend renders them from each vendor's real `AgentOptions` (see
 * `interactive_launch_command`), so what this bar launches cannot drift from
 * what the spawn path runs — the moment it could, the feature would be lying.
 * The full line is on every glyph's tooltip, so it can be read before it is run.
 *
 * It is NOT the same invocation as an in-app session, and can't be: the
 * process-scoped env (`FLOWPAD_EXECUTION_SCOPE`, secrets, the pinned `flow` on
 * PATH) and the per-process flags (`--add-dir`, `--agents`, `--mcp-config`)
 * only exist once there is a process. This starts a FRESH session in that
 * folder.
 */
export function ProjectLaunchBar({ projectPath }: { projectPath: string }) {
  const { t } = useLingui();
  const { computeNode } = useContext();
  const computeNodeId = computeNode?.id ?? null;
  const [commands, setCommands] = useState<WorkerLaunchCommand[] | null>(null);
  const [failed, setFailed] = useState(false);

  // Resolved per open, not once per session: a harness installed (or removed)
  // since the last hover changes the line, and `shutil.which` runs backend-side
  // on every ask. The card only mounts after the hover dwell, so this is one
  // small POST per project the pointer actually rests on.
  useEffect(() => {
    if (!computeNodeId || !projectPath) return;
    let cancelled = false;
    setFailed(false);
    void workerLaunchCommandsFromComputeNode(computeNodeId, projectPath)
      .then((rows) => {
        if (!cancelled) setCommands(rows);
      })
      .catch((error: unknown) => {
        console.error('[ProjectLaunchBar] failed to resolve launch commands:', error);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [computeNodeId, projectPath]);

  if (!computeNodeId || !projectPath) return null;

  if (failed) {
    return (
      <span className="text-[10px] text-muted-foreground">
        {t`Couldn't resolve the launch commands for this folder`}
      </span>
    );
  }

  if (!commands) {
    return (
      <span className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t`Resolving launch commands…`}
      </span>
    );
  }

  const runInOsTerminal = (command: string) => {
    // No `cwd`: the command the backend rendered already carries its own `cd`,
    // quoted for that platform's shell. Passing both would `cd` twice.
    void openTerminalFromComputeNode(computeNodeId, command).catch((error: unknown) => {
      notify.error({
        title: t`Couldn't open a terminal`,
        message: error instanceof Error ? error.message : String(error),
        id: `project-launch-bar:${computeNodeId}`,
      });
    });
  };

  return (
    <div className="flex items-center gap-0.5" data-testid="project-launch-bar">
      {commands.map(({ key, command }) => {
        // Glyph and tint from the ONE vendor presentation table — the same mark
        // the tab strip and the session bar draw, never a lookalike picked here.
        const meta = providerMetaFor(key);
        // `shell` is a real row in that table but not a vendor, so it has no
        // entry in the worker-label map; it is the terminal itself.
        const providerKey = providerKeyFor(key);
        const vendorLabel = WORKER_LABELS[providerKey as WorkerType] as string | undefined;
        const label = vendorLabel
          ? t`Open ${vendorLabel} in an OS terminal here`
          : t`Open an OS terminal here`;
        return (
          <button
            key={key}
            type="button"
            onClick={() => runInOsTerminal(command)}
            aria-label={label}
            // The command itself is the tooltip: this is a debug affordance, and
            // "what exactly will run" is the thing being debugged.
            title={`${label}\n\n${command}`}
            data-testid={`project-launch-${key}`}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <meta.Icon className={`h-3.5 w-3.5 shrink-0 ${meta.iconClassName}`} />
          </button>
        );
      })}
    </div>
  );
}
