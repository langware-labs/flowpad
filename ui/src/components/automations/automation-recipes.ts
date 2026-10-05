/**
 * Starters for a new automation — the gallery's "or start from one of these".
 * Each is a draft with the When filled in and the Then half-filled, so the
 * person picks only what is theirs (which agent, which folder).
 */
import type { AutomationKind } from '@sdk';
import { defaultDraft, type AutomationDraft } from './automation-draft';

export interface AutomationRecipe {
  id: string;
  kind: AutomationKind;
  draft: () => AutomationDraft;
}

export const AUTOMATION_RECIPES: readonly AutomationRecipe[] = [
  {
    id: 'morning-briefing',
    kind: 'schedule',
    draft: () => {
      const d = defaultDraft('schedule');
      d.name = 'Morning briefing';
      d.schedule = { ...d.schedule, preset: 'weekdays', time: '09:00' };
      d.then = {
        ...d.then,
        choice: 'run_agent',
        prompt: 'Summarize what changed since yesterday: new tasks, failed runs, unread messages.',
      };
      return d;
    },
  },
  {
    id: 'docs-on-save',
    kind: 'file',
    draft: () => {
      const d = defaultDraft('file');
      d.name = 'Review docs on save';
      d.file = { path: '', glob: '*.md', recursive: true };
      d.then = {
        ...d.then,
        choice: 'run_agent',
        prompt: 'Review the changed document for broken links and unclear sentences.',
      };
      return d;
    },
  },
  {
    id: 'task-assigned',
    kind: 'event',
    draft: () => {
      const d = defaultDraft('event');
      d.name = 'When a task is assigned';
      d.event = { pattern: 'task.*', target: '' };
      d.then = {
        ...d.then,
        choice: 'run_agent',
        prompt: 'A task changed. Read it and tell me if it needs anything from me.',
      };
      return d;
    },
  },
];

export function recipeById(id: string | null | undefined): AutomationRecipe | undefined {
  return id ? AUTOMATION_RECIPES.find((r) => r.id === id) : undefined;
}
