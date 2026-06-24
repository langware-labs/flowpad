import { FlowData } from '@sdk';
import { MarkdownView } from '@src/components/markdown-view';
import { useIsAdvanced } from '@src/components/view-mode';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { useState } from 'react';

/**
 * Framework-injected (`isMeta`) user lines — skill bodies, command expansions,
 * system reminders — are not human messages. Instead of dumping the whole doc
 * as a "You" turn, collapse it to a compact chip ("Skill: <name>"). In Advanced
 * the chip expands to the full injected text for debugging; Standard just shows
 * the breadcrumb.
 */
export function MetaMessageChip({ flowData }: { flowData: FlowData }) {
  const isAdvanced = useIsAdvanced();
  const [open, setOpen] = useState(false);
  const content = flowData.content ?? '';
  const label = deriveLabel(content);

  return (
    <div className="my-1" data-testid="meta-message-chip">
      <button
        type="button"
        disabled={!isAdvanced}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-default disabled:hover:bg-muted/40 disabled:hover:text-muted-foreground"
      >
        {isAdvanced &&
          (open ? <ChevronDown className="h-3 w-3 flex-shrink-0" /> : <ChevronRight className="h-3 w-3 flex-shrink-0" />)}
        <Sparkles className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="truncate font-medium">{label}</span>
      </button>
      {isAdvanced && open && (
        <div className="mt-1 break-words rounded-md border border-border/60 bg-muted/20 px-3 py-2 text-[13px] text-muted-foreground">
          <MarkdownView value={content} compact />
        </div>
      )}
    </div>
  );
}

/** Skill injections carry "Base directory for this skill: …/skills/<name>". */
function deriveLabel(content: string): string {
  const skill = content.match(/skills\/([\w.-]+)/);
  if (skill) return `Skill: ${skill[1]}`;
  return 'System note';
}
