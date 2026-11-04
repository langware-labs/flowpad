# Edge/frontend git-native platforms: Vercel, Netlify, Cloudflare Pages, Cloudflare Workers Builds (as of Nov 2026)

## Source of truth: the user's repo vs a copy held by the platform

### Takeaway
All four treat the user's external git repo (GitHub/GitLab/Bitbucket, and others) as the source of truth. They clone a commit, build it, and store the immutable build output. None of them documents keeping its own git history. The nearest exceptions are new git hosts appearing as *providers*: "Origin" on Vercel/Netlify and "Artifacts" on Cloudflare Workers.

### Cited Findings
- Vercel deploys every branch push automatically, and merges into the production branch, for GitHub, GitLab, Bitbucket, Origin (public beta) and Azure DevOps Pipelines — [Vercel Git](https://vercel.com/docs/git)
- Vercel can create a deployment from a Git reference: "Provide the unique ID (SHA) of a commit to build a deployment based on that specific commit," or a branch name to get its latest commit — [Vercel Git](https://vercel.com/docs/git)
- Unsupported or self-hosted providers (GHES, self-managed GitLab, Bitbucket DC) use CI plus the CLI (`vercel build` → `vercel deploy --prebuilt`) — [Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github)
- A Cloudflare Pages project connects to exactly one GitHub or GitLab repo. Self-hosted instances are not supported — [CF Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)
- Workers Builds connects a Worker "to a repository hosted by Artifacts, GitHub, or GitLab" — [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- Netlify lists Cursor Origin and Azure DevOps among its providers for commit statuses and PR comments — [Netlify repo permissions](https://docs.netlify.com/git/repo-permissions-linking/)

### Inferences
- The model is "repo is truth, platform holds artifacts": the platform holds an immutable artifact for each commit, not a git history.

### Gaps
- I did not verify what "Artifacts" (Cloudflare) and "Origin" (Vercel/Netlify) are. They may be git hosts run by the platform or a partner.
- None of the docs says whether a platform keeps a copy of the source snapshot after the build. Vercel has a `--public` flag that exposes the source at `/_src` ([vercel deploy](https://vercel.com/docs/cli/deploy)), which implies uploaded CLI source is stored.

## Repos with no remote: CLI upload of the working directory

### Takeaway
All three CLIs upload the local directory (either source or prebuilt output) with no git connection required. Git metadata is optional and either read from the local checkout or passed by hand. Wrangler Pages has explicit `--commit-hash`, `--commit-message` and `--commit-dirty` flags. Vercel's API carries `gitMetadata.dirty`. Netlify documents no git metadata for manual deploys.

### Cited Findings
- `vercel deploy` deploys the project directory. `--prebuilt` uploads `.vercel/output` from `vercel build`. `--archive=tgz` compresses the upload. `--prod` and `--target` choose the environment — [vercel deploy](https://vercel.com/docs/cli/deploy)
- "The CLI reads Git metadata from the local checkout. If the checkout has no Git metadata or uses a detached HEAD, a deployment can lack the branch association." You can set the branch by hand with `--meta githubDeployment=1 --meta githubCommitRef=<branch>` (GitLab and Bitbucket have equivalents) — [vercel deploy](https://vercel.com/docs/cli/deploy)
- Vercel's create-deployment REST API has a `gitMetadata` object with `commitSha` and `dirty` ("working tree has changed since the latest commit"). The example shows source "cli" — [Vercel REST create deployment](https://vercel.com/docs/rest-api/deployments/create-a-new-deployment)
- Community report: CLI deploys that carry github* meta appear in the Vercel dashboard but do not update the GitHub Deployments tab — [Vercel community](https://community.vercel.com/t/github-deployments-not-updated-when-using-vercel-cli-with-github-meta/29086)
- `vercel deploy --temporary` deploys without an account and returns a claim URL — [vercel deploy](https://vercel.com/docs/cli/deploy)
- `netlify deploy` uploads files "directly from your local project directory." It deploys to a draft URL by default, and `--prod` deploys to production. No git connection is required. A common pattern is "deploying prebuilt files … at the end of the CI tool tasks" — [Netlify CLI](https://docs.netlify.com/cli/get-started/)
- `wrangler pages deploy` flags: `--branch`, `--commit-hash` ("The SHA to attach to this deployment"), `--commit-message`, and `--commit-dirty` ("Whether or not the workspace should be considered dirty") — [Wrangler pages commands](https://developers.cloudflare.com/workers/wrangler/commands/pages/). Inside a git workspace, Wrangler reads the branch automatically — [CF Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- A Pages project created with Git integration cannot switch to Direct Upload later — [CF Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)
- `wrangler deploy` (Workers) creates a version and deploys it to 100% of traffic. A version can carry an optional message and tag, and records who created it, when, and from where — [Workers versions & deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/)

### Inferences
- For Workers, git provenance on a CLI deploy is free-form (`--message`/`--tag`), not a structured SHA field.

### Gaps
- Netlify's docs do not say whether CLI deploys record a SHA. I did not check how the Vercel CLI computes `dirty`.

## What gets deployed and how it is pinned (commit + immutable artifact)

### Takeaway
Git-triggered deploys build one specific commit SHA. Every deploy is an immutable, atomic artifact with a unique URL. Domains and aliases are pointers moved between artifacts.

### Cited Findings
- Vercel exposes `VERCEL_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_REF`, `VERCEL_GIT_PULL_REQUEST_ID` and related variables to each deployment — [Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github)
- If a build is in progress, Vercel queues newer pushes. Only the latest queued commit is built and the others are cancelled (`github.autoJobCancellation`) — [Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github)
- Netlify: "you always create a new deploy … No changes go live … before all changes have been uploaded." The permalink of every successful deploy "never changes" — [Netlify deploy overview](https://docs.netlify.com/site-deploys/overview/)
- Workers: a version captures the "complete state of your Worker at a point in time." A deployment points to one version, or to two with a traffic split (gradual deployments) — [Workers versions](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/)
- Workers Builds: each deployment gets "an immutable Deployment URL" — [Workers GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)

### Gaps
- None of the docs explicitly says that each artifact is content-addressed by commit.

## Where artifacts are stored, and how long

### Takeaway
Artifacts live in each platform's own storage under retention policies. The live or current deploys are always protected.

### Cited Findings
- Vercel default retention: Hobby and Pro keep 30 days for all states. Enterprise keeps canceled 30d, errored 90d, pre-production 180d, production 1yr. Always kept: deployments holding a production alias, the latest preview of an active branch, the last 10 created, the last 20 Ready production deployments (Pro), and others. Deleted deployments have a recovery period of up to 30 days. Retained output counts toward billed "Deployment Storage" — [Vercel retention](https://vercel.com/docs/deployment-retention)
- Netlify deletes deploys after 30 days (90 on paid plans). Enterprise can set up to 365 days. Never deleted: the published deploy, the latest successful production deploy, and the latest successful deploy of each branch — [Netlify manage deploys](https://docs.netlify.com/site-deploys/manage-deploys/)
- Workers Builds keeps builds and logs for 90 days. Wrangler shows and rolls back to the 100 most recent versions — [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/); [Workers rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)

### Gaps
- I found no retention figure for Cloudflare Pages deployments.

## Previews, production promotion, rollback

### Takeaway
All four give previews per branch or PR. Rollback means repointing to a stored artifact, not rebuilding. Vercel and Netlify say this explicitly; for Cloudflare it is implied.

### Cited Findings
- Vercel: every non-production branch gets a preview URL, and the PR comment links the latest push. Custom environments and branch domains handle staging. `vercel --prod --skip-domain` followed by `vercel promote` stages a production deployment and promotes it later — [Vercel Git](https://vercel.com/docs/git); [vercel deploy](https://vercel.com/docs/cli/deploy)
- Vercel Instant Rollback "points your domains back to the selected deployment." It does not change env vars (it is "a previous build"). It turns off auto-assignment of production domains until undone. Pro can roll back to any deployment previously aliased to production; Hobby only to the previous one — [Vercel Instant Rollback](https://vercel.com/docs/instant-rollback)
- Netlify: Deploy Previews per PR/MR or agent run (`deploy-preview-42--site`). Branch deploys are opt-in (`staging--site`). "Publish Deploy" on an old deploy "doesn't trigger a new deploy … Rollbacks are instantaneous." Locking stops auto-publish — [Netlify overview](https://docs.netlify.com/site-deploys/overview/); [Netlify manage deploys](https://docs.netlify.com/site-deploys/manage-deploys/)
- CF Pages: every branch gets a preview URL. Any successfully built production deployment is a rollback target; previews are not — [CF Pages rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/)
- Workers Builds: a production-branch build creates a version and promotes it to Active Deployment. Other branches create or update a Preview URL. Using `wrangler versions upload` builds without promoting. A rollback "immediately create[s] a new deployment with the version specified" — [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/); [Workers rollbacks](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/)

### Gaps
- Cloudflare's docs do not explicitly say "no rebuild" on rollback.

## Repo authentication and monorepos

### Takeaway
Repo access is through a GitHub App installation, scoped to all repos or selected repos, using short-lived installation tokens. SSH deploy keys appear only for Netlify submodules. Monorepos are handled with a root, base or package directory setting.

### Cited Findings
- Vercel's GitHub App requests read/write on Administration, Checks, Contents, Deployments, Pull Requests, Issues, Webhooks, Commit Statuses and Workflows, and read on Actions and Metadata. Private-repo commits deploy only if the commit author is a member of the Vercel team. PRs from forks need authorization — [Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github); [Vercel Git](https://vercel.com/docs/git)
- Vercel's import step sets the root directory. Monorepos can use a consolidated commit status, with "soft failure" projects that don't block merges — [Vercel Git](https://vercel.com/docs/git); [Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github)
- Netlify's GitHub App can be scoped to selected repos and uses "generated, limited-scope tokens that expire after one hour"; with the app, no deploy keys or manual webhooks are needed. Deploy keys (an SSH keypair whose private half Netlify holds) are used only for `ssh` submodules — [Netlify repo permissions](https://docs.netlify.com/git/repo-permissions-linking/)
- Netlify monorepos: the base directory is where install and build run; the package directory (UI-only setting) holds the site and its netlify.toml. Builds are triggered by changes in the base directory, and an ignore command narrows that — [Netlify monorepos](https://docs.netlify.com/build/configure-builds/monorepos/)
- Cloudflare's GitHub App: Cloudflare recommends "Only select repositories." Uninstalling it revokes access to all repos. Build watch paths restrict which projects build — [Workers GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/)
- Workers Builds fails if the dashboard Worker name does not match `name` in the Wrangler config in the root directory — [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)

### Gaps
- I did not retrieve the exact permission list for Cloudflare's GitHub App.

## Metadata written back to git

### Takeaway
Every platform writes back to git: commit statuses or check runs, PR comments with preview URLs, and (Vercel) GitHub Deployments plus repository_dispatch events.

### Cited Findings
- Vercel posts a commit status per project per commit (success, failed, or skipped). It uses the GitHub Deployments API, which fires `deployment_status` and can be disabled. It posts bot comments on PRs and commits, which can be silenced. It sends `repository_dispatch` events `vercel.deployment.{ready,success,error,canceled,ignored,skipped,pending,failed,promoted}` with the URL in `client_payload` — [Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github)
- Netlify writes GitHub commit checks (deploy summaries) and PR comments through the app. Azure DevOps and Cursor Origin get commit statuses and PR comments — [Netlify repo permissions](https://docs.netlify.com/git/repo-permissions-linking/)
- Cloudflare creates a check run per connected Worker or project per commit, with the Build ID under Details. It posts a PR comment with the build status and preview URL, keeping comment history — [Workers GitHub integration](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/); [CF Pages Git integration](https://developers.cloudflare.com/pages/configuration/git-integration/)

### Inferences
- Write-back happens only on git-triggered deploys. CLI uploads generally do not update the git host (the Vercel community report above).

### Gaps
- None noted.
