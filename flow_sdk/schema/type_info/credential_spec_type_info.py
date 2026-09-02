"""Type metadata for CREDENTIAL_SPEC — the authored definition of a credential.

A REPO folder asset, so the existing `repo_assets_fn` walker finds it with no new
discovery code: it scans `<container>/agentic-assets/<family>/` recursively in
any walked container, which includes the shipped assistant project.

``family="credential"`` — the folder a human reads is named for the thing. The
asset lives at `agentic-assets/credential/<name>/credential.json`, a fourth
shipped family alongside `agent`, `data_source` and `journey`.

Deliberately NOT ``icon="KeyRound"``: that is ``SECRET_ORIGIN``'s glyph, and the
two are different layers — a credential DEFINITION versus one project's
declaration that it needs a variable. Sharing a glyph would say they are the
same kind of thing.
"""
from flow_sdk.builtin.credential_spec import CredentialManifestSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.credential_spec import credential_spec_identity_key
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

CREDENTIAL_SPEC = TypeMetadata(
    type=EntityType.CREDENTIAL_SPEC,
    icon="Plug",
    displayName="Credential definitions",
    api_visible=True,
    # Authored in a folder or written by an agent, not from a New button —
    # the same call `DATA_SOURCE_SPEC` makes.
    creatable=False,
    # Unlike DATA_SOURCE_SPEC, this one IS browseable: an author who has just
    # written a credential folder needs somewhere to see that it indexed.
    browseable_by=ViewMode.ADVANCED,
    asset_class="repo",
    family="credential",
    main_layout="folder",
    asset_spec=CredentialManifestSpec,
    main_file="credential.json",
    fts_content=("name", "description"),
    # DERIVED, not a capsule: `credential.json` deliberately carries no id —
    # stamping one in would make a shared definition arrive carrying the
    # sender's id. A derived carrier has nowhere to write an id back, so
    # identity must be a pure function of the source, and `identity_key_fn` is
    # what supplies it. It is NOT optional: without a key `mint_entity_id` falls
    # through to `uuid5(resolved path)`, and a shipped spec's path is the
    # INSTALL's, so one credential would fork into a row per install location.
    identity_carrier=derived_identity(),
    identity_key_fn=credential_spec_identity_key,
    index_fields=["name", "title"],
)

# No `derive_fields_fn`: a credential folder has no marker files, so nothing
# about it is derived from the listing — unlike a source, whose runtime is.
