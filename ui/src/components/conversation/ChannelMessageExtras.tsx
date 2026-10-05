/**
 * What a channel message can carry beyond its words: the message it quotes, the reactions on it, and
 * the two things a person can do to it (Reply, React — items of the message's ⋮ menu). Every one is gated by the conversation's
 * `ChannelSpec` traits (`quotes`, `reacts`) — never by a channel's name.
 */
import { useLingui } from '@lingui/react/macro';
import { attachmentDataString, type FlowMessage, type IMessageReaction } from '@sdk/entities/flow-message';
import { attachmentSummary } from './useAttachments';

/** A FILE attachment's name — its `data/<name>` subpath, last segment. */
export function attachmentFileName(a: Parameters<typeof attachmentDataString>[0]): string {
  return attachmentDataString(a).split('/').pop() ?? '';
}

/** Who wrote a message and what it says, as a quote or a reply banner shows it: a message with no
 *  text is named by what it carries. `someone` is the caller's translated fallback. */
export function messageSummary(fm: FlowMessage, someone: string): { sender: string; text: string } {
  return { sender: fm.sender_name || fm.envelope?.sender?.name || someone, text: fm.text || attachmentSummary(fm) };
}

/** The message a reply quotes, drawn above its body. Clicking it scrolls to the original. */
export function QuotedMessage({ sender, text, onJump }: { sender: string; text: string; onJump?: () => void }) {
  const { t } = useLingui();
  return (
    <button
      type="button"
      onClick={onJump}
      className="mb-1 block w-full max-w-md rounded border-s-2 border-primary/60 bg-muted/40 px-2 py-1 text-start text-xs hover:bg-muted/70"
      title={t`Go to the quoted message`}
      data-testid="message-quote"
    >
      <span className="block font-semibold text-primary/80">{sender}</span>
      <span className="line-clamp-2 break-words text-muted-foreground">{text || t`(a file)`}</span>
    </button>
  );
}

/** Reactions grouped by emoji, with a count. Ours is highlighted; clicking it takes it back. */
export function ReactionChips({
  reactions,
  onToggle,
}: {
  reactions: IMessageReaction[];
  onToggle?: (emoji: string, ours: boolean) => void;
}) {
  const { t } = useLingui();
  if (!reactions.length) return null;
  const groups = new Map<string, { count: number; ours: boolean; names: string[] }>();
  for (const r of reactions) {
    const g = groups.get(r.emoji) ?? { count: 0, ours: false, names: [] };
    g.count += 1;
    g.ours = g.ours || !!r.ours;
    g.names.push(r.ours ? t`You` : r.by_name || r.by);
    groups.set(r.emoji, g);
  }
  return (
    <div className="mt-1 flex flex-wrap gap-1" data-testid="message-reactions">
      {[...groups.entries()].map(([emoji, g]) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onToggle?.(emoji, g.ours)}
          disabled={!onToggle}
          title={g.names.join(', ')}
          aria-pressed={g.ours}
          data-testid={`reaction-${emoji}`}
          className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none ${
            g.ours ? 'border-primary/60 bg-primary/10' : 'border-border bg-muted/40'
          } ${onToggle ? 'hover:bg-muted' : ''}`}
        >
          <span className="text-sm">{emoji}</span>
          {g.count > 1 && <span className="text-muted-foreground">{g.count}</span>}
        </button>
      ))}
    </div>
  );
}
