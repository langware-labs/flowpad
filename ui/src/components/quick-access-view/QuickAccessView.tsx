import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import './QuickAccessView.css';

// Helper to format relative time
const formatRelativeTime = (timestamp: string): string => {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

// Helper to format full timestamp for tooltip
const formatFullTimestamp = (timestamp: string): string => {
  const date = new Date(timestamp);
  return date.toLocaleString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
};

export interface QuickAccessItem<T = unknown> {
  id: string;
  name: string;
  data?: T;
  timestamp?: string;
}

export interface QuickAccessColumn<T = unknown> {
  title: string;
  items: QuickAccessItem<T>[];
  onItemClick?: (item: QuickAccessItem<T>) => void;
  seeAllLink?: {
    label: string;
    onClick: () => void;
  };
}

interface QuickAccessViewProps {
  columns: QuickAccessColumn[];
  maxNameLength?: number;
  isLoading?: boolean;
}

// TimeChip component for displaying relative time with tooltip
const TimeChip = ({ timestamp }: { timestamp: string }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span className="time-chip">{formatRelativeTime(timestamp)}</span>
    </TooltipTrigger>
    <TooltipContent side="top">{formatFullTimestamp(timestamp)}</TooltipContent>
  </Tooltip>
);

export function QuickAccessView({ columns, maxNameLength = 24, isLoading = false }: QuickAccessViewProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const truncateName = (name: string): string => {
    if (name.length <= maxNameLength) return name;
    return name.substring(0, maxNameLength - 3) + '...';
  };

  const handleCopy = async (e: React.MouseEvent, name: string, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(name);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const handleItemClick = (item: QuickAccessItem, column: QuickAccessColumn) => {
    if (column.onItemClick) {
      column.onItemClick(item);
    }
  };

  if (isLoading) {
    return (
      <div className="quick-access-view">
        <div className="quick-access-header">
          <h3>Quick Access</h3>
        </div>
        <div className="quick-access-loading">Loading...</div>
      </div>
    );
  }

  if (columns.length === 0 || columns.every((col) => col.items.length === 0)) {
    return null;
  }

  return (
    <div className="quick-access-view">
      <div className="quick-access-header">
        <h3>Quick Access</h3>
      </div>
      <div className="quick-access-columns">
        {columns.map((column, columnIndex) => (
          <div key={column.title} className="quick-access-column-wrapper">
            <div className="quick-access-column">
              <h4 className="column-title">{column.title}</h4>
              <ul className="column-items">
                {column.items.map((item) => {
                  const isTruncated = item.name.length > maxNameLength;
                  const displayName = truncateName(item.name);

                  const itemContent = (
                    <div
                      className={`item-container ${column.onItemClick ? 'clickable' : ''}`}
                      onClick={() => handleItemClick(item, column)}
                    >
                      <span className="item-name">{displayName}</span>
                      {isTruncated && (
                        <button
                          className="copy-button-inline"
                          onClick={(e) => void handleCopy(e, item.name, item.id)}
                          title="Copy to clipboard"
                        >
                          {copiedId === item.id ? <Check className="copy-icon" /> : <Copy className="copy-icon" />}
                        </button>
                      )}
                      {item.timestamp && <TimeChip timestamp={item.timestamp} />}
                    </div>
                  );

                  return (
                    <li key={item.id} className="column-item">
                      {isTruncated ? (
                        <Tooltip>
                          <TooltipTrigger asChild>{itemContent}</TooltipTrigger>
                          <TooltipContent side="bottom" align="start" className="max-w-none">
                            <span className="whitespace-nowrap">{item.name}</span>
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        itemContent
                      )}
                    </li>
                  );
                })}
              </ul>
              {column.seeAllLink && (
                <button className="see-all-link" onClick={column.seeAllLink.onClick}>
                  {column.seeAllLink.label} →
                </button>
              )}
            </div>
            {columnIndex < columns.length - 1 && <div className="column-divider" />}
          </div>
        ))}
      </div>
    </div>
  );
}

export default QuickAccessView;
