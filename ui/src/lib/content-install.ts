import { t } from '@lingui/core/macro';
import { gitOriginFromUrl } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';

export const INSTALL_REVIEW_BRANCH = 'flowpad/install-cloudnsite-agents';
const SAFE_BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
const SAFE_GITHUB_SLUG = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export interface InstallIntent {
  contentRepo: string;
  contentBranch: string;
  name: string;
}

export interface ContentInstallSpec {
  name: string;
  content_repo: string;
  content_branch: string;
  scope: 'shared';
  review_branch: typeof INSTALL_REVIEW_BRANCH;
}

export type InstallIntentResult = { ok: true; intent: InstallIntent } | { ok: false; message: string };

export interface InstallNavigationResult {
  project?: { id?: string };
  install_result?: {
    target_project_id?: string;
    auto_launch_journey_id?: string | null;
  };
}

export function parseInstallIntent(search: string): InstallIntentResult {
  const params = new URLSearchParams(search);
  const contentRepo = (params.get('content_repo') ?? '').trim();
  const contentBranch = (params.get('content_branch') ?? '').trim();
  const origin = gitOriginFromUrl(contentRepo, contentBranch);
  if (!origin || origin.provider !== 'github') {
    return { ok: false, message: t`This install link must name a GitHub content repository.` };
  }
  if (
    !SAFE_GITHUB_SLUG.test(origin.owner) ||
    !SAFE_GITHUB_SLUG.test(origin.name) ||
    origin.owner.includes('..') ||
    origin.name.includes('..')
  ) {
    return { ok: false, message: t`This install link has an invalid GitHub repository.` };
  }
  if (!contentBranch || !SAFE_BRANCH.test(contentBranch) || contentBranch.endsWith('/')) {
    return { ok: false, message: t`This install link has an invalid content branch.` };
  }
  const name = (params.get('name') ?? origin.name ?? '').trim();
  if (!name || name.length > 120) {
    return { ok: false, message: t`This install link has an invalid display name.` };
  }
  return { ok: true, intent: { contentRepo, contentBranch, name } };
}

export function contentInstallSpec(intent: InstallIntent): ContentInstallSpec {
  return {
    name: intent.name,
    content_repo: intent.contentRepo,
    content_branch: intent.contentBranch,
    scope: 'shared',
    review_branch: INSTALL_REVIEW_BRANCH,
  };
}

/** Convert the box install result into its URL-first Project landing. */
export function installProjectLandingUrl(host: string, result: InstallNavigationResult): string | null {
  const projectId = result.install_result?.target_project_id || result.project?.id;
  if (!projectId) return null;

  // DockPointer owns the project-route grammar and the journey param name;
  // spelling either out here would be a second owner of both.
  const projectPath = DockPointer.forProject(projectId)
    .withJourney(result.install_result?.auto_launch_journey_id ?? null)
    .toUrl();
  const url = new URL(host);
  if (url.searchParams.has('next')) {
    url.searchParams.set('next', projectPath);
    return url.toString();
  }
  return new URL(projectPath, url.origin).toString();
}
