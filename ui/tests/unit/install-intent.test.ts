import {
  INSTALL_REVIEW_BRANCH,
  contentInstallSpec,
  parseInstallIntent,
} from '@src/lib/content-install';
import { describe, expect, it } from 'vitest';

describe('Globex install link', () => {
  it('parses the public contract and builds the fixed shared install spec', () => {
    const parsed = parseInstallIntent(
      '?content_repo=https%3A%2F%2Fgithub.com%2Fcloudnsite%2Fcustomer-support.git&content_branch=main&name=Globex+agents',
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(contentInstallSpec(parsed.intent)).toEqual({
      name: 'Globex agents',
      content_repo: 'https://github.com/globex/customer-support.git',
      content_branch: 'main',
      scope: 'shared',
      review_branch: INSTALL_REVIEW_BRANCH,
    });
  });

  it.each([
    ['missing repository', '?content_branch=main&name=Globex'],
    ['non-GitHub repository', '?content_repo=https://gitlab.com/a/b.git&content_branch=main&name=Globex'],
    ['unsafe repository', '?content_repo=https://github.com/../b.git&content_branch=main&name=Globex'],
    ['unsafe branch', '?content_repo=https://github.com/a/b.git&content_branch=../main&name=Globex'],
  ])('rejects %s', (_label, search) => {
    expect(parseInstallIntent(search).ok).toBe(false);
  });
});
