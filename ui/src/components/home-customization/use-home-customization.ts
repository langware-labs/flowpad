import { useProject } from '@src/hooks/useProject';
import { useFS } from '@src/hooks/useFS';
import { useMemo } from 'react';

/** Project-relative customization directory. Single source for every path below. */
export const HOME_CUSTOMIZATION_DIR = '.flow/customization';
/** Filenames within the customization dir (mirror of backend `Project.customization`). */
export const HOME_BACKGROUND_FILE = 'home.png';
export const HOME_STRINGS_FILE = 'string.json';
/** Full project-relative paths, derived from the dir + filenames. */
export const HOME_BACKGROUND_PATH = `${HOME_CUSTOMIZATION_DIR}/${HOME_BACKGROUND_FILE}`;
export const HOME_STRINGS_PATH = `${HOME_CUSTOMIZATION_DIR}/${HOME_STRINGS_FILE}`;

export interface HomeCustomization {
  /** `.flow/customization/string.json` `home_title`, or null. Overrides the greeting. */
  homeTitle: string | null;
  /** Download URL for `home.png` when present, else null. For an `<img>`/CSS background. */
  homeBackgroundUrl: string | null;
}

/**
 * Per-project home branding, sourced from the ACTIVE project's
 * `.flow/customization/` (see backend `Project.customization`). Shared by every
 * home surface (standard `HomeLanding`, vibe `VibeNewChat`, …) so the branding
 * is applied identically everywhere rather than re-derived per component.
 */
export function useHomeCustomization(): HomeCustomization {
  const { project } = useProject();
  const custom = project?.customization;

  // Stable across renders (keyed on id) so useFS doesn't re-subscribe each render.
  // `project.typeId` derives from `project.id`, so the id is the only real dep.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const projectTypeId = useMemo(() => (project?.id ? project.typeId : undefined), [project?.id]);
  const fs = useFS(projectTypeId);

  const homeTitle = custom?.home_title || null; // already trimmed server-side
  const homeBackgroundUrl =
    custom?.has_home_background && fs ? fs.getDownloadUrl(HOME_BACKGROUND_PATH) : null;

  return { homeTitle, homeBackgroundUrl };
}
