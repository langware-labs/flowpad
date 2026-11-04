# App/container git-native platforms: deployment flow (Heroku, Render, Railway, Fly.io, Replit, HF Spaces)

## Source of truth: platform-hosted git vs user's GitHub

### Takeaway
Only Heroku and Hugging Face Spaces host a real git remote that you push your own history to. Heroku tells you not to rely on its remote; on HF the Space repo is the canonical, durable store. Render and Railway build from a connected GitHub repo or a CLI upload. Fly builds from the local directory. Replit publishes a snapshot of the workspace.

### Cited Findings
- **Heroku git:** `heroku create` / `heroku git:remote` adds a remote at `https://git.heroku.com/<app>.git`. You deploy with `git push heroku main`. Only pushes to the `main`/`master` branch deploy; to deploy another branch, push it as `git push heroku testbranch:main`. — [Heroku Git](https://devcenter.heroku.com/articles/git)
- **Heroku git is not durable.** The repo "isn't intended to be a stable git repository" and is not a backup; Heroku recommends GitHub/GitLab/Bitbucket. The `heroku-repo` reset deletes all source and history. Limits: a HEAD checkout over 1 GB is not allowed, over 600 MB is not recommended, and pushes are capped at 75 git requests per hour per user per app. — [Heroku Git](https://devcenter.heroku.com/articles/git)
- **Heroku GitHub integration:** authorized via OAuth once per account. Auto-deploy needs repo admin rights because Heroku adds a service hook. It can wait for CI ("Wait for CI to pass" means all commit statuses are success). Heroku pulls source directly from GitHub, does NOT sync it to the Heroku git remote, and advises against mixing the two. GitHub tarballs omit submodules, so repos with submodules break. GitHub Apps with finer-grained permissions are "not yet supported". Manual deploy of any branch is available, and the next auto-deploy overwrites it. — [Heroku GitHub Integration](https://devcenter.heroku.com/articles/github-integration)
- **HF Spaces:** "Spaces stores your code inside a git repository, just like the model and dataset repositories." You use `git` / `git-xet`, and "each time a new commit is pushed, the Space will automatically rebuild and restart." The repo can be cloned over HTTPS or SSH. — [Spaces Overview](https://huggingface.co/docs/hub/spaces-overview)
- **HF GitHub sync:** the official `huggingface/hub-sync` Action is "not a git-to-git sync". It uploads file contents via `hf upload`, excludes `.github/` and `.git/`, and mirrors deletions. The alternative is a direct `git push https://USER:$HF_TOKEN@huggingface.co/spaces/USER/SPACE main`; files over 10 MB then need git-xet or LFS. — [Spaces GitHub Actions](https://huggingface.co/docs/hub/spaces-github-actions)
- **HF visibility:** public, protected (source private, app public), or private. — [Spaces Overview](https://huggingface.co/docs/hub/spaces-overview)
- **Render:** auto-deploys on push or merge to the linked branch. Modes are On Commit, After CI Checks Pass, or Off, and `[skip render]` in a commit message skips a deploy. Auto-deploy requires a connected git provider. — [Render Deploys](https://render.com/docs/deploys)
- **Railway:** "GitHub Autodeploys" deploy on push. "Deploy Latest Commit" deploys the default branch from GitHub; other branches must be connected in service settings. — [Railway deployments](https://docs.railway.com/guides/deployments); [Railway deployment actions](https://docs.railway.com/deployments/deployment-actions)
- **Replit:** publishing "saves a snapshot of your app's files and dependencies" and runs it as a separate cloud instance. Republishing creates a new snapshot. — [Replit Deployments](https://docs.replit.com/cloud-services/deployments/about-deployments)
- **Replit git:** a repl is not necessarily a git repo. You can initialize git from the Git pane and link it to an external provider (GitHub, a PAT for private repos, plus self-hosted GitLab/Bitbucket/GHES on Enterprise). The documented import route is `git clone` in Shell. — [Replit Git pane](https://docs.replit.com/replit-workspace/workspace-features/git-interface)

### Inferences
- Platform-hosted git falls into two models:
  - **Heroku:** a disposable deploy channel; history is the user's own, but the storage is not durable.
  - **HF:** the canonical, durable hub repo, the same storage as models and datasets.
- Replit does not host a git remote; its deploy unit is a workspace snapshot, not a commit.

### Gaps
- No doc found confirming whether Replit hosts any git remote. The fetched page is silent on it.
- Render's and Railway's GitHub auth mechanism was not fetched. Both are generally understood to use GitHub Apps, but this is unverified here.

## No-remote case: CLI upload and commit linkage

### Takeaway
`railway up` and `fly deploy` upload or build the working directory with no commit link documented. Render's CLI deploys a commit of an already-linked service, or an image.

### Cited Findings
- **`railway up`:** compresses and uploads the current directory (or a given path) and honors `.gitignore` and `.railwayignore`. `.git` and `node_modules` are always excluded. Flags include `--no-gitignore`, `--detach`, `--ci`, and `--json`. The doc says nothing about a commit tie. — [railway up](https://docs.railway.com/cli/up)
- **`fly deploy`:** runs from the project directory. Image selection order is `--image` / `[build]` in `fly.toml`, then `--dockerfile`, then a local Dockerfile. It "builds, or gets, the Docker image". No git linkage is mentioned. — [Fly deploy](https://docs.fly.io/launch/deploy)
- **Render CLI:** `render deploys create` accepts `--commit`. You can deploy a specific SHA; Dashboard and deploy-hook deploys of a specific commit disable auto-deploy, but CLI and API deploys do not. Prebuilt-image services must deploy manually, and the image URL can be passed to the API. Deploy hooks are a GET or POST to a secret URL. — [Render Deploys](https://render.com/docs/deploys)
- **HF without git:** the `hf upload` CLI creates commits on the Space repo, so even uploads land as commits. — [Spaces GitHub Actions](https://huggingface.co/docs/hub/spaces-github-actions)

### Inferences
- On HF, every deploy is a commit. On Railway and Fly, a CLI deploy is a working-tree tarball or image with no SHA, unless the user adds one (for example Fly's `--image-label`).

### Gaps
- Whether Railway or Fly record git metadata on CLI deploys when they are run inside a git repo is not documented in the fetched pages.

## What is deployed and how a release pins source plus artifact

### Takeaway
Heroku's release is the clearest model: an immutable artifact plus config plus add-ons, with a sequential version, linked to a commit hash. Fly, Render, and Railway pin a built image or artifact per deploy.

### Cited Findings
- **Heroku release:** the compiled slug (or an OCI image on Fir apps) plus config vars plus add-on resources, versioned v1, v2, and so on. A new release is created on each deploy, config change, or add-on change. The deploy's Change column carries the git commit hash (e.g. "Deploy de63889"). — [Heroku Releases](https://devcenter.heroku.com/articles/releases)
- **Heroku build ordering:** concurrent builds release in the order they finish, not push order. Ctrl+C does not cancel a build. — [Heroku Git](https://devcenter.heroku.com/articles/git)
- **Fly:** each release has an image at `registry.fly.io/<app>:deployment-...` or `@sha256:...`. `fly releases --image` lists them, and `--image-label` gives a readable tag. Setting secrets triggers a new deployment. — [Fly rollback guide](https://fly.io/docs/blueprints/rollback-guide/); [Fly deploy](https://docs.fly.io/launch/deploy)
- **Fly community note (secondary source):** "fly releases --image" lists release images. — [community](https://community.fly.io/t/how-to-do-rollback-releases-3-different-ways/16347)
- **Render:** each deploy has a build artifact that is reused on rollback. Registry images referenced by tag may drift; a digest is stable. — [Render Rollbacks](https://render.com/docs/rollbacks)
- **Railway:** each deployment holds a Docker image plus custom variables. A redeploy reuses the same code and config. — [Railway deployment actions](https://docs.railway.com/deployments/deployment-actions)
- **HF Spaces:** each pushed commit triggers a rebuild. Runtime disk is 50 GB and not persistent. — [Spaces Overview](https://huggingface.co/docs/hub/spaces-overview)

### Gaps
- Whether HF exposes per-build artifacts, or lets you deploy or pin a specific older commit, was not found.

## Artifact storage, retention, rollback

### Takeaway
All four container PaaSes roll back by reusing a stored artifact, and retention is bounded. Heroku is the most explicit: artifacts are kept while a release is either 30 days old or less, or among the latest 20 releases.

### Cited Findings
- **Heroku retention:** artifacts are destroyed only when a release is both older than 30 days AND outside the last 20 releases. Artifacts not tied to a release are deleted after 1 day. An expired release cannot be rolled back to.
- **Heroku rollback:** `heroku rollback vN` creates a new release that copies the target's slug and config. It does NOT revert add-ons, the Heroku git repo, or external state.
- Source for both: [Heroku Releases](https://devcenter.heroku.com/articles/releases)
- **Render:** keeps a plan-dependent number of build artifacts per service. A rollback reuses the artifact and env vars and skips the build. Disks, plan, domains, and env group contents are not reverted. A Dashboard rollback disables auto-deploy; an API rollback does not. — [Render Rollbacks](https://render.com/docs/rollbacks)
- **Railway:** a rollback restores the image and variables, but only within the plan's image-retention window. "Deploy Latest Commit" pulls from GitHub. — [Railway deployment actions](https://docs.railway.com/deployments/deployment-actions)
- **Fly:** roll back with `fly deploy --image <previous>`. Fly "doesn't promise to store app images forever" and suggests pushing to your own registry for guaranteed targets. Redeploying an image does not revert secrets or `fly.toml`. — [Fly rollback guide](https://fly.io/docs/blueprints/rollback-guide/)
- **Replit:** rollback is not described on the overview page; republishing creates a new snapshot. — [Replit Deployments](https://docs.replit.com/cloud-services/deployments/about-deployments)

### Gaps
- Exact Render and Railway retention counts per plan were not fetched.
- HF Space rollback would be a git revert or reset on the repo (inferred, not documented).

## Previews, environments, secrets

### Cited Findings
- **Heroku:** Review Apps create a temporary app per PR. Pipelines and Heroku CI build on the connected GitHub repo. Migrations go in the Release Phase. — [Heroku GitHub Integration](https://devcenter.heroku.com/articles/github-integration)
- **Render:** has single-service previews and multi-service preview environments (named in the navigation only). — [Render Deploys](https://render.com/docs/deploys)
- **HF:** Variables are public and copied to duplicated Spaces. Secrets are private, unreadable after they are set, and not copied on duplicate. Both are exposed as env vars; Static Spaces get them through `window.huggingface.variables`. Hard-coded secrets are flagged by a secrets scanner. — [Spaces Overview](https://huggingface.co/docs/hub/spaces-overview)
- **Heroku:** config vars are part of the release, so changing one creates a new release, and a rollback restores them. — [Heroku Releases](https://devcenter.heroku.com/articles/releases)
- **Fly:** secrets are set separately from code, and setting them redeploys. — [Fly deploy](https://docs.fly.io/launch/deploy)
- **Replit:** each customer has an isolated GCP project for secrets, compute, and storage. — [Replit Deployments](https://docs.replit.com/cloud-services/deployments/about-deployments)

### Inferences
- Every platform separates config and secrets from code. Heroku and Railway snapshot config into the release or deployment, so rollback restores it. Fly does not: secrets live at the app level.

### Gaps
- Railway PR environments and Fly review apps were not verified in fetched docs.
