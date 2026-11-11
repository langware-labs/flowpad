# Git-native deployment: cross-cutting principles, invariants, anti-patterns

## GitOps principles (OpenGitOps v1) applied to app deploys

### Takeaway
OpenGitOps has four principles. Git holds the declarative desired state, which is versioned and immutable. Agents pull that state and keep reconciling toward it. For app deploys this means the deployed state should be derivable from a git ref and never edited out-of-band.

### Cited Findings
- The four principles, verbatim: (1) Declarative: "A system managed by GitOps must have its desired state expressed declaratively." (2) Versioned and Immutable: "Desired state is stored in a way that enforces immutability, versioning and retains a complete version history." (3) Pulled Automatically: "Software agents automatically pull the desired state declarations from the source." (4) Continuously Reconciled: "Software agents continuously observe actual system state and attempt to apply the desired state." — [OpenGitOps](https://opengitops.dev/)

### Inferences
- The user's repo should be the only "source" in principle 3. A platform copy that keeps its own history is a second source and breaks principle 2, because the full history then lives in two places.
- In this context, reconciliation means the runtime should be able to answer "which commit am I running, and does it match the target ref?"

### Gaps
- I did not fetch the full OpenGitOps glossary, which defines terms such as "State Store" and "Reconciliation".

## Immutable deployment identity (12-factor build/release/run)

### Takeaway
12-factor says a release = build + config, has a unique ID, is append-only and immutable, and code cannot change at runtime. A natural deploy identity is therefore (commit SHA, artifact digest, config version).

### Cited Findings
- Build turns a code repo into an executable bundle. Release combines the build with the current config. Run launches processes against a chosen release. — [12factor build-release-run](https://12factor.net/build-release-run)
- "Releases are an append-only ledger and a release cannot be mutated once it is created." Every release should have a unique ID, and rollback restores a previous release. — [12factor](https://12factor.net/build-release-run)
- The run stage should have minimal moving parts because it can execute unattended, for example after a reboot. — [12factor](https://12factor.net/build-release-run)
- Heroku: on `git push` the slug compiler turns the repository into a slug, a tar.gz build artifact. — [Heroku Slug Compiler](https://devcenter.heroku.com/articles/slug-compiler)

### Inferences
- Record a deploy as an immutable row (sha, artifact digest, config version). Redeploying or rolling back means picking a prior row. Nothing should mutate a running release in place.

### Gaps
- I did not verify Heroku's current release-ID semantics (v1, v2…) from a primary doc during this pass.

## Dirty working trees in CLI deploys

### Takeaway
Vercel's API carries an explicit `gitMetadata.dirty` boolean. Vercel staff say CLI deploys upload local files and are *not* treated as git deploys; the git metadata is only for display. The industry pattern is "allow, but flag": the deployment is not git-identified.

### Cited Findings
- The create-deployment API has `gitMetadata` with a boolean `dirty` field ("working tree has changed since the latest commit"). — [Vercel REST API: create deployment](https://vercel.com/docs/rest-api/endpoints/deployments/create-a-new-deployment)
- Vercel staff say CLI deploys send local files that may differ from the repo, and git metadata is passed mainly for dashboard display. — [Vercel community](https://community.vercel.com/t/cli-doesnt-send-gitsource-during-deployment-the-git-branch-url-is-not-generated/870)
- Missing metadata leaves CLI deploys unlinked to a branch; `--meta` can override this. — [Vercel guide](https://examples.vercel.com/guides/branch-variables-and-domains-not-linked-to-cli-deployments)

### Inferences
- Recommended practice for a git-native design: deploys come from a commit. If the tree is dirty, either refuse it or auto-commit or push to a branch on the user's repo, so the SHA stays the identity. If dirty deploys must be allowed, record `dirty=true` plus a content digest and never present that deploy as "commit X".

### Gaps
- I did not confirm whether the Vercel CLI sets `dirty` automatically. I also did not check Netlify, Fly or Railway policies.

## Platform-hosted git as a managed remote: durability

### Takeaway
Large git hosts replicate whole repositories at the application layer on durable local disks. Network or cloud filesystems and snapshot backups are explicitly unsupported in GitLab's case. A managed repo must never live on ephemeral container disk.

### Cited Findings
- GitHub Spokes (formerly DGit, 2016) keeps 3 replicas per repo on separate servers. It replicates at the git application layer, needs ≥2 replica acks per write, refuses writes it cannot commit, and auto-repairs after failures. — [GitHub: Introducing DGit](https://github.blog/engineering/architecture-optimization/introducing-dgit/)
- GitLab Gitaly: repository data must be on local storage. NFS and cloud filesystems are unsupported "for performance and consistency reasons". Gitaly Cluster (Praefect) keeps multiple replicas (replication factor 3 in the example). — [GitLab Gitaly docs](https://docs.gitlab.com/17.7/ee/administration/gitaly)
- Gitaly Cluster does not support snapshot backups, because they can desync the Praefect metadata DB from disk. — [GitLab Gitaly docs](https://docs.gitlab.com/17.7/ee/administration/gitaly)
- Praefect was created to replace NFS. — [GitLab blog 2021](https://about.gitlab.com/blog/2021/01/21/high-availability-git-storage-with-praefect/)
- HF Spaces and Heroku both treat the platform repo as a git remote: you push to it and a build follows. — [Heroku](https://devcenter.heroku.com/articles/slug-compiler); HF evidence is only community scripts, e.g. [example](https://huggingface.co/spaces/Rudy-16/UserManagement/blob/main/.github/workflows/deploy-hf.yml)

### Inferences
- A small platform needs a persistent volume plus regular `git bundle`/mirror backups to object storage, or an external host such as a GitHub org repo. The GitLab snapshot warning points to an invariant: the metadata row and the repo storage must be backed up and restored consistently.

### Gaps
- I found no primary docs on Gitea/Forgejo storage or on Replit's repo storage. I did not research git-on-object-storage designs (e.g. JGit DFS, code.storage).

## Auth patterns

### Takeaway
GitHub App installation tokens expire after 1 hour and can be narrowed to specific repos and permissions. That makes them the natural per-job clone credential for build sandboxes.

### Cited Findings
- An installation token "will expire after 1 hour". It can be restricted with `repositories`/`repository_ids` (≤500) and a `permissions` subset, and can never exceed the installation's grant. — [GitHub Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- E2B's git API takes a username plus a token (password) per clone or pull call. — [E2B git integration](https://docs.e2b.dev/sandbox/git-integration)

### Inferences
- Mint the token per job, scoped to one repo with contents:read (or write only when the agent pushes). Pass it per call and do not persist it in `.git/config`.

### Gaps
- I did not fetch the deploy-keys docs. Deploy keys are per-repo SSH keys and long-lived, so they are weaker for ephemeral sandboxes, but I have not cited this.

## Agent/sandbox runtimes: how they get code

### Takeaway
Hosted coding agents (Cursor cloud/background agents, OpenAI Codex cloud) clone the user's GitHub repo through a GitHub App connection into a VM or container, work on a branch, and push a PR. They do not upload a snapshot. Sandbox SDKs (E2B) expose clone with a token.

### Cited Findings
- Cursor agents clone the repo via the Cursor GitHub App into an isolated VM, work on a separate branch and open a PR. They need read-write repo access. (Secondary sources.) — [morphllm guide](https://www.morphllm.com/cursor-background-agents); [agent37](https://www.agent37.com/blog/cursor-background-agents)
- Codex cloud: you choose GitHub repos to check out when setting up an environment. Only GitHub.com is supported. Secrets are injected separately. (Secondary sources.) — [developersdigest](https://www.developersdigest.tech/blog/codex-cloud-reusable-environments); [OpenAI docs mirror](https://developers.openai.com/pt-BR/docs/cloud)
- E2B: `sandbox.git.clone(url, {path, branch, depth})`. — [E2B docs](https://docs.e2b.dev/sandbox/git-integration)

### Inferences
- The dominant pattern is clone-a-ref-with-scoped-token, and results return as a branch or PR on the user's remote. This matches "the user's repo is the source of truth".

### Gaps
- I did not check Modal, Daytona or Codespaces docs, so their fetch mechanics are unverified. Cursor and Codex details come from secondary sources.

## Anti-patterns

### Takeaway
These anti-patterns follow from the principles above. Each is grounded in the sources, but the list is my synthesis.

### Cited Findings
- Shadow copies with separate history break "versioned and immutable … complete version history" and the single pulled source. — [OpenGitOps](https://opengitops.dev/)
- When metadata and storage diverge you get corruption: GitLab bans snapshot backups because the Praefect DB desyncs from disk. — [GitLab Gitaly docs](https://docs.gitlab.com/17.7/ee/administration/gitaly)
- Spokes refuses writes it cannot durably replicate rather than accepting them and failing silently. — [GitHub DGit](https://github.blog/engineering/architecture-optimization/introducing-dgit/)

### Inferences
- A metadata row such as "managed repo exists" must not outlive its storage. Verify existence on read, and treat a missing repo as a typed permanent error such as `repo_missing`, not a "try again" message.
- Classify errors: auth or permission failures (expired token, app not installed on the repo) and a missing ref are permanent and need user action. Network and 5xx errors are transient. Generic retry messages for permanent errors hide the fix.
- Deploying from mutable local state without a SHA makes rollback and audit impossible (12-factor immutability).

### Gaps
- I found no published postmortem specifically about metadata-without-storage in git hosting.
