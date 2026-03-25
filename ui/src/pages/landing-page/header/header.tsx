import { Logo } from '@src/components/logo';
import { ThemeToggle } from '@src/components/theme-toggle/theme-toggle';
import { useDevMode } from '@src/contexts/dev-mode-context';
import { Button } from '@src/components/ui/button';
import { UserDropdown } from '@src/pages/flow-page/content-panel/user-dropdown/user-dropdown';
import { Agent, ExpansionRequest, TypeId } from '@sdk';
import { useAuth, useEntity } from '@sdk/react/hooks';
import { Bug } from 'lucide-react';
import { useMemo } from 'react';
import { useParams } from 'react-router';

export function Header() {
  const { agentId } = useParams();

  const { user } = useAuth();

  const agentTypeId = useMemo(() => new TypeId(Agent.type, agentId), [agentId]);
  const { data: agent } = useEntity<Agent>(agentTypeId, {
    query: user ? new ExpansionRequest({ expand: ['permissions'] }) : new ExpansionRequest({}),
  });
  const siteConfig = agent?.site_config;
  const devMode = useDevMode();

  return (
    <div className="flex items-center justify-between border-b bg-background/95 p-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex items-center gap-2">
        <Logo siteConfig={siteConfig} />
      </div>

      <div className="flex items-center gap-2">
        {devMode && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-orange-500 ring-1 ring-orange-500 shadow-[0_0_8px_2px_rgba(249,115,22,0.6)] animate-pulse"
            onClick={() => window.setDev(false)}
            title="Dev mode ON — click to disable"
          >
            <Bug className="h-4 w-4" />
          </Button>
        )}
        <ThemeToggle />
        <UserDropdown />
      </div>
    </div>
  );
}
