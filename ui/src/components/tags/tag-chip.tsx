import { Tag as TagIcon } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { FlowMessage } from '@sdk';
import { profileLabel } from '@sdk/models/MessageEnvelope';

/** A tag colour remains readable in both themes; text uses the app foreground. */
export function tagChipStyle(color?: string | null): CSSProperties | undefined {
  return color
    ? {
        borderColor: color,
        backgroundColor: `color-mix(in srgb, ${color} 18%, hsl(var(--background)))`,
        color: 'hsl(var(--foreground))',
      }
    : undefined;
}

/** A tag as a small chip: its last segment, in its colour. */
export function TagChip({ name, color }: { name: string; color?: string | null }) {
  return (
    <span
      style={tagChipStyle(color)}
      title={name}
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 text-[11px] text-foreground"
    >
      <TagIcon className="size-3" />
      {name.split('.').at(-1)}
    </span>
  );
}

/** A message in one line: who sent it, and its subject (or the start of its text). */
export function messageLabel(message: FlowMessage | null | undefined): [string, string] {
  const subject = message?.envelope?.subject || message?.text?.slice(0, 80) || '';
  return [message?.sender_name || profileLabel(message?.envelope?.sender), subject];
}
