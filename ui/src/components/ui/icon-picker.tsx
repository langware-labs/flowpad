import React, { useMemo, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { Input } from '@src/components/ui/input';
import { lucideByName } from '@src/lib/lucide-by-name';
import { cn } from '@src/lib/utils';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * IconPicker — generic, reusable two-tab icon chooser.
 *
 * Stores a single string value of either kind (rendered everywhere by
 * `FlowIcon`):
 *  - lucide tab: a curated, searchable subset of lucide export names — the
 *    app's existing `lucideByName` convention;
 *  - emoji tab: a curated emoji grid, stores the character.
 *
 * Pure selection — zero business logic.
 */

/** Curated lucide subset (export names). Generic-purpose, search-filtered. */
export const ICON_PICKER_LUCIDE_NAMES: readonly string[] = [
  'Search', 'BookMarked', 'BookOpen', 'Bookmark', 'Star', 'Heart', 'Flag', 'Tag',
  'Folder', 'FolderOpen', 'File', 'FileText', 'FileCode', 'Files', 'Archive',
  'Code', 'Terminal', 'Bug', 'Wrench', 'Hammer', 'Settings', 'Cog',
  'GitBranch', 'GitMerge', 'GitPullRequest', 'Github',
  'Rocket', 'Zap', 'Flame', 'Sparkles', 'Wand2', 'Lightbulb', 'Brain',
  'MessageSquare', 'MessagesSquare', 'Send', 'Mail', 'Bell',
  'Eye', 'Shield', 'Lock', 'Key', 'AlertTriangle', 'CircleAlert',
  'Check', 'CheckCircle', 'ListChecks', 'ListTodo', 'ClipboardList',
  'Play', 'Repeat', 'RefreshCw', 'Clock', 'Calendar', 'Timer',
  'Database', 'Server', 'Cloud', 'Globe', 'Link', 'Paperclip',
  'Pencil', 'Eraser', 'Trash2', 'Scissors', 'Layers', 'Package',
] as const;

/** Curated emoji grid. */
export const ICON_PICKER_EMOJI: readonly string[] = [
  '🚀', '⚡', '🔥', '✨', '💡', '🧠', '🎯', '🏷️',
  '📌', '📎', '📝', '📄', '📚', '🗂️', '📦', '🧰',
  '🔧', '🔨', '🛠️', '🐛', '🔍', '🔎', '🧪', '🧹',
  '✅', '☑️', '❗', '⚠️', '⛔', '🔒', '🔑', '🛡️',
  '💬', '📣', '📨', '🔔', '⏰', '📅', '🌐', '🔗',
] as const;

interface GridProps {
  /** Currently selected value (lucide name or emoji), or null/undefined. */
  value?: string | null;
  /** Fires with the lucide export name or the emoji character. */
  onChange: (value: string | null) => void;
}

export interface IconPickerProps extends GridProps {
  className?: string;
}

const cell = (selected: boolean) =>
  cn('flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted', selected && 'ring-2 ring-ring bg-muted');

/** The searchable lucide grid — the "Icons" tab, reusable on its own. */
export const IconGrid: React.FC<GridProps> = ({ value, onChange }) => {
  const { t } = useLingui();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ICON_PICKER_LUCIDE_NAMES;
    return ICON_PICKER_LUCIDE_NAMES.filter((n) => n.toLowerCase().includes(q));
  }, [query]);

  return (
    <div className="space-y-2">
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t`Search icons…`}
        className="h-7 text-xs"
        aria-label={t`Search icons`}
      />
      <div role="listbox" aria-label={t`Icon`} className="grid max-h-40 grid-cols-8 gap-1 overflow-y-auto">
        {filtered.map((name) => {
          const Icon = lucideByName(name);
          return (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={value === name}
              aria-label={name}
              title={name}
              onClick={() => onChange(value === name ? null : name)}
              className={cell(value === name)}
            >
              <Icon className="h-4 w-4" />
            </button>
          );
        })}
      </div>
    </div>
  );
};

/** The curated emoji grid — the "Emoji" tab, reusable on its own. */
export const EmojiGrid: React.FC<GridProps> = ({ value, onChange }) => {
  const { t } = useLingui();
  return (
    <div role="listbox" aria-label={t`Emoji`} className="grid max-h-40 grid-cols-8 gap-1 overflow-y-auto">
      {ICON_PICKER_EMOJI.map((emoji) => (
        <button
          key={emoji}
          type="button"
          role="option"
          aria-selected={value === emoji}
          aria-label={emoji}
          title={emoji}
          onClick={() => onChange(value === emoji ? null : emoji)}
          className={cn(cell(value === emoji), 'text-base leading-none')}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
};

export const IconPicker: React.FC<IconPickerProps> = ({ value, onChange, className }) => (
  <Tabs defaultValue="lucide" className={className}>
    <TabsList className="h-7">
      <TabsTrigger value="lucide" className="h-6 px-2 text-xs">
        <Trans>Icons</Trans>
      </TabsTrigger>
      <TabsTrigger value="emoji" className="h-6 px-2 text-xs">
        <Trans>Emoji</Trans>
      </TabsTrigger>
    </TabsList>
    <TabsContent value="lucide" className="mt-2">
      <IconGrid value={value} onChange={onChange} />
    </TabsContent>
    <TabsContent value="emoji" className="mt-2">
      <EmojiGrid value={value} onChange={onChange} />
    </TabsContent>
  </Tabs>
);
