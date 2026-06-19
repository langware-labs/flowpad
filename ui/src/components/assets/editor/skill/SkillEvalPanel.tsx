import { useState } from 'react';
import { ProcessKind, Skill } from '@sdk';
import { EntityExecutionPanel } from '@src/components/entity-execution-panel';
import { SideDrawer } from '@src/components/ui/side-drawer';
import { FlaskConical, X } from 'lucide-react';

/**
 * Side window for a skill's eval analyses. The analysis processes are launched
 * elsewhere (the in-trace Evaluate button and the tab-close adapter) keyed to
 * this skill's TypeId; `EntityExecutionPanel` auto-lists by `target_typeid_str`,
 * so opening this drawer shows the skill's eval history with no extra wiring.
 * Collapsed by default — a thin rail whose flask button reveals the history.
 */
export function SkillEvalPanel({ skill }: { skill: Skill }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-l bg-background py-2">
        <button
          type="button"
          title="Skill evaluations"
          aria-label="Skill evaluations"
          onClick={() => setOpen(true)}
          className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          data-testid="skill-eval-rail-button"
        >
          <FlaskConical className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <SideDrawer open width="w-96" data-testid="skill-eval-drawer">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex flex-shrink-0 items-center gap-2 border-b px-2 py-1.5">
          <span className="text-xs font-medium text-muted-foreground">Skill eval</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="ml-auto flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Collapse eval panel"
            title="Collapse"
            data-testid="skill-eval-collapse"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <EntityExecutionPanel
          target={skill.typeId.toString()}
          processType={ProcessKind.Execution}
          headerLabel="Skill eval"
          className="min-h-0 flex-1"
        />
      </div>
    </SideDrawer>
  );
}
