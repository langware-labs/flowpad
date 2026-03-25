import { dataContext, fsManager } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@src/components/ui/collapsible';
import { useToast } from '@src/hooks/use-toast';
import { ChevronDown, FileText, FolderOpen } from 'lucide-react';
import { useEffect, useState } from 'react';

// Parse log filename timestamp: DDMmmYYYY_HH_MM_SS.log -> Date
function parseLogFilename(filename: string): Date | null {
  // Extract just the filename without path
  const name = filename.split('/').pop() || filename;
  // Match pattern: 12Jan2026_11_41_42.log
  const match = name.match(/^(\d{1,2})([A-Za-z]{3})(\d{4})_(\d{2})_(\d{2})_(\d{2})\.log$/);
  if (!match) return null;

  const [, day, month, year, hour, minute, second] = match;
  const months: Record<string, number> = {
    Jan: 0,
    Feb: 1,
    Mar: 2,
    Apr: 3,
    May: 4,
    Jun: 5,
    Jul: 6,
    Aug: 7,
    Sep: 8,
    Oct: 9,
    Nov: 10,
    Dec: 11,
  };

  const monthNum = months[month];
  if (monthNum === undefined) return null;

  return new Date(parseInt(year), monthNum, parseInt(day), parseInt(hour), parseInt(minute), parseInt(second));
}

export function SystemLog() {
  const [isOpen, setIsOpen] = useState(false);
  const [currentLogFile, setCurrentLogFile] = useState<string | null>(null);
  const { toast } = useToast();

  const computeNode = dataContext.computeNode;
  const desktopInfo = dataContext.bootstrapInfo?.desktop_info;

  // Construct full path to logs folder (needs leading / for VFS)
  const logsPath =
    desktopInfo?.home && desktopInfo?.workspace && desktopInfo?.logs
      ? `/${desktopInfo.home}/${desktopInfo.workspace}/${desktopInfo.logs}`
      : null;

  useEffect(() => {
    // Fetch log files to get the current (newest) one
    if (computeNode?.typeId && logsPath) {
      fsManager
        .listDirectory(computeNode.typeId, logsPath)
        .then((result) => {
          const logFiles = result.items
            .filter((f) => f.name?.endsWith('.log'))
            .sort((a, b) => {
              // Sort by parsed filename timestamp (newest first)
              const dateA = parseLogFilename(a.name || '');
              const dateB = parseLogFilename(b.name || '');
              if (!dateA && !dateB) return 0;
              if (!dateA) return 1;
              if (!dateB) return -1;
              return dateB.getTime() - dateA.getTime();
            });
          if (logFiles.length > 0) {
            // Extract just the filename from the full path
            const fullName = logFiles[0].name || '';
            const fileName = fullName.split('/').pop() || fullName;
            setCurrentLogFile(fileName);
          }
        })
        .catch(() => setCurrentLogFile(null));
    }
  }, [computeNode?.typeId, logsPath]);

  const handleOpenLogFile = async () => {
    if (!computeNode?.typeId || !logsPath || !currentLogFile) return;
    try {
      await fsManager.open(computeNode.typeId, `${logsPath}/${currentLogFile}`);
    } catch (error) {
      console.error('Failed to open log file:', error);
      toast({
        title: 'Error',
        description: 'Failed to open log file',
        variant: 'destructive',
      });
    }
  };

  const handleOpenArchive = async () => {
    if (!computeNode?.typeId || !logsPath) return;
    try {
      await fsManager.open(computeNode.typeId, logsPath);
    } catch (error) {
      console.error('Failed to open logs folder:', error);
      toast({
        title: 'Error',
        description: 'Failed to open logs folder',
        variant: 'destructive',
      });
    }
  };

  if (!logsPath) return null;

  return (
    <div className="mt-6">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <div className="flex cursor-pointer items-center justify-between border-b pb-3 text-sm font-medium text-muted-foreground hover:text-foreground">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4" />
              <span>System Log</span>
            </div>
            <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4">
          <div className="flex flex-col gap-3 p-4">
            <div className="text-sm text-muted-foreground">
              {currentLogFile ? `Active log: ${currentLogFile}` : 'No log file found'}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => void handleOpenLogFile()}
                disabled={!currentLogFile}
                className="flex-1"
              >
                <FileText className="mr-2 h-4 w-4" />
                Open Log File
              </Button>
              <Button variant="outline" onClick={() => void handleOpenArchive()} className="flex-1">
                <FolderOpen className="mr-2 h-4 w-4" />
                Archive
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
