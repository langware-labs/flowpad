import { dataContext, fsManager, TypeId } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@src/components/ui/collapsible';
import { notify } from '@src/notifications';
import { Trans, useLingui } from '@lingui/react/macro';
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

// Subdirectories to scan for log files
const LOG_SUBDIRS = ['server', 'monitor', 'main_desktop'] as const;

// Find the newest log file across all subdirectories
async function findNewestLogFile(
  typeId: TypeId,
  logsPath: string,
): Promise<{ path: string; name: string; date: Date } | null> {
  let newest: { path: string; name: string; date: Date } | null = null;

  for (const subdir of LOG_SUBDIRS) {
    const subdirPath = `${logsPath}/${subdir}`;
    try {
      const result = await fsManager.listDirectory(typeId, subdirPath);
      for (const item of result.items) {
        const fname = item.name?.split('/').pop() || '';
        const date = parseLogFilename(fname);
        if (date && (!newest || date.getTime() > newest.date.getTime())) {
          newest = { path: `${subdirPath}/${fname}`, name: `${subdir}/${fname}`, date };
        }
      }
    } catch {
      // Subdirectory may not exist yet
    }
  }

  return newest;
}

export function SystemLog() {
  const { t } = useLingui();
  const [isOpen, setIsOpen] = useState(false);
  const [currentLogFile, setCurrentLogFile] = useState<{ path: string; name: string } | null>(null);

  const computeNode = dataContext.computeNode;
  const desktopInfo = dataContext.bootstrapInfo?.desktop_info;

  // Use paths.logs from bootstrap (already points to ~/.flow/logs as VFS-relative)
  const logsPath = desktopInfo?.paths?.logs ? `/${desktopInfo.paths.logs}` : null;

  useEffect(() => {
    if (computeNode?.typeId && logsPath) {
      findNewestLogFile(computeNode.typeId, logsPath)
        .then((newest) => {
          if (newest) {
            setCurrentLogFile({ path: newest.path, name: newest.name });
          } else {
            setCurrentLogFile(null);
          }
        })
        .catch(() => setCurrentLogFile(null));
    }
  }, [computeNode?.typeId, logsPath]);

  const handleOpenLogFile = async () => {
    if (!computeNode?.typeId || !currentLogFile) return;
    try {
      await fsManager.open(computeNode.typeId, currentLogFile.path);
    } catch (error) {
      console.error('Failed to open log file:', error);
      notify.error({
        title: t`Error`,
        message: t`Failed to open log file`,
      });
    }
  };

  const handleOpenArchive = async () => {
    if (!computeNode?.typeId || !logsPath) return;
    try {
      await fsManager.open(computeNode.typeId, logsPath);
    } catch (error) {
      console.error('Failed to open logs folder:', error);
      notify.error({
        title: t`Error`,
        message: t`Failed to open logs folder`,
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
              <span>
                <Trans>System Log</Trans>
              </span>
            </div>
            <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </div>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-4">
          <div className="flex flex-col gap-3 p-4">
            <div className="text-sm text-muted-foreground">
              {currentLogFile ? <Trans>Active log: {currentLogFile.name}</Trans> : <Trans>No log file found</Trans>}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => void handleOpenLogFile()}
                disabled={!currentLogFile}
                className="flex-1"
              >
                <FileText className="me-2 h-4 w-4" />
                <Trans>Open Log File</Trans>
              </Button>
              <Button variant="outline" onClick={() => void handleOpenArchive()} className="flex-1">
                <FolderOpen className="me-2 h-4 w-4" />
                <Trans>Archive</Trans>
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
