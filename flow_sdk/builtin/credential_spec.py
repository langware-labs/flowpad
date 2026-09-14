"""CredentialSpec — the authored definition of a named credential.

A credential is a NAMED SET OF ENVIRONMENT VARIABLES some provider needs: Gmail
is ``GMAIL_ADDRESS`` + ``GMAIL_APP_PASSWORD``; Twilio is an account SID and an
auth token. This is the definition of that set. It is not the values, and it is
not the per-project decision to require them.

The split mirrors ``DataSourceSpec`` : ``DataSource`` exactly, one layer over:

    CredentialSpec  :  SecretOrigin
          ==
    DataSourceSpec  :  DataSource

``SecretOrigin`` (``flow_sdk/builtin/secret_origin.py``) is the per-project
DECLARATION — identity ``(project_id, env_var)``, one row per VARIABLE, carrying
a locator that says where THIS machine keeps the value. ``CredentialSpec`` is
global, shipped, and says what the credential IS. One spec fans out to N
``SecretOrigin`` rows.

The invariant that keeps the two apart is load-bearing:

    CredentialSpec never names a store for a specific project or a project id.
    SecretOrigin never carries provider presentation.

Break it and the same Gmail credential can no longer sit in ``.env.local`` here
and in the hub vault on a teammate's machine — which is the entire reason the
locator exists.

**A manifest is value-free, structurally.** Every parse runs through
``assert_value_free``, so a bundled or agent-authored ``credential.json`` that
carries a ``value:`` fails to index rather than shipping a secret in git.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.data_spec.credential_manifest_spec import (
    CURRENT_SCHEMA,
    CredentialVarSpec,
)
from flow_sdk.schema.data_spec.secret_origin_contract import (
    SOD_STORE_ENV_LOCAL,
)
from flow_sdk.schema.types import EntityType

#: The manifest format this build reads. A manifest that says otherwise is a
#: load error, not a best-effort parse — same rule as ``ManifestSpec``.


#: Where a provided value is cached by default. The same two local stores
#: ``SecretOrigin.effective_sod_store`` chooses between; named from there rather
#: than re-spelled, so a third store cannot appear in one place only.


#: The providers an ``lm_provider`` may name. ``FLOWPAD`` is excluded on purpose:
#: its "key" is the hub login the box already holds and the hub owns the binding,
#: so there is nothing for a person to type and nothing to store
#: (``cli/auth/lm_api_keys.set_lm_api`` raises for it).



class CredentialManifestError(ValueError):
    """A credential folder that cannot be loaded. The message is shown to an author."""








class CredentialSpec(Entity):
    """The ROW; its shape on disk is ``CredentialManifestSpec`` (``TypeInfo.asset_spec``)."""

    type: str = APIField(default=EntityType.CREDENTIAL_SPEC.value)

    # A folder-backed asset, so it OWNS its path — declaring `asset_ref` is what
    # enrolls the class in `Entity.asset_owner_classes()`, and therefore what
    # lets `get_by_asset_ref` resolve a folder to this row. PRIVATE: the path is
    # this machine's and means nothing to a receiver.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    # -- the header, held as entity fields --
    title: str = APIField(default="")
    description: str = APIField(default="")
    icon_name: str = APIField(default="")
    manifest_schema: int = APIField(default=CURRENT_SCHEMA)
    help_url: str = APIField(default="")
    setup_wiki: str = APIField(default="")
    default_store: str = APIField(default=SOD_STORE_ENV_LOCAL)
    lm_provider: str = APIField(default="")
    vars: dict[str, CredentialVarSpec] = APIField(default_factory=dict)

    _api_visible: ClassVar[bool] = True

    def var_names(self) -> list[str]:
        """Every variable this credential is made of, in manifest order."""
        return list(self.vars or {})

    def required_var_names(self) -> list[str]:
        """The variables that must be satisfied for the credential to be usable.

        The tri-state a connection row renders — connected / partial / not
        connected — is computed against THIS list, not ``var_names``: an
        optional member missing must not hold a working credential at "partial".
        """
        return [name for name, spec in (self.vars or {}).items() if spec.required]
