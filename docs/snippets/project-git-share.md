---
id: 75d88401-6e2d-495a-976e-bc1cc690a537
---
# Project git share

A project whose code lives in a private GitHub repo can let its members clone
and push that repo through FlowPad, with their FlowPad login. They need no
GitHub access of their own, and **their project role decides what they can
do**: readers and members pull, editors and admins push.

How it works: the hub links the repo under the project and relays git to
GitHub. Each request gets a fresh token that the Flowpad GitHub App mints for
**that one repo**, with read for a fetch and write only for a push. Nothing
long-lived is stored, and sharing or unsharing never changes the GitHub repo.

Every fence on this page runs as written in
`tests/unit/test_project_git_share_snippets.py`, with the hub's answers played by
a double that checks each request. Live, it needs a cloud login and a project
linked to the cloud.

## 1. Share a private repo with project members

Run it from inside the project's folder. The project must be linked to the
cloud, since its members are the hub project's members.

```python
import os

from flow_sdk.builtin.project import Project

project = await Project.find_by_cwd(os.getcwd())
share = await project.share_git()
print(share.status, share.repo)  # shared acme/api
print(share.clone_url)  # what a member clones, with their FlowPad login
```

Sharing is idempotent: asking again for a shared project answers `shared` with
the same `clone_url`. From now on, a member who accepts the project gets a
checkout cloned through the hub.

## 2. When GitHub needs a step first

Two answers ask you to do something on GitHub, then call `share_git()` again:

```python
share = await project.share_git()
if share.status == "install_required":
    print(f"Install the Flowpad GitHub App on {share.repo}: {share.install_url}")
elif share.status == "github_connect_required":
    print(f"Connect GitHub to FlowPad, so the hub can check you may share {share.repo}")
```

* `install_required`: the Flowpad GitHub App is not installed on the repo.
  Install it (pick this repo) at `install_url`. The hub reads the installation
  from the repo itself, never from what the browser brings back.
* `github_connect_required`: the hub cannot yet confirm you administer the repo
  on GitHub. Connect GitHub in FlowPad (Settings → Connections).

## 3. What a member runs

A member clones through the hub with their own FlowPad login. Later calls only
fast-forward, and never reset their work:

```python
from pathlib import Path

from flow_sdk.assets.hub_repo_sync import HubRepoCheckout
from flow_sdk.cli.auth.hub_login import resolve_hub_api_key

share = await project.git_share()
checkout = HubRepoCheckout(
    root=Path.home() / "code" / "api",
    clone_url=share.clone_url,
    branch=share.default_branch,
    token=resolve_hub_api_key(require_live=True),
)
await checkout.checkout()
```

Plain git works too, with the hub login as a bearer header:
`git -c http.extraHeader="Authorization: Bearer $FLOWPAD_KEY" clone <clone_url>`.
A reader's push is refused by the hub before it reaches GitHub.

## 4. Stop sharing

```python
share = await project.unshare_git()
print(share.status)  # not_shared
```

Members can no longer fetch or push through the hub. Their clones keep what they
have. The GitHub repo is untouched, and members who accept the project from now
on are pointed at GitHub again.

## 5. Refusals

A public repo needs no sharing, since anyone can clone it:

```python
share = await project.share_git()
print(share.status)  # not_private
```

A project that is not linked to the cloud has no members to share with:

```python
local = await Project.find_by_cwd(os.getcwd())
await local.share_git()
# GitShareError: Link the project to the cloud first: its members are the hub project's members
```

## 6. Same verbs in TypeScript

The project page uses the same three verbs through the TS SDK. They talk to the
desk's `project/<id>/git_share` route, which uses the desk's cloud login:

```ts
import { Project } from '@sdk';

const project = await Project.getById<Project>(projectId);
let share = await project.shareGit();
if (share.status === 'install_required' && share.install_url) {
  window.open(share.install_url, '_blank'); // install the Flowpad GitHub App, then share again
  share = await project.shareGit();
}
console.log(share.status, share.clone_url); // shared https://hub…/git_repo/<id>/git

const status = await project.gitShare(); // no side effects
const stopped = await project.unshareGit(); // members lose access; the GitHub repo is untouched
```

`ui/tests/unit/project-git-share-snippet.test.ts` runs this fence as written, with
the desk's answers played by a double that checks each request's verb and path.
