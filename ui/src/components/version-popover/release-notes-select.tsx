import apiClient from '@sdk/client';
import { useLingui } from '@lingui/react/macro';
import { useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import type { ReleaseNotesFile } from '@src/components/version-popover/version-popover';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';


/** The version picker on a release-notes file: lists every version whose notes ship with this install. */
export function ReleaseNotesSelect({ path }: { path: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const isNotesFile = path.endsWith('/RELEASE_NOTES.md');
  const [notes, setNotes] = useState<ReleaseNotesFile[]>([]);

  useEffect(() => {
    if (!isNotesFile) return;
    let live = true;
    void apiClient
      .get<ReleaseNotesFile[]>('/api/v1/version/release-notes')
      .then((list) => live && setNotes(list))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [isNotesFile]);

  const current = notes.find((n) => `/${path}`.endsWith(n.path))?.version;
  if (!current) return null;
  return (
    <Select
      value={current}
      onValueChange={(version) => {
        const target = notes.find((n) => n.version === version);
        if (target) navigation.openMachinePath(target.path, LOCAL_COMPUTE_NODE);
      }}
    >
      <SelectTrigger
        className="ms-2 h-6 w-auto gap-1 rounded-full px-2 font-mono text-[11px]"
        title={t`Release notes version`}
        data-testid="release-notes-version-select"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {notes.map((n) => (
          <SelectItem key={n.version} value={n.version} className="font-mono text-xs">
            v{n.version}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
