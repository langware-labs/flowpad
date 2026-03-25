import { dataContext, User } from '@sdk';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { DatabaseSection } from './database-section';
import { LogsSection } from './logs-section';
import { SettingsSection } from './settings-section';
import { UserInfo } from './user-info';

interface AccountInfoProps {
  user: User;
}

export function AccountInfo({ user }: AccountInfoProps) {
  const isDesktop = dataContext.bootstrapInfo?.desktop_info != null;

  return (
    <Tabs defaultValue="account" className="flex min-h-0 flex-1 flex-col">
      <TabsList className="w-full shrink-0">
        <TabsTrigger value="account" className="flex-1">
          Account
        </TabsTrigger>
        <TabsTrigger value="settings" className="flex-1">
          Settings
        </TabsTrigger>
        <TabsTrigger value="database" className="flex-1">
          Database
        </TabsTrigger>
      </TabsList>

      <TabsContent value="account" className="min-h-0 flex-1 overflow-y-auto">
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
    </Tabs>
  );
}
