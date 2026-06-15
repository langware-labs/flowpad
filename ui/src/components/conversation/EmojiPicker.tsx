import { useMemo, useState, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Input } from '@src/components/ui/input';

/**
 * EmojiPicker — a small popover-triggered emoji grid for the conversation
 * composer, sitting alongside the File / Asset / Repo attach buttons. Pure
 * selection: it fires `onPick(emoji)` and the composer inserts the character at
 * the textarea caret. Search matches the keyword tags below, not the glyph.
 */

interface EmojiEntry {
  char: string;
  /** Space-separated search keywords. */
  keywords: string;
}

interface EmojiGroup {
  label: string;
  emojis: EmojiEntry[];
}

const EMOJI_GROUPS: readonly EmojiGroup[] = [
  {
    label: 'Smileys',
    emojis: [
      { char: '😀', keywords: 'grin smile happy' },
      { char: '😄', keywords: 'smile happy joy' },
      { char: '😁', keywords: 'grin beam' },
      { char: '😂', keywords: 'laugh tears joy lol' },
      { char: '🤣', keywords: 'rofl laugh rolling' },
      { char: '😊', keywords: 'blush smile happy' },
      { char: '🙂', keywords: 'slight smile' },
      { char: '😉', keywords: 'wink' },
      { char: '😍', keywords: 'love heart eyes' },
      { char: '😘', keywords: 'kiss love' },
      { char: '😎', keywords: 'cool sunglasses' },
      { char: '🤔', keywords: 'thinking hmm' },
      { char: '🙃', keywords: 'upside down silly' },
      { char: '😅', keywords: 'sweat nervous laugh' },
      { char: '😴', keywords: 'sleep tired' },
      { char: '😭', keywords: 'cry sob sad' },
      { char: '😡', keywords: 'angry mad rage' },
      { char: '🥳', keywords: 'party celebrate' },
      { char: '🤩', keywords: 'star struck wow' },
      { char: '😬', keywords: 'grimace awkward' },
    ],
  },
  {
    label: 'Gestures',
    emojis: [
      { char: '👍', keywords: 'thumbs up yes approve like' },
      { char: '👎', keywords: 'thumbs down no disapprove' },
      { char: '👏', keywords: 'clap applause bravo' },
      { char: '🙌', keywords: 'raise hands praise yay' },
      { char: '🙏', keywords: 'pray thanks please' },
      { char: '🤝', keywords: 'handshake deal agree' },
      { char: '👋', keywords: 'wave hi bye hello' },
      { char: '✋', keywords: 'hand stop high five' },
      { char: '👌', keywords: 'ok perfect' },
      { char: '🤞', keywords: 'fingers crossed luck' },
      { char: '💪', keywords: 'muscle strong flex' },
      { char: '👀', keywords: 'eyes look watch' },
    ],
  },
  {
    label: 'Objects',
    emojis: [
      { char: '🔥', keywords: 'fire hot lit' },
      { char: '✨', keywords: 'sparkles shiny new' },
      { char: '⭐', keywords: 'star favorite' },
      { char: '🎉', keywords: 'party tada celebrate' },
      { char: '🚀', keywords: 'rocket ship launch ship-it' },
      { char: '💡', keywords: 'idea lightbulb' },
      { char: '✅', keywords: 'check done complete yes' },
      { char: '❌', keywords: 'cross no wrong fail' },
      { char: '⚠️', keywords: 'warning caution' },
      { char: '❤️', keywords: 'heart love red' },
      { char: '💯', keywords: 'hundred perfect 100' },
      { char: '👏', keywords: 'clap applause' },
      { char: '🎯', keywords: 'target goal bullseye' },
      { char: '🐛', keywords: 'bug issue defect' },
      { char: '📌', keywords: 'pin important' },
      { char: '🤖', keywords: 'robot bot agent' },
    ],
  },
];

const ALL_EMOJIS: readonly EmojiEntry[] = EMOJI_GROUPS.flatMap((g) => g.emojis);

export interface EmojiPickerProps {
  /** Fires with the chosen emoji character. */
  onPick: (emoji: string) => void;
  /** The button that opens the popover. */
  trigger: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}

export function EmojiPicker({ onPick, trigger, side = 'top' }: EmojiPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return ALL_EMOJIS.filter((e) => e.keywords.includes(q) || e.char === q);
  }, [query]);

  const handlePick = (emoji: string) => {
    onPick(emoji);
    setOpen(false);
    setQuery('');
  };

  const renderEmoji = (e: EmojiEntry) => (
    <button
      key={e.char}
      type="button"
      role="option"
      aria-selected={false}
      aria-label={e.keywords}
      title={e.keywords}
      onClick={() => handlePick(e.char)}
      className="flex h-7 w-7 items-center justify-center rounded-md text-lg leading-none hover:bg-muted"
    >
      {e.char}
    </button>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery('');
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side={side} align="start" className="w-64 p-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search emoji…"
          className="mb-2 h-7 text-xs"
          aria-label="Search emoji"
        />
        <div className="max-h-48 overflow-y-auto">
          {filtered ? (
            filtered.length > 0 ? (
              <div role="listbox" aria-label="Emoji" className="grid grid-cols-7 gap-0.5">
                {filtered.map(renderEmoji)}
              </div>
            ) : (
              <p className="px-1 py-4 text-center text-xs text-muted-foreground">No emoji found</p>
            )
          ) : (
            EMOJI_GROUPS.map((group) => (
              <div key={group.label} className="mb-2 last:mb-0">
                <p className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </p>
                <div role="listbox" aria-label={group.label} className="grid grid-cols-7 gap-0.5">
                  {group.emojis.map(renderEmoji)}
                </div>
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
