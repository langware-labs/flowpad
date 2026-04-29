import { useSettings } from '@sdk/react/hooks/use-settings';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { DatabasePaths, TerminalType } from '@sdk';
import { useSystemTools } from '@src/hooks/use-system-tools';
import { Button } from '@src/components/ui/button';
import { Checkbox } from '@src/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@src/components/ui/collapsible';
import { Label } from '@src/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@src/components/ui/radio-group';
import { useToast } from '@src/hooks/use-toast';
import { AlertTriangle, BarChart3, ChevronDown, Copy, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DbStatsDialog } from './db-stats';

export function DangerZone() {
  const { currentActivity, backup, clearAllData, getPaths, openBackupFolder, openDbFolder, openLogsFolder } = useSystemTools();
  const isClearing = currentActivity === 'clear';
  const isBackingUp = currentActivity === 'archive';
  const [isOpen, setIsOpen] = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showDbStats, setShowDbStats] = useState(false);
  const [paths, setPaths] = useState<DatabasePaths | null>(null);
  const { toast } = useToast();
  const { settings } = useSettings();

  // Fetch paths on mount
  useEffect(() => {
    void getPaths().then(setPaths).catch(console.error);
  }, [getPaths]);

  const handleClearDb = () => {
    setShowClearConfirm(true);
  };

  const confirmClearDb = async () => {
    setShowClearConfirm(false);
    try {
      const result = await clearAllData();
      toast({
        title: 'Database Cleared',
        description: result.message || 'All data has been cleared. Redirecting to home...',
      });
      setTimeout(() => { window.location.href = '/'; }, 1500);
    } catch (error) {
      console.error('Failed to clear database:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to clear database',
        variant: 'destructive',
      });
    }
  };

  const handleBackupDb = async () => {
    try {
      const result = await backup();
      toast({ title: 'Database Backed Up', description: result.message });
    } catch (error) {
      console.error('Failed to backup database:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to backup database',
        variant: 'destructive',
      });
    }
  };

  const handleOpenFolder = async (folderType: 'backup' | 'db' | 'logs') => {
    try {
      if (folderType === 'backup') await openBackupFolder();
      else if (folderType === 'db') await openDbFolder();
      else await openLogsFolder();
    } catch (error) {
      console.error(`Failed to open ${folderType} folder:`, error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : `Failed to open ${folderType} folder`,
        variant: 'destructive',
      });
    }
  };

  const handleCopyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast({
        title: 'Copied',
        description: 'Path copied to clipboard',
      });
    } catch (error) {
      console.error('Failed to copy path:', error);
      toast({
        title: 'Error',
        description: 'Failed to copy path to clipboard',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="mt-6">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <div className="flex cursor-pointer items-center justify-between border-b pb-3 text-sm font-medium text-muted-foreground hover:text-foreground">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              <span>Danger Zone</span>
            </div>
            <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4">
          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => void handleBackupDb()} disabled={isBackingUp} className="flex-1">
                  {isBackingUp ? 'Backing up...' : 'Backup DB'}
                </Button>
                <Button variant="outline" onClick={() => setShowDbStats(true)} className="flex-1">
                  <BarChart3 className="mr-2 h-4 w-4" />
                  DB Stats
                </Button>
              </div>
              <Button variant="destructive" onClick={handleClearDb} disabled={isClearing} className="w-full">
                {isClearing ? 'Clearing...' : 'Clear All Data'}
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => void handleOpenFolder('backup')} className="flex-1">
                  <FolderOpen className="mr-2 h-4 w-4" />
                  Open Backup Folder
                </Button>
                <Button variant="outline" onClick={() => void handleOpenFolder('db')} className="flex-1">
                  <FolderOpen className="mr-2 h-4 w-4" />
                  Open DB Folder
                </Button>
              </div>
              <Button variant="outline" onClick={() => void handleOpenFolder('logs')} className="w-full">
                <FolderOpen className="mr-2 h-4 w-4" />
                Open Logs Folder
              </Button>
              {paths?.logs_folder && (
                <div
                  className="flex cursor-pointer items-center gap-2 rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                  onClick={() => void handleCopyPath(paths.logs_folder)}
                  title="Click to copy path"
                >
                  <Copy className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate font-mono">{paths.logs_folder}</span>
                </div>
              )}

              {/* Settings */}
              <div className="mt-4 border-t pt-4">
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="show-system-skills"
                    checked={settings.showSystemSkills}
                    onCheckedChange={(checked) => {
                      settings.showSystemSkills = checked === true;
                    }}
                  />
                  <Label htmlFor="show-system-skills" className="cursor-pointer text-sm">
                    Show system skills
                  </Label>
                </div>

                <div className="mt-4">
                  <Label className="mb-2 block text-sm font-medium">External Terminal</Label>
                  <p className="mb-2 text-xs text-muted-foreground">
                    The in-app terminal is always the primary shell. This setting controls
                    whether a sidecar OS Terminal window is also opened.
                  </p>
                  <RadioGroup
                    value={settings.defaultTerminal}
                    onValueChange={(value) => {
                      settings.defaultTerminal = value as TerminalType;
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value={TerminalType.BUILTIN_XTERM} id="terminal-builtin" />
                      <Label htmlFor="terminal-builtin" className="cursor-pointer text-sm">
                        In-app only
                      </Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <RadioGroupItem value={TerminalType.EXTERNAL_TERMINAL} id="terminal-external" />
                      <Label htmlFor="terminal-external" className="cursor-pointer text-sm">
                        Also open sidecar OS Terminal
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <ConfirmDialog
        open={showClearConfirm}
        onOpenChange={setShowClearConfirm}
        title="Clear All Data"
        description="Are you sure you want to clear all data from the database? This will create a backup first and reload the page."
        confirmLabel="Clear All Data"
        variant="destructive"
        onConfirm={() => void confirmClearDb()}
      />

      <DbStatsDialog open={showDbStats} onOpenChange={setShowDbStats} />
    </div>
  );
}
