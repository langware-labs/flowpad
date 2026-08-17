import { SubAgent, apiClient, dataManager, Skill } from '@sdk';
import { isAgentSpawn, isSkillCall } from '@sdk/utils/agent-transcript';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useTranscript, type WorkerType } from '@src/hooks/use-transcript';
import { cn } from '@src/lib/utils';
import { useQuery } from '@tanstack/react-query';
import { Bot, Sparkles } from 'lucide-react';
import { useMemo } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/** Entity shape this panel resolves names against — both Skill and SubAgent fit. */
type NamedAsset = { name?: string; asset_ref?: string };

/**
 * Fetch a `<type>` entity list (with system entries) and index it by name, so a
 * transcript's skill/agent name string resolves to its on-disk asset_ref. Uses
 * the raw graph route with include_system=true — useEntitiesQuery omits that
 * flag, dropping SDK-shipped system skills/agents (mirrors SkillsCategory).
 */
function useAssetsByName<T extends NamedAsset>(type: 'skill' | 'subagent'): Map<string, T> | undefined {
  return useQuery<Map<string, T>>({
    queryKey: ['skills-agents-panel', type],
    queryFn: async () => {
      const rows = await apiClient.get<Partial<T>[]>(`/graph/${type}?include_system=true`);
      const map = new Map<string, T>();
      for (const row of rows ?? []) {
        const entity = dataManager.updateEntityFromJson<T>(row);
        if (entity.name) map.set(entity.name, entity);
      }
      return map;
    },
    staleTime: 30_000,
  }).data;
}

interface Props {
  /** Raw process `worker_type` (e.g. 'claude_code'); normalized to the route vendor. */
  workerType: string | null | undefined;
  /** Session id of the live process; the server resolves the transcript JSONL. */
  sessionId: string | null;
}

/**
 * Map a process `worker_type` onto the three transcript route vendors. Mirrors
 * `AgenticProcess.transcriptDockPointer` — anything that isn't codex/copilot is
 * claude (covers 'claude_code', unset, etc.).
 */
/** Map a process's raw worker string onto the transcript route's value space.
 *  Every vendor the server whitelists (`_SUPPORTED_WORKERS` in
 *  `routes/transcripts.py`) needs a branch: the fall-through is `'claude'`, so a
 *  missing vendor silently fetches the WRONG transcript rather than erroring. */
function normalizeWorkerType(raw: string | null | undefined): WorkerType {
  const wt = (raw ?? 'claude').toLowerCase();
  if (wt === 'codex') return 'codex';
  if (wt === 'copilot') return 'copilot';
  if (wt === 'opencode') return 'opencode';
  return 'claude';
}

/** A used skill / sub-agent, deduped by name with an invocation count. */
interface UsedItem {
  name: string;
  count: number;
  /** Canonical on-disk path to the backing entity, when it resolves to one. */
  assetRef?: string;
}

/** Collapse a list of invocations down to one row per name, counting repeats. */
function dedupeByName(
  names: string[],
  resolveRef: (name: string) => string | undefined,
): UsedItem[] {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count, assetRef: resolveRef(name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Skills & Agents side window — fetches the current session's transcript (the
 * same lens path as the transcript viewer) and lists every skill and sub-agent
 * invoked during the run. Rows that resolve to a backing entity navigate to its
 * asset page on click; built-in sub-agents (general-purpose, Explore, …) and
 * any unresolved skill render as non-clickable muted rows.
 *
 * Advanced-mode only — gated by the `advancedOnly` flag on its SIDE_TABS entry.
 */
export function SkillsAgentsPanel({ workerType, sessionId }: Props) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { data, isLoading, error } = useTranscript({
    workerType: normalizeWorkerType(workerType),
    sessionId: sessionId ?? undefined,
  });

  const skillByName = useAssetsByName<Skill>('skill');
  const agentByName = useAssetsByName<SubAgent>('subagent');

  const skills = useMemo<UsedItem[]>(() => {
    if (!data) return [];
    const names = data.entries.filter(isSkillCall).map((e) => e.skill_name);
    return dedupeByName(names, (n) => skillByName?.get(n)?.asset_ref);
  }, [data, skillByName]);

  const agents = useMemo<UsedItem[]>(() => {
    if (!data) return [];
    const names = data.entries.filter(isAgentSpawn).map((e) => e.agent_type);
    return dedupeByName(names, (n) => agentByName?.get(n)?.asset_ref);
  }, [data, agentByName]);

  const open = (type: 'skill' | 'subagent', assetRef?: string) => {
    if (!assetRef) return; // unresolved → non-clickable
    navigation.openDock(DockPointer.forAssetEditor(type, assetRef));
  };

  if (!sessionId) {
    return <Empty><Trans>No session yet</Trans></Empty>;
  }
  if (isLoading && !data) {
    return <Empty><Trans>Loading transcript…</Trans></Empty>;
  }
  if (error) {
    return <Empty><Trans>Couldn’t load transcript</Trans></Empty>;
  }
  if (skills.length === 0 && agents.length === 0) {
    return <Empty><Trans>No skills or sub-agents used yet</Trans></Empty>;
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <Section
        title={t`Skills`}
        icon={Sparkles}
        items={skills}
        onOpen={(ref) => open('skill', ref)}
      />
      <Section
        title={t`Sub-agents`}
        icon={Bot}
        items={agents}
        onOpen={(ref) => open('subagent', ref)}
      />
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  items,
  onOpen,
}: {
  title: string;
  icon: typeof Sparkles;
  items: UsedItem[];
  onOpen: (assetRef?: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => {
          const clickable = Boolean(item.assetRef);
          return (
            <li
              key={item.name}
              onClick={clickable ? () => onOpen(item.assetRef) : undefined}
              title={clickable ? item.name : `${item.name} (no asset page)`}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                clickable
                  ? 'cursor-pointer text-muted-foreground hover:bg-muted hover:text-foreground'
                  : 'cursor-default text-muted-foreground/60',
              )}
            >
              <Icon className="h-3.5 w-3.5 flex-shrink-0" />
              <span className="truncate">{item.name}</span>
              {item.count > 1 && (
                <span className="ml-auto flex-shrink-0 text-xs text-muted-foreground/70">
                  ×{item.count}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-2 text-xs italic text-muted-foreground">{children}</div>
  );
}
