import { History, Layers, type LucideIcon } from 'lucide-react';
import { Button } from '@src/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { cn } from '@src/lib/utils';

export type ConversationSideTab = 'runs' | 'context';

interface RibbonTab {
  id: ConversationSideTab;
  icon: LucideIcon;
  description: string;
  /** Optional small badge shown on top-right of the icon. */
  badge?: number;
}

interface ConversationBottomRibbonProps {
  /** Currently active tab when the drawer is open; null when the drawer is closed. */
  activeSideTab: ConversationSideTab | null;
  /** Click toggles open/close + sets active tab. */
  onToggleSideTab: (tab: ConversationSideTab) => void;
  /** Hide the Runs button entirely (e.g. hub-direct conversations with no task). */
  showRuns?: boolean;
  runsBadge?: number;
}

export function ConversationBottomRibbon({
  activeSideTab,
  onToggleSideTab,
  showRuns = true,
  runsBadge,
}: ConversationBottomRibbonProps) {
  // Order matches the drawer's tab strip: Context on the left, Runs on the right.
  const tabs: RibbonTab[] = [{ id: 'context', icon: Layers, description: 'Context' }];
  if (showRuns) {
    tabs.push({ id: 'runs', icon: History, description: 'Runs', badge: runsBadge });
  }

  return (
    <div className="flex items-center border-t bg-muted/30 px-2 py-1">
      <div className="ms-auto flex items-center gap-1">
        <TooltipProvider delayDuration={400}>
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeSideTab === tab.id;
            return (
              <Tooltip key={tab.id}>
                <TooltipTrigger asChild>
                  <div className="relative">
                    <Button
                      variant={isActive ? 'secondary' : 'ghost'}
                      size="sm"
                      onClick={() => onToggleSideTab(tab.id)}
                      data-testid={`conversation-ribbon-${tab.id}`}
                      className={cn('h-7 w-7 p-0', isActive && 'text-foreground')}
                    >
                      <Icon className="h-4 w-4" />
                    </Button>
                    {tab.badge != null && tab.badge > 0 && (
                      <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] text-primary-foreground">
                        {tab.badge > 99 ? '99+' : tab.badge}
                      </span>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {tab.description}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </TooltipProvider>
      </div>
    </div>
  );
}
