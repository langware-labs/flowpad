import React, { useEffect, useState } from 'react';
import { dataManager, Dataset, DataSource, LOCAL_SOURCE, Project, projectSchemas, QueryRequest, TypeId } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Trans, useLingui } from '@lingui/react/macro';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { subjectEditorPointer } from '@src/navigation/subject-editor';

const SELECT =
  'rounded border bg-background px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring';

/**
 * New dataset: its name, the kind its rows are, the data source that hosts them (`local`, the
 * project's own file system, unless another is picked) and the folder inside that source.
 */
export const DatasetCreateDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string | null;
}> = ({ open, onOpenChange, projectId = null }) => {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [source, setSource] = useState(LOCAL_SOURCE);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);
  const [kinds, setKinds] = useState<{ kind: string; name: string }[]>([]);
  const [sources, setSources] = useState<{ name: string; provider: string }[]>([]);

  useEffect(() => {
    if (!open || !projectId) return;
    let live = true;
    void projectSchemas(projectId)
      .then((tree) => live && setKinds(tree.schemas.map((n) => ({ kind: n.kind, name: n.name }))))
      .catch(() => live && setKinds([]));
    void dataManager
      .query<DataSource>(
        new QueryRequest({
          type: DataSource.type,
          query: { match: { project_id: projectId } },
          scope: [],
          name: `dataset-create-sources-${projectId}`,
        }),
      )
      .then((rows) => live && setSources((rows ?? []).map((s) => ({ name: s.name, provider: s.provider }))))
      .catch(() => live && setSources([]));
    return () => {
      live = false;
    };
  }, [open, projectId]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || !kind) return;
    setBusy(true);
    try {
      const scope = projectId ? new TypeId(Project.type, projectId) : [];
      const saved = await new Dataset({
        name: trimmed,
        title: trimmed,
        // Typed rows are row folders (rows/<key>/row.json): what a data source mirrors.
        data_layout: 'io_folder',
        // Each row's input is a value of the chosen kind (the shape every GTM dataset declares).
        spec: { rows: [{ input: kind }] },
        data_source: source === LOCAL_SOURCE ? null : source,
        path: folder.trim() || null,
      }).save(scope);
      onOpenChange(false);
      setName('');
      setFolder('');
      notify.success({ title: t`Dataset created` });
      const pointer = await subjectEditorPointer(`dataset-${saved.id}`);
      if (pointer) navigation.openDock(pointer);
    } catch (error) {
      notify.error({
        title: t`Could not create the dataset`,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            <Trans>New dataset</Trans>
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <Input
            autoFocus
            value={name}
            placeholder={t`Name`}
            onChange={(e) => setName(e.target.value)}
            data-testid="dataset-create-name"
          />
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t`Kind`}</span>
            <select className={SELECT} value={kind} onChange={(e) => setKind(e.target.value)} data-testid="dataset-create-kind">
              <option value="">{kinds.length ? t`Choose the kind of each row` : t`This project defines no kind`}</option>
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>{k.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t`Data source`}</span>
            <select className={SELECT} value={source} onChange={(e) => setSource(e.target.value)} data-testid="dataset-create-source">
              <option value={LOCAL_SOURCE}>{`${LOCAL_SOURCE} · ${t`file system`}`}</option>
              {sources.map((s) => (
                <option key={s.name} value={s.name}>{s.provider ? `${s.name} · ${s.provider}` : s.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{t`Folder (optional)`}</span>
            <Input
              value={folder}
              placeholder={name.trim() || t`the dataset's name`}
              onChange={(e) => setFolder(e.target.value)}
              data-testid="dataset-create-folder"
            />
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={!name.trim() || !kind || busy} onClick={() => void create()} data-testid="dataset-create-submit">
            <Trans>Create</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
