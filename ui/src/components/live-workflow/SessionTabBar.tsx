import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { acknowledgePending } from '@src/store/pending-actions-store';
import { ChevronLeft, ChevronRight, Plus, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

export interface SessionTab {
  id: string;
  name?: string | null;
  tab_index?: number | null;
}

interface SessionTabBarProps {
  /** Sessions to display as tabs (should be sorted by tab_index) */
  sessions: SessionTab[];
  /** Currently active session ID */
  activeSessionId: string | null;
  /** Set of session IDs that have unsaved changes */
  dirtySessionIds?: Set<string>;
  /** Set of session IDs that recently became ready-for-input (PendingAction). */
  pendingSessionIds?: Set<string>;
  /** Callback when a tab close button is clicked */
  onCloseTab: (sessionId: string) => Promise<void>;
  /** Callback when a session is renamed */
  onRenameSession?: (sessionId: string, newName: string) => Promise<void>;
  /** Callback when tabs are reordered via drag and drop */
  onReorderTab?: (sourceId: string, targetId: string) => void;
  /** Callback when the add tab button is clicked */
  onAddTab?: () => void | Promise<void>;
  /** Callback when a tab is selected - allows parent to control navigation with process preservation */
  onSelectTab?: (sessionId: string) => void;
  /** Optional action buttons rendered on the far right of the tab bar */
  actions?: ReactNode;
}

/**
 * SessionTabBar - Horizontal tab bar for switching between open sessions.
 *
 * Features:
 * - Scroll buttons (<>) when tabs overflow
 * - Active/inactive tab styling
 * - Close button on each tab (X appears on hover)
 * - Double-click tab name to rename (like file/folder renaming)
 * - Plus button to create new session
 * - Clicking a tab navigates to that session
 */
export function SessionTabBar({
  sessions,
  activeSessionId,
  dirtySessionIds = new Set(),
  pendingSessionIds = new Set(),
  onCloseTab,
  onRenameSession,
  onAddTab,
  onSelectTab,
  onReorderTab,
  actions,
}: SessionTabBarProps) {
  const { navigation } = useDockNavigation();

  // Scroll state
  const tabContainerRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Rename editing state
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  // Check if tabs overflow and update scroll button state
  const updateScrollState = () => {
    const container = tabContainerRef.current;
    if (!container) return;

    const { scrollLeft, scrollWidth, clientWidth } = container;
    setCanScrollLeft(scrollLeft > 0);
    setCanScrollRight(scrollLeft + clientWidth < scrollWidth - 1);
  };

  // Scroll tabs left or right
  const scrollTabs = (direction: 'left' | 'right') => {
    const container = tabContainerRef.current;
    if (!container) return;

    const scrollAmount = 200;
    container.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  };

  // Update scroll state on mount, session changes, and scroll events
  useEffect(() => {
    updateScrollState();
    const container = tabContainerRef.current;
    if (!container) return;

    const handleScroll = () => updateScrollState();
    container.addEventListener('scroll', handleScroll);
    window.addEventListener('resize', updateScrollState);

    return () => {
      container.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', updateScrollState);
    };
  }, [sessions]);

  // Handle tab click - navigate to session
  const handleTabClick = (sessionId: string) => {
    onSelectTab?.(sessionId);
    acknowledgePending(sessionId);
  };

  // Handle close button click (navigation is handled by the parent via onCloseTab)
  const handleCloseClick = async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    await onCloseTab(sessionId);
  };

  // Enter rename mode (double-click on tab title)
  const handleTabNameDoubleClick = (sessionId: string, currentName: string) => {
    setEditingSessionId(sessionId);
    setEditingName(currentName);
  };

  // Handle name change input
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setEditingName(e.target.value);
  };

  // Handle name blur - save the new name
  const handleNameBlur = async () => {
    if (editingSessionId && editingName.trim() && onRenameSession) {
      await onRenameSession(editingSessionId, editingName.trim());
    }
    setEditingSessionId(null);
  };

  // Handle key press in name input
  const handleNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      void handleNameBlur();
    } else if (e.key === 'Escape') {
      setEditingSessionId(null);
    }
  };

  // Don't render if no sessions and no add button
  if (sessions.length === 0 && !onAddTab) {
    return null;
  }

  return (
    <div className="flex items-center border-b bg-muted/30">
      {/* Left Scroll Button - always allocate space, visibility controlled */}
      <Button
        variant="ghost"
        size="icon"
        className={`h-7 w-7 shrink-0 rounded-none ${canScrollLeft ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        onClick={() => scrollTabs('left')}
        aria-label="Scroll tabs left"
        tabIndex={canScrollLeft ? 0 : -1}
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>

      {/* Scrollable Tab Container */}
      <div
        ref={tabContainerRef}
        className="scrollbar-hide flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1 py-1"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {sessions.map((session) => {
          const isActive = activeSessionId === session.id;
          const displayName = session.name || 'Untitled Session';
          const isEditing = editingSessionId === session.id;
          const isDirty = session.id ? dirtySessionIds.has(session.id) : false;
          const isPending = session.id ? pendingSessionIds.has(session.id) : false;

          return (
            <div
              key={session.id}
              className={`group flex shrink-0 cursor-pointer select-none items-center gap-2 rounded-t border-b-2 px-3 py-1.5 transition-colors ${
                isActive
                  ? 'border-primary bg-background text-foreground'
                  : 'border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground'
              } ${isPending ? 'animate-pending-glow rounded-md' : ''}`}
              draggable={!!session.id}
              onDragStart={(e) => {
                if (!session.id) return;
                e.dataTransfer.setData('text/plain', session.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (!onReorderTab) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(e) => {
                if (!onReorderTab || !session.id) return;
                e.preventDefault();
                const sourceId = e.dataTransfer.getData('text/plain');
                if (sourceId && sourceId !== session.id) {
                  onReorderTab(sourceId, session.id);
                }
              }}
              onClick={() => session.id && handleTabClick(session.id)}
              data-testid={`session-tab-${session.id}`}
            >
              {/* Dirty indicator dot */}
              {isDirty && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-primary"
                  title="Unsaved changes"
                  aria-label="Unsaved changes"
                />
              )}

              {isEditing ? (
                <input
                  type="text"
                  value={editingName}
                  onChange={handleNameChange}
                  onBlur={() => void handleNameBlur()}
                  onKeyDown={handleNameKeyDown}
                  className="min-w-[80px] max-w-[150px] rounded border border-border bg-background px-1 py-0 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span
                  className="max-w-[150px] truncate text-sm font-medium"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (session.id) handleTabNameDoubleClick(session.id, displayName);
                  }}
                >
                  {displayName}
                </span>
              )}

              <button
                onClick={(e) => session.id && void handleCloseClick(e, session.id)}
                className="rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/20 group-hover:opacity-100"
                aria-label="Close tab"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}

        {/* Add Tab Button - scrolls with tabs */}
        {onAddTab && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 rounded"
            onClick={() => void onAddTab()}
            aria-label="Add new session tab"
            data-testid="add-session-tab-button"
          >
            <Plus className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Right Scroll Button - always allocate space, visibility controlled */}
      <Button
        variant="ghost"
        size="icon"
        className={`h-7 w-7 shrink-0 rounded-none ${canScrollRight ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
        onClick={() => scrollTabs('right')}
        aria-label="Scroll tabs right"
        tabIndex={canScrollRight ? 0 : -1}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>

      {/* Optional action buttons on the far right */}
      {actions && <div className="flex shrink-0 items-center gap-1 border-l border-border/50 px-2">{actions}</div>}
    </div>
  );
}
