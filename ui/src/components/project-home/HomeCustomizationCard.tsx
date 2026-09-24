import { dataManager, Project, TypeId, type AssetDescriptor } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { AssetManagerPopover } from '@src/components/asset-manager/AssetManagerPopover';
import { useProcessAssets } from '@src/components/asset-manager/useProcessAssets';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import { useFS } from '@src/hooks/useFS';
import {
  HOME_BACKGROUND_FILE,
  HOME_BACKGROUND_PATH,
  HOME_CUSTOMIZATION_DIR,
  HOME_STRINGS_FILE,
} from '@src/components/home-customization';
import { isHomePageCandidate } from '@src/project-home-page/home-page-candidates';
import { isImageFile } from '@src/utils/clipboard-image';
import { notify } from '@src/notifications';
import { Check, Image as ImageIcon, Loader2, PackageSearch, RotateCcw, Trash2, Upload } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/** Non-null `useFS` return — `run` only invokes `work` once `fs` is present. */
type FS = NonNullable<ReturnType<typeof useFS>>;

interface HomeCustomizationCardProps {
  project: Project | null | undefined;
}

/**
 * Project "Home" customization editor — writes the same `.flow/customization/`
 * files the home surfaces read (see `useHomeCustomization`): `string.json`'s
 * `home_title` and the `home.png` background, both over the generic `fs`
 * upload/download API. The home page (what the Home button opens) is the one
 * exception: it lives in the project manifest, which only the backend writes,
 * so it goes through `Project.setHomePage` and is read back from that file
 * (`Project.openHomePage`). After a customization write we re-fetch the project
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

  const [busyHomePage, setBusyHomePage] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // What the button shows: what the manifest FILE declares, read through the
  // backend (`Project.openHomePage` → `declared`) — not an indexed row, which a
  // manifest that arrived with a clone or a share never gets. Set again the
  // moment a save lands.
  const [homePage, setHomePage] = useState<string | null>(null);
  useEffect(() => {
    if (!project?.id) return setHomePage(null);
    let live = true;
    Project.openHomePage(project.id)
      .then((resolved) => live && setHomePage(resolved.declared ?? null))
      .catch(() => live && setHomePage(null));
    return () => {
      live = false;
    };
  }, [project?.id]);
  // The declared asset, loaded for its name. Any type: the file names a TypeId,
  // and the picker offers every registered asset.
  const homePageTypeId = useMemo(() => (homePage ? new TypeId(homePage) : null), [homePage]);
  const { data: homePageAsset, notFound: homePageMissing } = useEntity(homePageTypeId);
  // The picker's own list is the backend's default staging set (what a session
  // can attach), which leaves agents out — and an agent is THE home page. So the
  // card asks for the whole asset catalog, for this project, only while open.
  const { types: assetTypes } = useAssetTypes({ withVaults: false });
  const homePageTypes = useMemo(() => assetTypes.map((type) => type.type_name), [assetTypes]);
  const homePageCandidates = useProcessAssets(null, {
    enabled: pickerOpen && !!project?.id,
    projectId: project?.id,
    types: homePageTypes,
  });

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
      // Re-FETCH the row: `customization` is computed server-side from the
      // files just written. `dataContext.refreshProject()` only re-publishes
      // the cached instance, so the card (and every home) kept the old value.
      if (project) await dataManager.refreshByTypeId(project.typeId).catch(() => null);
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
        await fs.upload(HOME_CUSTOMIZATION_DIR, [new File([json], HOME_STRINGS_FILE, { type: 'application/json' })]);
      },
      t`Home title saved`,
      t`Failed to save title`,
    );

  // Not a customization file: the home page is declared in the project
  // manifest, and only the backend writes the manifest (`set-home-page`, which
  // also refuses an asset outside this project). Null clears it.
  const saveHomePage = async (typeid: string | null) => {
    if (!project) return;
    setBusyHomePage(true);
    try {
      const { home_page } = await project.setHomePage(typeid);
      setHomePage(home_page);
      notify.success({ title: home_page ? t`Home page set` : t`Home page reset to the default home` });
    } catch (err) {
      notify.error({ title: err instanceof Error ? err.message : t`Failed to save the home page` });
    } finally {
      setBusyHomePage(false);
    }
  };

  const uploadBackground = (file: File) => {
    if (!isImageFile(file)) {
      notify.error({ title: t`Please choose an image file` });
      return;
    }
    return run(
      setBusyBg,
      // Store under the fixed `home.png` name regardless of the source filename.
      async (fs) =>
        fs
          .upload(HOME_CUSTOMIZATION_DIR, [new File([file], HOME_BACKGROUND_FILE, { type: file.type || 'image/png' })])
          .then(() => undefined),
      t`Home background updated`,
      t`Failed to upload image`,
    );
  };

  const removeBackground = () =>
    run(
      setBusyBg,
      (fs) => fs.delete(HOME_BACKGROUND_PATH).then(() => undefined),
      t`Home background removed`,
      t`Failed to remove image`,
    );

  return (
    <div className="rounded-lg border border-border p-4" data-testid="home-customization-card">
      <div className="mb-3 flex items-center gap-2">
        <ImageIcon className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">
          <Trans>Home</Trans>
        </h3>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        <Trans>
          Brand this project's home ({HOME_CUSTOMIZATION_DIR}). Applies on every home surface when this is the active
          project.
        </Trans>
      </p>

      {/* Home page — what Home and opening the project land on */}
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        <Trans>Home page</Trans>
      </label>
      <div className="mb-4 flex items-center gap-2">
        {/* The shared asset picker, one-shot (no `onUnpick`): it closes on pick.
            Centered so it escapes the project page's tab panel. */}
        <Button
          variant="outline"
          className="min-w-0 flex-1 justify-start text-sm font-normal"
          onClick={() => setPickerOpen(true)}
          disabled={busyHomePage || !project}
          data-testid="home-page-picker"
        >
          {busyHomePage ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
          ) : (
            <PackageSearch className="h-4 w-4 shrink-0" />
          )}
          <span className="ms-1.5 truncate">
            {!homePage ? (
              <Trans>Default home</Trans>
            ) : homePageMissing ? (
              // Declared, but no longer an asset here — Home falls back to the default.
              <Trans>Missing asset ({homePage})</Trans>
            ) : (
              (homePageAsset?.displayName ?? homePage)
            )}
          </span>
        </Button>
        {homePage && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void saveHomePage(null)}
            disabled={busyHomePage}
            title={t`Use the default home`}
            data-testid="home-page-reset"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="ms-1.5">
              <Trans>Default</Trans>
            </span>
          </Button>
        )}
        <AssetManagerPopover
          centered
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          assets={homePageCandidates}
          selectedTypeIds={homePage ? [homePage] : []}
          // Only what Home can actually open: this project's own assets and its
          // context folders' — the boundary the backend enforces.
          filter={(d: AssetDescriptor) => isHomePageCandidate(d, project?.context_roots ?? [])}
          onPick={(d: AssetDescriptor) => (d.typeid ? void saveHomePage(d.typeid) : undefined)}
          searchPlaceholder={t`Search assets…`}
        />
      </div>

      {/* Home title */}
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        <Trans>Home title</Trans>
      </label>
      <div className="mb-4 flex gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t`Keep the default greeting…`}
          className="text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && titleDirty) void saveTitle();
          }}
        />
        <Button onClick={() => void saveTitle()} disabled={!titleDirty || savingTitle}>
          {savingTitle ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          <span className="ms-1.5">
            <Trans>Save</Trans>
          </span>
        </Button>
      </div>

      {/* Background image */}
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        <Trans>Background image</Trans>
      </label>
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
            <span className="ms-1.5">{bgUrl ? <Trans>Replace</Trans> : <Trans>Upload</Trans>}</span>
          </Button>
          {bgUrl && (
            <Button variant="ghost" size="sm" onClick={() => void removeBackground()} disabled={busyBg}>
              <Trash2 className="h-3.5 w-3.5" />
              <span className="ms-1.5">
                <Trans>Remove</Trans>
              </span>
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
