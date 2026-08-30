"""SecretOrigin entity: a project-level secret pointer.

This entity stores pointer metadata only. The actual secret value stays in the
receiver's value store and is resolved only while launching a worker process.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.builtin.secret_origin_identity import secret_origin_id
from flow_sdk.builtin.secret_origin_refs import (
    SECRET_ORIGIN_ADAPTER,
    LocalSecretRef,
    SecretOriginField,
    SecretOriginLocator,
)
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

SECRET_ORIGIN_ENV_VAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# The two local SOD stores the wizard may cache a provided value into.
SOD_STORE_SODOT = "sodot"
SOD_STORE_ENV_LOCAL = "env-local"
_VALID_SOD_STORES = {SOD_STORE_SODOT, SOD_STORE_ENV_LOCAL}

# Keys that UNAMBIGUOUSLY hold a plaintext value (vs. a value-free coordinate — a
# GCP secret *name* is a legit ``secret`` coordinate, a 1Password ``field`` is a
# coordinate, etc.). The reference json and every share payload are value-free by
# construction; this guard is the safety net that makes a regression fail loudly
# instead of committing a secret to git — so it only trips on keys that can only
# mean "the value itself".
_FORBIDDEN_VALUE_KEYS = {
    "value",
    "secret_value",
    "plaintext",
    "plain_value",
    # A salted digest is kept per-machine in the encrypted sodot and must never
    # reach a reference json or a hub payload. Naming it here makes a refactor
    # that tries fail loudly instead of leaking quietly.
    "digest",
    "value_digest",
    "value_hash",
}


def is_valid_secret_origin_env_var(env_var: str) -> bool:
    return bool(SECRET_ORIGIN_ENV_VAR_RE.fullmatch(env_var))


def assert_value_free(data: Any, *, where: str = "secret reference") -> None:
    """Raise if ``data`` (a reference json / share payload) contains any
    plaintext-value-looking key at any depth. The reference must be a pointer only."""
    if isinstance(data, dict):
        for k, v in data.items():
            if isinstance(k, str) and k.strip().lower() in _FORBIDDEN_VALUE_KEYS:
                raise ValueError(f"{where} must be value-free; found forbidden key {k!r}")
            assert_value_free(v, where=where)
    elif isinstance(data, (list, tuple)):
        for item in data:
            assert_value_free(item, where=where)


class SecretOrigin(Entity):
    type: str = APIField(default=EntityType.SECRET_ORIGIN.value)
    env_var: str = APIField(default="", description="Environment variable injected for workers")
    locator: SecretOriginField = APIField(
        default_factory=LocalSecretRef,
        description="Value-free secret locator (where the value is found: sodot/env-local/gcp/1password/hub)",
    )
    sod_store: str = APIField(
        default="",
        description="Which SOD store the setup wizard caches a provided value into: "
        "'sodot' | 'env-local'. Empty = derive from locator kind.",
    )
    description: str = APIField(
        default="",
        description="What this secret is for, in the declarer's words. Lives here rather than on the "
        "EnvVar row because a declaration may have no value yet, and an EnvVar cannot be created "
        "without one — see app/actions/env_var.py::create_env_var.",
    )
    project_id: str = APIField(
        sharing=Sharing.PRIVATE,
        default="",
        description="The project this declaration belongs to. Half of the identity — see secret_origin_identity.",
    )

    def effective_sod_store(self) -> str:
        """The SOD store the wizard writes a provided value into. Explicit
        ``sod_store`` wins; otherwise derive from the locator kind (local→sodot,
        env-local→env-local, external providers→sodot cache)."""
        if self.sod_store in _VALID_SOD_STORES:
            return self.sod_store
        return SOD_STORE_ENV_LOCAL if self.locator.kind == "env-local" else SOD_STORE_SODOT

    @staticmethod
    def id_for(project_id: str, env_var: str) -> str:
        """Identity is ``(project_id, env_var)`` and nothing else — so changing
        a declaration's provider or store keeps the same secret."""
        return secret_origin_id(project_id, env_var)

    def reference_json(self) -> dict[str, Any]:
        """The value-free reference document persisted at ``assets/sodot/<name>.json``.
        Guarded to never carry a value."""
        data = {
            "id": str(self.id or self.id_for(self.project_id, self.env_var)),
            "name": self.name or "",
            "project_id": self.project_id,
            "env_var": self.env_var,
            "locator": self.locator.model_dump(mode="json"),
            "sod_store": self.effective_sod_store(),
            "description": self.description or "",
        }
        assert_value_free(data, where="secret reference json")
        return {"data": data}

    def to_json_asset(self, path: "Path") -> "Path":
        """Write the value-free reference to ``path`` (``assets/sodot/<ENV_VAR>.json``).
        The convergent id is stamped in so a file-indexed row and a DB-minted
        row collide on one id across machines."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.reference_json(), indent=2, sort_keys=True), encoding="utf-8")
        return path

    @staticmethod
    def context_data_for(
        *,
        name: str,
        env_var: str,
        locator: SecretOriginLocator,
        scope: str,
        sod_store: str = "",
        typeid: str | None = None,
        description: str = "",
    ) -> dict[str, Any]:
        data: dict[str, Any] = {
            "name": name,
            "env_var": env_var,
            "kind": locator.kind,
            "locator": locator.model_dump(mode="json"),
            "sod_store": sod_store,
            "scope": scope,
            "description": description,
        }
        if typeid:
            data["typeid"] = typeid
        return data

    def context_data(self, *, scope: str) -> dict[str, Any]:
        return self.context_data_for(
            name=self.name or "",
            env_var=self.env_var,
            locator=self.locator,
            scope=scope,
            sod_store=self.effective_sod_store(),
            typeid=str(self.typeid),
            description=self.description or "",
        )

    @classmethod
    async def mint_for(
        cls,
        *,
        project_id: str,
        env_var: str,
        locator: SecretOriginLocator | dict[str, Any],
        name: str = "",
        sod_store: str = "",
        description: str | None = None,
        remote: bool = False,
    ) -> "SecretOrigin":
        """Get-or-update the declaration of ``env_var`` in ``project_id``.

        Re-declaring an env var UPDATES it in place: the name is the key, so
        pointing it at a different provider or store is an edit, not a second
        secret. That is exactly what makes moving a value between stores safe.
        """
        if not project_id:
            raise ValueError("SecretOrigin requires a project_id — it is half the identity")
        if not is_valid_secret_origin_env_var(env_var):
            raise ValueError(f"invalid env_var for a SecretOrigin: {env_var!r}")
        loc = SECRET_ORIGIN_ADAPTER.validate_python(locator)
        sod_store = sod_store if sod_store in _VALID_SOD_STORES else ""
        name = name or env_var
        secret_id = cls.id_for(project_id, env_var)
        existing = await cls.get_by_id(secret_id)
        if existing is not None:
            changed = False
            for field, value in (
                ("name", name),
                ("env_var", env_var),
                ("project_id", str(project_id)),
            ):
                if getattr(existing, field) != value:
                    setattr(existing, field, value)
                    changed = True
            if existing.locator.model_dump(mode="json") != loc.model_dump(mode="json"):
                existing.locator = loc
                changed = True
            if sod_store and existing.sod_store != sod_store:
                existing.sod_store = sod_store
                changed = True
            # ``None`` means "not supplied" — a re-declare from a surface that
            # carries no description must not wipe one someone already wrote.
            if description is not None and existing.description != description:
                existing.description = description
                changed = True
            if remote and not existing.remote:
                existing.remote = True
                changed = True
            if changed:
                await existing.save()
            return existing

        ent = cls(
            id=secret_id,
            name=name,
            project_id=str(project_id),
            env_var=env_var,
            locator=loc,
            sod_store=sod_store,
            description=description or "",
            remote=remote,
        )
        await ent.save()
        return ent
