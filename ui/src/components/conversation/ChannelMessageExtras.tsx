/**
 * What a channel message can carry beyond its words: the message it quotes, the reactions on it, and
 * the two things a person can do to it (Reply, React). Every one is gated by the conversation's
 * `ChannelSpec` traits (`quotes`, `reacts`) — never by a channel's name.
 */
import { Reply, SmilePlus } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import type { IMessageReaction } from '@sdk/entities/flow-message';
import { EmojiPicker } from './EmojiPicker';

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

/** Reply and React on a channel message — shown when the bubble is hovered or focused. */
export function ChannelMessageActions({
  onReply,
  replyInThread,
  onReact,
}: {
  onReply?: () => void;
  /** The channel's replies only thread (email, Slack): say so. */
  replyInThread?: boolean;
  onReact?: (emoji: string) => void;
}) {
  const { t } = useLingui();
  const replyLabel = replyInThread ? t`Reply in thread` : t`Reply`;
  const cls =
    'text-muted-foreground/60 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100';
  return (
    <>
      {onReply && (
        <button type="button" onClick={onReply} className={cls} title={replyLabel} aria-label={replyLabel} data-testid="message-reply">
          <Reply className="h-3 w-3" />
        </button>
      )}
      {onReact && (
        <EmojiPicker
          side="bottom"
          onPick={onReact}
          trigger={
            <button type="button" className={cls} title={t`React`} aria-label={t`React`} data-testid="message-react">
              <SmilePlus className="h-3 w-3" />
            </button>
          }
        />
      )}
    </>
  );
}
