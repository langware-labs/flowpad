/**
 * "What should start it?" — the four kinds as cards, then starters.
 *
 * The empty state AND the New-automation chooser: a person who has never made
 * one learns what is possible here, in plain words, before any field appears.
 * Agent activity is listed last and marked Advanced — those rules are code.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Sparkles } from 'lucide-react';
import { cn } from '@src/lib/utils';
import { AUTOMATION_RECIPES, MESSAGE_RECIPES } from './automation-recipes';
import type { CreatingKind } from './automations-pointer';
import { CREATING_ICON } from './KindBadge';

export interface KindGalleryProps {
  onPick: (kind: CreatingKind, recipe?: string) => void;
  /** Compact = inside the list header's chooser rather than the full empty state. */
  compact?: boolean;
}

export function KindGallery({ onPick, compact }: KindGalleryProps) {
  const { t } = useLingui();
  const kinds: Array<{ kind: CreatingKind; title: string; body: string; advanced?: boolean }> = [
    {
      kind: 'message',
      title: t`When a message arrives`,
      body: t`Mail, chat, a support channel. Say what the message must be about; Flowpad reads each one and decides.`,
    },
    {
      kind: 'schedule',
      title: t`On a schedule`,
      body: t`Every weekday at 9, every hour, once next Tuesday.`,
    },
    {
      kind: 'event',
      title: t`When something happens in Flowpad`,
      body: t`A task is assigned, the app opens, an agent finishes.`,
    },
    {
      kind: 'file',
      title: t`When a file changes`,
      body: t`A document is saved, a folder gets a new file.`,
    },
    {
      kind: 'agent_hook',
      title: t`When an agent does something`,
      body: t`Before a tool runs, when a turn ends. Written as code.`,
      advanced: true,
    },
  ];
  // Message recipes first: the door most people come through.
  const recipes: Array<{ id: string; kind: CreatingKind }> = [
    ...MESSAGE_RECIPES.map((r) => ({ id: r.id, kind: 'message' as const })),
    ...AUTOMATION_RECIPES.map((r) => ({ id: r.id, kind: r.kind })),
  ];
  const recipeWords: Record<string, { title: string; body: string }> = {
    'morning-briefing': {
      title: t`Morning briefing`,
      body: t`Every weekday at 09:00, an agent summarizes what changed.`,
    },
    'docs-on-save': {
      title: t`Review docs on save`,
      body: t`When a .md file in a folder changes, an agent reviews it.`,
    },
    'task-assigned': { title: t`When a task changes`, body: t`An agent reads the task and tells you if it needs you.` },
    'refund-requests': { title: t`Refund requests → an agent`, body: t`Mail that asks for a refund; an agent drafts the reply.` },
    'urgent-to-task': { title: t`Urgent messages → a task`, body: t`Anything that needs a person today becomes a task for you.` },
  };

  return (
    <div className={cn('flex flex-col gap-6', !compact && 'py-6')} data-testid="automation-kind-gallery">
      <div>
        <h3 className="mb-3 text-sm font-medium">
          <Trans>What should start it?</Trans>
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {kinds.map(({ kind, title, body, advanced }) => {
            const Icon = CREATING_ICON[kind];
            return (
              <button
                key={kind}
                type="button"
                data-testid={`automation-kind-${kind}`}
                onClick={() => onPick(kind)}
                className="flex items-start gap-3 rounded-lg border border-border p-4 text-left transition-colors hover:border-primary/60 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-sm font-medium">
                    {title}
                    {advanced && (
                      <span className="rounded border border-border px-1.5 text-[10px] font-normal text-muted-foreground">
                        <Trans>Advanced</Trans>
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{body}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <h3 className="mb-3 flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden />
          <Trans>Or start from one of these</Trans>
        </h3>
        <div className="grid gap-2 sm:grid-cols-3">
          {recipes.map((r) => (
            <button
              key={r.id}
              type="button"
              data-testid={`automation-recipe-${r.id}`}
              onClick={() => onPick(r.kind, r.id)}
              className="rounded-md border border-dashed border-border p-3 text-left text-xs hover:border-primary/60 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="block text-sm font-medium">{recipeWords[r.id]?.title ?? r.id}</span>
              <span className="mt-0.5 block text-muted-foreground">{recipeWords[r.id]?.body}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
