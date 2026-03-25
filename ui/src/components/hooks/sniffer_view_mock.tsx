import { useContext } from '@sdk/react/hooks';
import { useHooksSniffer } from '@src/hooks/use-hooks-sniffer';
import { Badge } from '@src/components/ui/badge';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { ClipboardCopy, Info, Pause, Play, Power, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

export function HooksSnifferViewMock() {
  const { snifferEnabled } = useContext();
  const { events, isLoading, isToggling, isPaused, enable, disable, togglePause, clear } = useHooksSniffer();
  const [selectedRaw, setSelectedRaw] = useState<string | null>(null);

  const summary = useMemo(() => {
    return { total: events.length };
  }, [events]);

  const handleCopyRaw = async () => {
    if (!selectedRaw) return;
    await navigator.clipboard.writeText(selectedRaw);
  };

  const handleCopyLog = async () => {
    if (events.length === 0) return;
    const logLines = events.map((event) => JSON.stringify(JSON.parse(event.raw_line))).join('\n');
    await navigator.clipboard.writeText(logLines);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 p-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Hooks Sniffer</h3>
          <p className="text-xs text-muted-foreground">
            Live view of hook traffic. Uses a catch-all hook in the Claude user folder.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="text-xs">
            Total {summary.total}
          </Badge>
          <Badge variant={snifferEnabled ? 'secondary' : 'destructive'} className="text-xs">
            {snifferEnabled ? 'Enabled' : 'Disabled'}
          </Badge>
          <Button size="sm" variant="outline" onClick={togglePause} disabled={!snifferEnabled}>
            {isPaused ? <Play className="mr-1 h-3 w-3" /> : <Pause className="mr-1 h-3 w-3" />}
            {isPaused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => clear()} disabled={!snifferEnabled}>
            <Trash2 className="mr-1 h-3 w-3" />
            Clear
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void handleCopyLog()} disabled={events.length === 0}>
            <ClipboardCopy className="mr-1 h-3 w-3" />
            Copy Log
          </Button>
          <Button
            size="sm"
            variant={snifferEnabled ? 'destructive' : 'default'}
            onClick={() => void (snifferEnabled ? disable() : enable())}
            disabled={isLoading || isToggling}
          >
            <Power className="mr-1 h-3 w-3" />
            {snifferEnabled ? 'Disable' : 'Enable'}
          </Button>
        </div>
      </div>

      <div className="rounded-lg border">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[160px]">Timestamp</TableHead>
                <TableHead className="min-w-[130px]">Event</TableHead>
                <TableHead className="min-w-[180px]">Hook Entry</TableHead>
                <TableHead className="min-w-[220px]">Source</TableHead>
                <TableHead className="w-[90px] text-center">Info</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!snifferEnabled ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                    Enable the sniffer to start capturing hook traffic
                  </TableCell>
                </TableRow>
              ) : events.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                    No events captured yet
                  </TableCell>
                </TableRow>
              ) : (
                events.map((event) => (
                  <TableRow key={event.id}>
                    <TableCell className="text-xs text-muted-foreground">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="text-xs">
                        {event.event_type}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-xs" title={event.hook_entry_id || ''}>
                      {event.hook_entry_id || '-'}
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate text-xs" title={event.hook_file_path || ''}>
                      {event.hook_file_path || '-'}
                    </TableCell>
                    <TableCell className="text-center">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSelectedRaw(event.raw_line)}
                        title="View raw hook payload"
                      >
                        <Info className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <Dialog open={!!selectedRaw} onOpenChange={(open) => !open && setSelectedRaw(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Hook Payload</DialogTitle>
            <DialogDescription>Copy the full JSON payload for this hook event.</DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted/30 p-3">
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
              {selectedRaw}
            </pre>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setSelectedRaw(null)}>
              Close
            </Button>
            <Button size="sm" onClick={() => void handleCopyRaw()} disabled={!selectedRaw}>
              Copy
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
