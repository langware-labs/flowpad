import React, { useEffect, useMemo, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { TypeId, type Project } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { notify } from '@src/notifications';
import { ShareButton } from '@src/components/entity-actions/ShareButton';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { GitShareGateDialog } from '@src/components/share-to-conversation/GitShareGateDialog';
import { folderShareSource } from '@src/hooks/share-sources';
import { useGitShareGate } from '@src/hooks/use-git-share-gate';
import type { ContextFolderTarget } from '@src/hooks/use-context-folder-for-rel';

interface ShareContextFolderButtonProps {
  /** The context folder to share — resolved by `useContextFolderForRel`. */
  folder: ContextFolderTarget;
  /** The scoped project — anchors the wizard + the conversation options. */
  project: Project | null | undefined;
}

/**
 * Share a context folder from the Assets header. Folders always travel over
 * Git, so the click preflights first: a folder that isn't Git-ready gets the
 * gate (set up git / commit & push) and only a ready one opens the share dialog.
 *
 * The gate lives in FRONT of `ShareToConversationDialog` rather than inside it:
 * the remediations are workdir-shaped (workdir + compute node + project), which
 * is the wrong altitude for a TypeId-shaped ShareSource, and the share dialog
 * has seven other dependents that shouldn't move for this.
 */
export function ShareContextFolderButton({
  folder,
  project,
}: ShareContextFolderButtonProps): React.ReactElement | null {
  const { t } = useLingui();
  // One dialog at a time: 'gate' → (ready) → 'share'. Two booleans would admit
  // "both open" and need an effect to forbid it.
  const [phase, setPhase] = useState<'none' | 'gate' | 'share'>('none');
  // A folder the user is merely browsing has no linked Folder entity. Mint one
  // (get-or-create — Folder ids are deterministic) on click, so Share works on
  // any directory without silently attaching it as a context folder.
  const [mintedTypeid, setMintedTypeid] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const typeid = folder.typeid ?? mintedTypeid;

  // Preflight only while the user is actually looking at the gate — the click
  // opens it, and the answer decides which face (or a straight hand-off).
  const gateFolder = useMemo(() => ({ ...folder, typeid }), [folder, typeid]);
  const gate = useGitShareGate(gateFolder, project, phase === 'gate' && !!typeid);

  const source = useMemo(
    () => (typeid ? folderShareSource(new TypeId(typeid), { label: folder.name }) : null),
    [typeid, folder.name],
  );

  // Ready → hand straight off to the share dialog; the gate never shows a face
  // for a folder that needs no fixing. The preflight is async, so this can only
  // be decided after the click.
  useEffect(() => {
    if (phase === 'gate' && gate.state === 'ready') setPhase('share');
  }, [phase, gate.state]);

  const handleClick = async () => {
    if (!typeid) {
      if (!project) return;
      setMinting(true);
      try {
        const minted = (await project.folderForPath(folder.workdir))?.typeid;
        if (!minted) {
          notify.error({ title: t`Could not resolve this folder` });
          return;
        }
        setMintedTypeid(minted);
      } catch (e) {
        notify.error({ title: t`Could not resolve this folder`, message: String(e) });
        return;
      } finally {
        setMinting(false);
      }
    }
    setPhase('gate');
  };

  return (
    <>
      <ShareButton
        onClick={() => void handleClick()}
        tooltip={t`Share ${folder.name} over Git`}
        variant="compact"
        // A folder ALWAYS travels as a Git origin, so the transport is part of
        // what this button is — say so on the glyph, not only in the tooltip.
        badge={GitBranch}
        disabled={minting || !project}
        testId="assets-header-share"
      />
      <GitShareGateDialog
        open={phase === 'gate'}
        onOpenChange={(open) => setPhase(open ? 'gate' : 'none')}
        folderName={folder.name}
        gate={gate}
      />
      {source && (
        <ShareToConversationDialog
          open={phase === 'share'}
          onClose={() => setPhase('none')}
          source={source}
          projectId={project?.id}
        />
      )}
    </>
  );
}
