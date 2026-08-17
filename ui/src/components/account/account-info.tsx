import { Trans } from '@lingui/react/macro';
import { dataContext, User } from '@sdk';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { DatabaseSection } from './database-section';
import { LogsSection } from './logs-section';
import { SecretsSection } from './secrets-section';
import { SettingsSection } from './settings-section';
import { UserInfo } from './user-info';
import { OrganizationPanel } from './organization-panel';

interface AccountInfoProps {
  user: User;
}

export function AccountInfo({ user }: AccountInfoProps) {
  // Was `desktop_info != null` — a third spelling of "an app server answered",
  // which is what `isDesktop` means. One predicate, one source (runtime.kind).
  const isDesktop = dataContext.isDesktop;

  return (
    <Tabs defaultValue="organization" className="flex min-h-0 flex-1 flex-col">
      <TabsList className="w-full shrink-0">
        <TabsTrigger value="organization" className="flex-1">
          <Trans>Organization</Trans>
        </TabsTrigger>
        <TabsTrigger value="settings" className="flex-1">
          <Trans>General</Trans>
        </TabsTrigger>
        <TabsTrigger value="database" className="flex-1">
          <Trans>Database</Trans>
        </TabsTrigger>
        <TabsTrigger value="secrets" className="flex-1">
          <Trans>Secrets</Trans>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="organization" className="min-h-0 flex-1 overflow-y-auto">
        <OrganizationPanel user={user} />
        <UserInfo user={user} />
      </TabsContent>

      <TabsContent value="settings" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-4">
          <SettingsSection />
          {isDesktop && <LogsSection />}
        </div>
      </TabsContent>

      <TabsContent value="database" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-4">
          <DatabaseSection />
        </div>
      </TabsContent>

      <TabsContent value="secrets" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-4">
          <SecretsSection />
        </div>
      </TabsContent>
    </Tabs>
  );
}
