"""The identity of a secret declaration: ``(project_id, ENV_VAR_NAME)``.

A secret belongs to a project and is named by the environment variable it
arrives as. **That pair is the whole identity** — not where the value is
fetched from, not where it happens to be cached. Which is the point: a secret
must be able to move between stores (``.env.local`` → the encrypted ``sodot``
→ the hub vault) without becoming a different secret.

Convergent across machines, because ``project_id`` is the shared hub identity
(``Project.share()`` publishes under the project's own id). Sender and receiver
therefore compute the same secret id, which is what lets a shared declaration
resolve on both sides.

``env_var`` is used **verbatim and case-sensitively**. POSIX environments are
case-sensitive, so ``API_KEY`` and ``api_key`` are genuinely two variables;
folding them here would make the id lie about what gets injected. (The UI
upper-cases what the user types — that is an input affordance, not identity.)

Single source of truth: the entity mints through here, and so does the indexer.
Two copies of an id recipe is how the old locator-keyed scheme drifted.
"""

from __future__ import annotations

import uuid

from flow_sdk.api.api_types.identifier import mint_uuid


def stable_key(project_id: str, env_var: str) -> str:
    """The pre-hash identity string. Exposed because the indexer registers it as
    ``id_stable_key_fn`` and must produce byte-identical output."""
    return f"secret-origin:{str(project_id).strip()}:{str(env_var).strip()}"


def secret_origin_id(project_id: str, env_var: str) -> str:
    """The uuid5 a declaration of ``env_var`` in ``project_id`` always gets."""
    return mint_uuid(key=stable_key(project_id, env_var), namespace=uuid.NAMESPACE_URL)
