import { X } from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface ChipProps {
  label: string;
  selected: boolean;
  onClick: () => void;
  onRemove?: () => void;
}

export function Chip({ label, selected, onClick, onRemove }: ChipProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Get display label (last part after dot)
  const displayLabel = label.includes('.') ? label.split('.').pop() || label : label;

  const handleMouseEnter = () => {
    // Start 1 second delay
    timeoutRef.current = setTimeout(() => {
      if (buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        setTooltipPosition({
          top: rect.bottom + 4,
          left: rect.left + rect.width / 2,
        });
        setShowTooltip(true);
      }
    }, 1000);
  };

  const handleMouseLeave = () => {
    // Cancel timeout and hide tooltip
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setShowTooltip(false);
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <>
      <button
        ref={buttonRef}
        className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2.5 py-0.5 text-xs font-medium transition-colors ${
          selected ? 'bg-primary text-primary-foreground' : 'bg-background text-foreground hover:bg-muted'
        }`}
        onClick={onClick}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        type="button"
      >
        <span>{displayLabel}</span>
        {onRemove && (
          <X
            className="h-3 w-3 cursor-pointer hover:opacity-70"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          />
        )}
      </button>

      {showTooltip &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[10000] -translate-x-1/2 transform whitespace-nowrap rounded bg-gray-900 px-2 py-1 text-xs text-white shadow-lg"
            style={{
              top: `${tooltipPosition.top}px`,
              left: `${tooltipPosition.left}px`,
            }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
