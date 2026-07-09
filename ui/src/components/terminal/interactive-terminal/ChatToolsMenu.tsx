import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { usePreference } from '@src/hooks/use-preference';
import { cn } from '@src/lib/utils';
import { PrefKey } from '@sdk';
import { ChevronDown, Wrench } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { COMPOSER_PILL_CLASS } from './composer-pill';

/**
 * Small "Tools" menu for the interactive chat composer. Mirrors the hub app's
 * Tools button, pared down to the toggles that matter here. Currently exposes a
 * single "Show tool calls" checkbox bound to the {@link PrefKey.CHAT_SHOW_TOOLS}
 * preference (default off) — which gates the dense tool/reasoning/status chips in
 * the transcript (see TurnGroupsList). The pill styling matches the Plan pill it
 * sits beside in ChatComposerBar.
 */
export function ChatToolsMenu() {
  const { t } = useLingui();
  const [showTools, setShowTools] = usePreference<boolean>(PrefKey.CHAT_SHOW_TOOLS);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title={t`Chat tools`}
          data-testid="chat-tools-menu-trigger"
          className={cn(
            COMPOSER_PILL_CLASS,
            'border-border/60 text-muted-foreground hover:border-primary/50 hover:text-foreground',
          )}
        >
          <Wrench className="h-3.5 w-3.5" />
          <Trans>Tools</Trans>
          <ChevronDown className="h-3 w-3 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuCheckboxItem
          checked={showTools}
          onCheckedChange={setShowTools}
          onSelect={(e) => e.preventDefault()}
          data-testid="chat-tools-show-tool-calls"
        >
          <Trans>Show tool calls</Trans>
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
