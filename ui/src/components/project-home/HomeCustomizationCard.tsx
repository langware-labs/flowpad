import { dataContext, Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { useFS } from '@src/hooks/useFS';
import {
  HOME_BACKGROUND_FILE,
  HOME_BACKGROUND_PATH,
  HOME_CUSTOMIZATION_DIR,
  HOME_STRINGS_FILE,
} from '@src/components/home-customization';
import { isImageFile } from '@src/utils/clipboard-image';
import { notify } from '@src/notifications';
import { Check, Image as ImageIcon, Loader2, Trash2, Upload } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/** Non-null `useFS` return — `run` only invokes `work` once `fs` is present. */
type FS = NonNullable<ReturnType<typeof useFS>>;

interface HomeCustomizationCardProps {
  project: Project | null | undefined;
}

/**
 * Project "Home" customization editor — writes the same `.flow/customization/`
 * files the home surfaces read (see `useHomeCustomization`): `string.json`'s
 * `home_title` and the `home.png` background. Both ride the generic `fs`
 * upload/download API (no bespoke route); after a write we refresh the project
 * so the recomputed `customization` field (and every home) updates.
 */
export const HomeCustomizationCard: React.FC<HomeCustomizationCardProps> = ({ project }) => {
  const { t } = useLingui();
  // Stable across renders (keyed on id) so useFS doesn't re-subscribe each keystroke.
  // `project.typeId` derives from `project.id`, so the id is the only real dep.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const projectTypeId = useMemo(() => (project?.id ? project.typeId : undefined), [project?.id]);
  const fs = useFS(projectTypeId);
  const custom = project?.customization;

  const [title, setTitle] = useState(custom?.home_title ?? '');
  const [savingTitle, setSavingTitle] = useState(false);
  const [busyBg, setBusyBg] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const bgUrl = custom?.has_home_background && fs ? fs.getDownloadUrl(HOME_BACKGROUND_PATH) : null;
  const titleDirty = (title.trim() || null) !== (custom?.home_title ?? null);

  // Shared scaffold for every write: guard, spin, do the work, refresh so the
  // recomputed `customization` (and every home) updates, toast the outcome.
  const run = async (
    setBusy: (b: boolean) => void,
    work: (fs: FS) => Promise<void>,
    okMsg: string,
    failMsg: string,
  ) => {
    if (!fs) return;
    setBusy(true);
    try {
      await work(fs);
      await dataContext.refreshProject();
      notify.success({ title: okMsg });
    } catch (err) {
      notify.error({ title: err instanceof Error ? err.message : failMsg });
    } finally {
      setBusy(false);
    }
  };

  const saveTitle = () =>
    run(
      setSavingTitle,
      async (fs) => {
        const json = `${JSON.stringify({ home_title: title.trim() }, null, 2)}\n`;
        await fs.upload(HOME_CUSTOMIZATION_DIR, [
          new File([json], HOME_STRINGS_FILE, { type: 'application/json' }),
        ]);
      },
      t`Home title saved`,
      t`Failed to save title`,
    );

  const uploadBackground = (file: File) => {
    if (!isImageFile(file)) {
      notify.error({ title: t`Please choose an image file` });
      return;
    }
    return run(
      setBusyBg,
      // Store under the fixed `home.png` name regardless of the source filename.
      async (fs) =>
        fs.upload(HOME_CUSTOMIZATION_DIR, [
          new File([file], HOME_BACKGROUND_FILE, { type: file.type || 'image/png' }),
        ]).then(() => undefined),
      t`Home background updated`,
      t`Failed to upload image`,
    );
  };

  const removeBackground = () =>
    run(setBusyBg, (fs) => fs.delete(HOME_BACKGROUND_PATH).then(() => undefined), t`Home background removed`, t`Failed to remove image`);

  return (
    <div className="rounded-lg border border-border p-4" data-testid="home-customization-card">
      <div className="mb-3 flex items-center gap-2">
        <ImageIcon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium"><Trans>Home</Trans></h3>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        <Trans>Brand this project's home ({HOME_CUSTOMIZATION_DIR}). Applies on every home surface when this is the active project.</Trans>
      </p>

      {/* Home title */}
      <label className="mb-1 block text-xs font-medium text-muted-foreground"><Trans>Home title</Trans></label>
      <div className="mb-4 flex gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t`Keep the default greeting…`}
          className="text-sm"
          onKeyDown={(e) => { if (e.key === 'Enter' && titleDirty) void saveTitle(); }}
        />
        <Button onClick={() => void saveTitle()} disabled={!titleDirty || savingTitle}>
          {savingTitle ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          <span className="ml-1.5"><Trans>Save</Trans></span>
        </Button>
      </div>

      {/* Background image */}
      <label className="mb-1 block text-xs font-medium text-muted-foreground"><Trans>Background image</Trans></label>
      <div className="flex items-center gap-3">
        <div className="flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40">
          {bgUrl ? (
            <img src={bgUrl} alt={t`Home background`} className="h-full w-full object-cover" />
          ) : (
            <ImageIcon className="h-5 w-5 text-muted-foreground/50" />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} disabled={busyBg}>
            {busyBg ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            <span className="ml-1.5">{bgUrl ? <Trans>Replace</Trans> : <Trans>Upload</Trans>}</span>
          </Button>
          {bgUrl && (
            <Button variant="ghost" size="sm" onClick={() => void removeBackground()} disabled={busyBg}>
              <Trash2 className="h-3.5 w-3.5" />
              <span className="ml-1.5"><Trans>Remove</Trans></span>
            </Button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = ''; // allow re-selecting the same file
            if (file) void uploadBackground(file);
          }}
        />
      </div>
    </div>
  );
};
