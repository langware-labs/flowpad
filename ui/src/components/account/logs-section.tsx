import { Button } from '@src/components/ui/button';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Terminal } from 'lucide-react';
import { SystemLog } from './system-log';
import { SystemDiagnoses } from './system-diagnoses';

export function LogsSection() {
  const { navigation } = useDockNavigation();

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="outline"
        className="w-full"
        onClick={() => navigation.openLens('cli', 'log', 'all')}
      >
        <Terminal className="mr-2 h-4 w-4" />
        CLI Invocation Log
      </Button>

      <SystemDiagnoses />

      <SystemLog />
    </div>
  );
}
