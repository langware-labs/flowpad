/**
 * "Then" — what the automation does. Run an agent with a prompt (the common
 * case), or run a script; steps the builder cannot edit (a built-in step, a
 * wizard it opens) are listed and kept as they are.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Agent, QueryRequest, type ThenPart } from '@sdk';
import { AlertTriangle } from 'lucide-react';
import { useMemo } from 'react';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { cn } from '@src/lib/utils';
import type { AutomationDraft, ThenChoice } from '../automation-draft';
import { useAutomationWords } from '../automation-words';
import { Pills } from '../Pills';
import { Block } from './WhenBlock';

const ALL_AGENTS = new QueryRequest({ type: Agent.type, scope: [], name: 'automations:agents' });

interface ThenBlockProps {
  draft: AutomationDraft;
  onChange: (next: AutomationDraft) => void;
  readOnly?: boolean;
  /** The backend's reading of the saved steps — names for the kept ones. */
  savedThen?: ThenPart[];
}

export function ThenBlock({ draft, onChange, readOnly, savedThen }: ThenBlockProps) {
  const { t } = useLingui();
  const words = useAutomationWords();
  const { data: agents = [] } = useEntitiesQuery<Agent>(ALL_AGENTS);
  const sorted = useMemo(() => [...agents].sort((a, b) => (a.name || '').localeCompare(b.name || '')), [agents]);
  const set = (patch: Partial<AutomationDraft['then']>) => onChange({ ...draft, then: { ...draft.then, ...patch } });
  const choices: Array<{ value: ThenChoice; label: string }> = [
    { value: 'run_agent', label: t`Run an agent` },
    { value: 'run_script', label: t`Run a script` },
    ...(draft.keptActions.length ? [{ value: 'keep' as ThenChoice, label: t`Only the steps below` }] : []),
  ];
  // The saved steps the builder does not edit, named by the backend.
  const kept = (savedThen ?? []).filter((p) => !['run_agent', 'run_script', 'notify', 'nothing'].includes(p.kind));

  return (
    <Block testId="automation-then" title={<Trans>Then</Trans>}>
      <Pills
        testId="then-choice"
        value={draft.then.choice}
        options={choices}
        disabled={readOnly}
        onChange={(choice) => set({ choice })}
      />

      {draft.then.choice === 'run_agent' && (
        <>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">
              <Trans>Agent</Trans>
            </span>
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={draft.then.agentTypeId}
              disabled={readOnly}
              onChange={(e) => set({ agentTypeId: e.target.value })}
              data-testid="then-agent"
            >
              <option value="">{t`Pick an agent…`}</option>
              {sorted.map((a) => (
                <option key={a.id} value={`agent-${a.id}`}>
                  {a.name || a.id}
                </option>
              ))}
              {draft.then.agentTypeId && !sorted.some((a) => `agent-${a.id}` === draft.then.agentTypeId) && (
                <option value={draft.then.agentTypeId}>{draft.then.agentTypeId}</option>
              )}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">
              <Trans>What should it do?</Trans>
            </span>
            <Textarea
              value={draft.then.prompt}
              disabled={readOnly}
              onChange={(e) => set({ prompt: e.target.value })}
              rows={3}
              placeholder={t`Summarize what changed since yesterday and list what needs me.`}
              data-testid="then-prompt"
            />
          </label>
        </>
      )}

      {draft.then.choice === 'run_script' && (
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs text-muted-foreground">
            <Trans>Script</Trans>
          </span>
          <Input
            value={draft.then.scriptPath}
            disabled={readOnly}
            onChange={(e) => set({ scriptPath: e.target.value })}
            className="font-mono"
            placeholder="/Users/you/scripts/sync.sh"
            data-testid="then-script"
          />
          <span className="text-xs text-muted-foreground">
            <Trans>It gets the changed file paths in its environment when a file starts it.</Trans>
          </span>
        </label>
      )}

      {kept.length > 0 && (
        <div className="flex flex-col gap-1.5 text-sm" data-testid="then-kept">
          <span className="text-xs text-muted-foreground">
            <Trans>Also</Trans>
          </span>
          {kept.map((p, i) => (
            <div
              key={i}
              className={cn(
                'flex items-center gap-2 rounded border px-2 py-1',
                p.problem ? 'border-amber-500/50 bg-amber-500/10' : 'border-border',
              )}
            >
              {p.problem && <AlertTriangle className="size-3.5 shrink-0" aria-hidden />}
              <span className="min-w-0 flex-1">{words.then(p)}</span>
              {p.problem && <span className="text-xs">{p.problem}</span>}
            </div>
          ))}
        </div>
      )}
    </Block>
  );
}
