import { TabbedTerminal, useStandardTabNav } from '@src/components/terminal';

export function SessionsView() {
  const { onTabClick, onTabClose, onTabOpen } = useStandardTabNav();

  return (
    <div className="h-full p-6">
      <div className="mb-4">
        <h2 className="text-2xl font-bold text-foreground">Terminal Sessions</h2>
        <p className="mt-1 text-sm text-muted-foreground">Manage your terminal sessions</p>
      </div>
      <TabbedTerminal
        onTabClick={onTabClick}
        onTabClose={onTabClose}
        onTabOpen={onTabOpen}
      />
    </div>
  );
}
