import { FlowData, ProcessorStatus } from '@sdk';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { cn } from '@src/lib/utils';
import { FileText, AlertCircle } from 'lucide-react';
import { StatusBadge } from './shared/status-indicator';

interface FullProgressModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: ProcessorStatus;
  filePath?: string;
  flowData?: readonly FlowData[];
  flowDataCount?: number;
  className?: string;
}

export function FullProgressModal({
  open,
  onOpenChange,
  status,
  filePath,
  flowData = [],
  flowDataCount = 0,
  className,
}: FullProgressModalProps) {
  const fileName = filePath ? getFileName(filePath) : 'Instruction';
  const isError = status === ProcessorStatus.ERROR;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={cn('max-w-2xl', className)}>
        <DialogHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <DialogTitle className="font-mono text-base">{fileName}</DialogTitle>
          </div>
          <StatusBadge status={status} />
        </DialogHeader>

        <ScrollArea className="max-h-[70vh]">
          <div className="space-y-4 pr-4">
            {/* FlowData Outputs */}
            {flowDataCount > 0 && (
              <div className="rounded-lg border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-medium">Outputs</span>
                  <span className="text-xs text-muted-foreground">{flowDataCount} items</span>
                </div>
                <div className="space-y-1">
                  {flowData.slice(-5).map((fd, i) => (
                    <div key={i} className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1 text-xs">
                      <span className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-primary">
                        {fd.elementType}
                      </span>
                      <span className="truncate text-muted-foreground">
                        {typeof fd.data === 'string'
                          ? fd.data.substring(0, 50) + (fd.data.length > 50 ? '...' : '')
                          : '[object]'}
                      </span>
                    </div>
                  ))}
                  {flowDataCount > 5 && (
                    <div className="text-center text-xs text-muted-foreground">... and {flowDataCount - 5} more</div>
                  )}
                </div>
              </div>
            )}

            {/* Error Details */}
            {isError && <ErrorDetails />}

            {/* File Path */}
            {filePath && (
              <div className="text-xs text-muted-foreground">
                <span className="text-muted-foreground/60">Path: </span>
                <span className="font-mono">{filePath}</span>
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function ErrorDetails() {
  return (
    <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30">
      <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
        <AlertCircle className="h-4 w-4" />
        <span className="font-medium">Error</span>
      </div>
    </div>
  );
}

function getFileName(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}
