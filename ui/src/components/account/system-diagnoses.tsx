import { useCallback, useEffect, useState } from 'react';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@src/components/ui/table';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import { Stethoscope, Trash2 } from 'lucide-react';
import { systemTools, FlowpadDiagnosis } from '@sdk';

/**
 * Account-settings entry point for the recorded `flowpad_diagnosis` entities.
 * The button opens a dialog with a table of all diagnoses (title / symptoms /
 * root-cause / fix) and a per-row delete. Backed by
 * `systemTools.getDiagnoses()` / `systemTools.deleteDiagnosis()`.
 */
export function SystemDiagnoses() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<FlowpadDiagnosis[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await systemTools.getDiagnoses());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const handleDelete = useCallback(
    async (id: string) => {
      await systemTools.deleteDiagnosis(id);
      await refresh();
    },
    [refresh],
  );

  return (
    <>
      <Button variant="outline" className="w-full" onClick={() => setOpen(true)}>
        <Stethoscope className="mr-2 h-4 w-4" />
        System Diagnoses
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>System Diagnoses</DialogTitle>
            <DialogDescription>
              Issue diagnoses recorded by the assistant — title, symptoms, root cause, and fix.
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No diagnoses recorded.</p>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[160px]">Title</TableHead>
                    <TableHead>Symptoms</TableHead>
                    <TableHead>Root cause</TableHead>
                    <TableHead>Fix</TableHead>
                    <TableHead className="w-[60px] text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="align-top font-medium">{d.title || d.name || '—'}</TableCell>
                      <TableCell className="align-top whitespace-pre-wrap text-xs">{d.symptoms || '—'}</TableCell>
                      <TableCell className="align-top whitespace-pre-wrap text-xs">{d.rca || '—'}</TableCell>
                      <TableCell className="align-top whitespace-pre-wrap text-xs">{d.fix || '—'}</TableCell>
                      <TableCell className="text-right align-top">
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label="Delete diagnosis"
                          onClick={() => setConfirmId(d.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmId !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmId(null);
        }}
        title="Delete diagnosis"
        description="Delete this diagnosis? This cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={() => {
          const target = confirmId;
          setConfirmId(null);
          if (target) void handleDelete(target);
        }}
      />
    </>
  );
}
