import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ApiKeysView } from '@src/components/api-keys-view/api-keys-view';
import { Logo } from '@src/components/logo';
import { Footer } from '@src/components/footer';
import { UserDropdown } from '@src/pages/flow-page/content-panel/user-dropdown/user-dropdown';
import { ConnectionsManager } from '@src/components/connections-manager';
import { useLocation } from 'react-router';

export default function PlainPage() {
  const { agent } = useAgentContext();
  const siteConfig = agent?.site_config;
  const location = useLocation();

  // Determine which view to show based on route
  const isApiKeysView = location.pathname.includes('/api-keys');

  return (
    <div data-testid="plain-page" className="flex h-screen flex-col bg-background">
      {/* Header with Logo and UserDropdown */}
      <div className="flex items-center justify-between border-b bg-background/95 p-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center gap-2">
          <Logo siteConfig={siteConfig} />
        </div>

        <div className="flex items-center gap-2">
          <UserDropdown />
        </div>
      </div>

      {/* Main body - switches between Connections and API Keys */}
      <main className="flex-1 overflow-auto">{isApiKeysView ? <ApiKeysView /> : <ConnectionsManager />}</main>

      <Footer />
    </div>
  );
}
