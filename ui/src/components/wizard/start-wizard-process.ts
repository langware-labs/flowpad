import {
  Wizard,
  AgenticProcess,
  ComputeNode,
  ProcessKind,
  apiClient,
  awaitWizardResult,
  buildWizardPrompt,
  dataManager,
  type WizardLaunchRequest,
  type WizardProcessResult,
} from '@sdk';

import { systemSubagentRef } from '@src/pages/flow-page/vibe-personas';

let wizardAgentRefCache: Record<string, string | null> = {};

/** Resolve a wizard's driving agent by wizard name → the agent's `asset_ref`.
 *
 *  Two hops, and the first one is the migration: a wizard is a WIZARD ASSET
 *  (`agentic-assets/wizard/<name>/wizard.json`) that DECLARES the agent driving
 *  it, and only then do we look that agent up. It used to be one hop on an
 *  assumption — the wizard name WAS an agent name, with no declaration anywhere
 *  — so a wizard had no description, no icon, and nothing to open in the UI.
 *
 *  System (SDK-shipped) rows only surface with `include_system`, which the entity
 *  query layer omits, so the first hop passes the flag as `params`.
 *
 *  Returns null when the name matches no wizard, or when the wizard names no
 *  agent. Callers MUST treat that as fatal — see `startWizardProcess`. */
export async function resolveWizardAgentRef(name: string): Promise<string | null> {
  if (name in wizardAgentRefCache) return wizardAgentRefCache[name];

  const wizardRows = await apiClient.get<unknown[]>('/graph/wizard', {
    params: { include_system: true },
  });
  const wizards = (wizardRows ?? []).map((row) => dataManager.updateEntityFromJson<Wizard>(row));
  // `agent` is a computed field carrying what the document DECLARES: the agent
  // that drives this conversation. Empty for a stepped wizard, which the backend
  // runner runs instead — so those correctly resolve to nothing here.
  const agentName = wizards.find((w) => w.name === name)?.agent ?? null;
  if (!agentName) return null;

  // `systemSubagentRef` is the existing resolver for this exact question, and
  // reusing it fixes two things a hand-rolled copy got wrong. It queries
  // `/graph/subagent` — `.claude/agents/*.md` is the SubAgent family (see
  // docs/glossary.md) and `loadEmbeddedSubagent` embeds one of those, whereas
  // this used to ask `/graph/agent`, so three of the four wizards resolved to
  // nothing and every launch threw "No wizard named … is installed". And it
  // filters `scope === 'system'`, so a project sub-agent that happens to be
  // called `task-analyze` cannot shadow the shipped one.
  const ref = await systemSubagentRef(agentName);
  // HITS only. The one caller answers `null` by clearing the cache, so a stored
  // miss could never be read back.
  if (ref) wizardAgentRefCache = { ...wizardAgentRefCache, [name]: ref };
  return ref;
}

/** Forget the cached name→ref answers. */
export function clearWizardAgentRefCache(): void {
  wizardAgentRefCache = {};
}

export interface StartedWizard<T = unknown> {
  process: AgenticProcess;
  /** The `target_typeid_str` a modal viewer (EntityExecutionPanel) attaches to. */
  target: string;
  /** Resolves when the agent runs `flow wizard <id> close` (via `wizard.closed`)
   *  or the initial prompt fails. */
  result: Promise<WizardProcessResult<T>>;
}

/**
 * Create a headless `ProcessKind.Wizard` process, embed the same-named agent,
 * and fire the initial prompt.
 *
 * This is the shared engine behind BOTH the modal `WizardHost` (double-click)
 * and the inline `useWizardRun` button (single-click headless). The process is
 * always headless (`visible:false`); whether a modal viewer mounts on it is the
 * caller's choice — that's the only difference between the two paths.
 */
export async function startWizardProcess<T = unknown>(
  request: WizardLaunchRequest,
  opts?: { headless?: boolean },
): Promise<StartedWizard<T>> {
  const headless = opts?.headless ?? false;
  const computeNode = await ComputeNode.getById('@local');
  if (!computeNode) throw new Error('No local compute node');

  // Prefer a STABLE target (the subject entity's TypeId) so the run is
  // reconnectable via useProcessesForTarget regardless of whether the agent got
  // around to stamping process_id. Fall back to a unique key when no subject.
  const target = request.wizardData?.targetTypeId?.trim() || `wizard:${request.wizardName}:${Date.now()}`;

  // Resolved BEFORE the process exists, and fatal when it misses.
  //
  // This used to sit after createProcess and merely `console.warn`, so a
  // mistyped or unindexed wizard name produced a REAL process running the
  // wizard prompt with no agent embedded: it answered as a generic assistant,
  // never ran `flow wizard … close`, and the caller's promise hung forever with
  // a warning buried in the console. A name that resolves to nothing is a bug in
  // the caller, and the only useful thing to do with it is say so loudly before
  // anything is spawned.
  const agentRef = await resolveWizardAgentRef(request.wizardName);
  if (!agentRef) {
    // The cache stores misses too; drop it so a wizard indexed after this
    // failure is resolvable on the next attempt.
    clearWizardAgentRefCache();
    throw new Error(
      `No wizard named "${request.wizardName}" is installed. ` +
      'A wizard is a folder under agentic-assets/wizard/ whose wizard.json names ' +
      'the agent that drives it; check the name, or re-index if it was just added.',
    );
  }

  const process = await computeNode.createProcess(
    {
      targetVfsPath: target,
      processType: ProcessKind.Wizard,
      outputFormat: 'stream-json',
      loadFlowpadAssistant: true,
      // A wizard may pin its model tier; the backend resolves `sm`/`md`/`lg` per
      // worker into the concrete `--model` flag. Undefined leaves the default.
      model: request.wizardData?.model,
      contextData: {
        wizard: {
          name: request.wizardName,
          data: request.wizardData ?? null,
        },
      },
    },
    { visible: false, pty_mode: false },
  );

  const initialPrompt = buildWizardPrompt(process.id, request, { headless });
  // Subscribe for the close event BEFORE embedding/prompting so we can't miss it.
  const wizardClosed = awaitWizardResult<T>(process);

  // Embed the driving sub-agent before the prompt so it handles the turn.
  // `agentRef` was resolved above, so a failure here is a real embed failure
  // (a deleted asset, a backend error) rather than an unknown name.
  // `true` -- the wizard's declared agent IS the process's persona. It is the
  // only agent here, so it used to get the identity directive from the old
  // count-based rule; now it has to say so.
  await process.loadEmbeddedSubagent(agentRef, true);

  // `result` resolves on the FIRST of:
  //  - `wizard.closed` — the agent closed with its verdict (preferred; carries data);
  //  - prompt error — the turn failed;
  //  - (headless only) the prompt RESOLVING — the agent's turn ended cleanly.
  // The last one is the safety net: a headless run must not hang forever just
  // because the agent finished without closing the wizard (worker_status goes
  // `complete`, but no `wizard.closed` ever arrives). Modal runs deliberately
  // omit it — there the user closes via Done, so a bare turn-end must NOT end
  // the wizard.
  const result = new Promise<WizardProcessResult<T>>((resolve) => {
    void wizardClosed.then(resolve);
    void process
      .prompt(initialPrompt)
      .then(() => {
        if (headless) resolve({ status: 'done', data: null });
      })
      .catch((err) => {
        resolve({ status: 'error', data: null, errorStr: err instanceof Error ? err.message : String(err) });
      });
  });

  return { process, target, result };
}
