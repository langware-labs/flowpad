import { dataContext, User } from '@sdk';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { DatabaseSection } from './database-section';
import { LogsSection } from './logs-section';
import { NotificationsSection } from './notifications-section';
import { SecretsSection } from './secrets-section';
import { SettingsSection } from './settings-section';
import { UserInfo } from './user-info';
import { OrganizationPanel } from './organization-panel';

interface AccountInfoProps {
  user: User;
}

export function AccountInfo({ user }: AccountInfoProps) {
  const isDesktop = dataContext.bootstrapInfo?.desktop_info != null;

  return (
    <Tabs defaultValue="organization" className="flex min-h-0 flex-1 flex-col">
      <TabsList className="w-full shrink-0">
        <TabsTrigger value="organization" className="flex-1">
          Organization
        </TabsTrigger>
        <TabsTrigger value="settings" className="flex-1">
          General
        </TabsTrigger>
        <TabsTrigger value="database" className="flex-1">
          Database
        </TabsTrigger>
        <TabsTrigger value="secrets" className="flex-1">
          Secrets
        </TabsTrigger>
        <TabsTrigger value="notifications" className="flex-1">
          Notifications
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

      <TabsContent value="notifications" className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex flex-col gap-4 p-4">
          <NotificationsSection />
        </div>
      </TabsContent>
    </Tabs>
  );
}
