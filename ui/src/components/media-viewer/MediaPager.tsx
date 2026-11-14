import { useLingui } from '@lingui/react/macro';
import { fsStore, TypeId } from '@sdk';
import { useFS } from '@src/hooks/useFS';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { requestTabClose } from '@src/tabs/tab-close-request';
import { isLightboxMedia } from '@src/components/ui/media-lightbox';
import { isTextInputTarget } from '@src/utils/isTextInputTarget';
import {
  DEFAULT_SORT,
  folderOf,
  fsItemToFileItem,
  sortFileItems,
  useFolderViewStore,
} from '@src/components/simple-file-manager/folderViewStore';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';

/** The tab a step left, closed once the next file's tab is shown. */
let pagedFrom: string | null = null;

const OVERLAY =
  'absolute z-10 bg-background/60 opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100';
const STEP_BUTTON = `${OVERLAY} top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full border text-foreground hover:bg-muted`;

interface MediaPagerProps {
  /** The shown file's address, as the viewer received it. */
  path: string;
  typeId: TypeId;
  /** The shown file's path inside `typeId`'s filesystem. */
  filePath: string;
}

/**
 * Prev / next over the images and videos in the shown file's folder, in the
 * file browser's sort. Stops at the ends. Each step is a navigation; the shown
 * file is remembered so the browser selects it.
 */
export function MediaPager({ path, typeId, filePath }: MediaPagerProps) {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();
  const tabKey = currentDock?.tabHash;
  const folder = folderOf(filePath);
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  const fs = useFS(typeId);
  const listing = fs?.browse(folder);
  const sort = useFolderViewStore((s) => s.folders[folder]?.sort) ?? DEFAULT_SORT;
  const setShown = useFolderViewStore((s) => s.setShown);

  useEffect(() => setShown(folder, name), [folder, name, setShown]);
  // A step replaces the shown file: once the sibling's tab is on screen, the tab
  // it was paged from closes, so paging never piles up tabs.
  useEffect(() => {
    if (!tabKey || !pagedFrom || pagedFrom === tabKey) return;
    const from = pagedFrom;
    pagedFrom = null;
    requestTabClose(from);
  }, [tabKey]);
  useEffect(() => {
    if (!listing)
      void fsStore
        .getState()
        .listDirectory(typeId, folder)
        .catch(() => {});
  }, [listing, typeId, folder]);

  const media = useMemo(() => {
    if (!listing) return [];
    const files = listing.items
      .filter((item) => !item.is_dir && isLightboxMedia(item.name))
      .map((item) => fsItemToFileItem(item, folder));
    return sortFileItems(files, sort);
  }, [listing, folder, sort]);

  const index = media.findIndex((f) => f.name === name);
  const prev = index > 0 ? media[index - 1] : undefined;
  const next = index >= 0 ? media[index + 1] : undefined;

  // A sibling keeps the shown file's address form; only the name changes.
  const open = (sibling: string) => {
    pagedFrom = tabKey ?? null;
    navigation.openFile(`${path.slice(0, path.length - name.length)}${sibling}`);
  };

  // One listener for the pager's life; it reads the latest step through the ref.
  const stepRef = useRef<(key: string) => boolean>(() => false);
  stepRef.current = (key) => {
    const to = key === 'ArrowLeft' ? prev : key === 'ArrowRight' ? next : undefined;
    if (to) open(to.name);
    return !!to;
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTextInputTarget(e.target) && stepRef.current(e.key)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (index < 0 || media.length < 2) return null;

  return (
    <>
      {prev && (
        <button type="button" className={`${STEP_BUTTON} left-3`} title={t`Previous`} onClick={() => open(prev.name)}>
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}
      {next && (
        <button type="button" className={`${STEP_BUTTON} right-3`} title={t`Next`} onClick={() => open(next.name)}>
          <ChevronRight className="h-5 w-5" />
        </button>
      )}
      <div
        className={`${OVERLAY} bottom-2 left-1/2 -translate-x-1/2 rounded-md px-2 py-0.5 text-xs text-muted-foreground`}
      >
        {index + 1} / {media.length}
      </div>
    </>
  );
}
