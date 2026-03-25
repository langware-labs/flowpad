import { TabbedTerminal } from '@src/components/terminal';
import { useState } from 'react';

export function SessionsView() {
  const [activeSessionId, setActiveSessionId] = useState<string>('');

  return (
    <div className="h-full p-6">
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-foreground">Terminal Sessions</h2>
        <p className="mt-1 text-sm text-muted-foreground">Manage your terminal sessions</p>
      </div>
      <TabbedTerminal activeSessionId={activeSessionId} onActiveSessionChange={setActiveSessionId} />
    </div>
  );
}
