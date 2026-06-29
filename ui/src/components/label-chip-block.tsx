import { useState, useEffect } from 'react';
import { MoreHorizontal, X } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { Chip } from './label-chip';

interface LabelChipBlockProps {
  labels: string[];
  selected: string[];
  maxChips?: number;
  onToggle: (label: string) => void;
  onRemove: (label: string) => void;
}

export function LabelChipBlock({ labels, selected, maxChips = 3, onToggle, onRemove }: LabelChipBlockProps) {
  const { t } = useLingui();
  const [isExpanded, setIsExpanded] = useState(false);

  // Auto-close expansion when labels count drops below maxChips
  useEffect(() => {
    if (isExpanded && labels.length <= maxChips) {
      setIsExpanded(false);
    }
  }, [labels.length, maxChips, isExpanded]);

  const hasMore = labels.length > maxChips;
  const visibleLabels = isExpanded ? labels : labels.slice(0, maxChips);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden" data-testid="labels-block">
      {visibleLabels.map((label) => (
        <Chip
          key={label}
          label={label}
          selected={selected.includes(label)}
          onClick={() => onToggle(label)}
          onRemove={() => onRemove(label)}
        />
      ))}

      {/* Show expand button if there are more labels and not expanded */}
      {hasMore && !isExpanded && (
        <button
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded hover:bg-muted"
          onClick={() => setIsExpanded(true)}
          type="button"
          aria-label={t`Show ${labels.length - maxChips} more labels`}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      )}

      {/* Show close expansion button if expanded and still has more than maxChips */}
      {isExpanded && hasMore && (
        <button
          className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded hover:bg-muted"
          onClick={() => setIsExpanded(false)}
          type="button"
          aria-label={t`Show fewer labels`}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
