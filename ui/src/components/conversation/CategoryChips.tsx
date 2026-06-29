import { Badge } from '@src/components/ui/badge';
import { cn } from '@src/lib/utils';
import { chipsFor, type ConversationFacets } from './conversation-category';

// Compact override so the category chip reads as an inline tag, not the
// default full-size Badge. Tone classes come from each ChipSpec.
const COMPACT = 'gap-0.5 rounded border px-1 py-0 align-middle text-[9px] font-medium leading-tight';

/** Per-row category chips (Support / Archived). Renders nothing for plain rows.
 *  Shared by InboxView and RecentConversationsStrip. */
export function CategoryChips({ facets, className }: { facets: ConversationFacets; className?: string }) {
  const chips = chipsFor(facets);
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map((c) => (
        <Badge
          key={c.key}
          variant="outline"
          className={cn(COMPACT, c.className, className)}
          data-chip-type={c.key}
          title={c.label}
        >
          <c.icon className="h-2.5 w-2.5" />
          {c.label}
        </Badge>
      ))}
    </>
  );
}
