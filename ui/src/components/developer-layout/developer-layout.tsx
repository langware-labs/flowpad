import { useAgentContext } from '@src/contexts/agent-context';
import { Logo } from '@src/components/logo';
import { Footer } from '@src/components/footer';
import { FlowpadAssistantButton } from '@src/components/floating-chat';
import { UserDropdown } from '@src/pages/flow-page/content-panel/user-dropdown/user-dropdown';
import { DevMenu } from './dev-menu';
import { Outlet } from 'react-router';

export default function DeveloperLayout() {
  const { agent } = useAgentContext();
  const siteConfig = agent?.site_config;

  return (
    <div data-testid="developer-layout" className="flex h-screen flex-col bg-background">
      {/* Header with Logo and UserDropdown */}
      <header className="flex items-center justify-between border-b bg-background/95 p-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center gap-2">
          <Logo siteConfig={siteConfig} />
        </div>

        <div className="flex items-center gap-2">
          <FlowpadAssistantButton />
          <UserDropdown />
        </div>
      </header>

      {/* Main content area with DevMenu on left */}
      <div className="flex flex-1 overflow-hidden">
        <DevMenu />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>

      <Footer />
    </div>
  );
}
