"""A fake OAuth provider for the hub — test-only, and gated twice.

**This file does not live in the hub.** It sits in this repo as a fixture, and
installing it is a deliberate act: copy the folder into
``<hub>/flowpad/plugins/`` and restart the hub with
``FLOWPAD_ENABLE_TEST_OAUTH=1``. That is the strongest non-contamination
guarantee available — the hub's plugin loader scans its folder unconditionally
and has no per-plugin switch, so a provider that is merely *disabled* would still
appear in the real Connections list.

The env var is the second gate, for the case where someone copies the folder in
and forgets: without it, `oauth_config` is None and the provider configures
nothing. Absent by default, inert if present, working only when asked for.

Points that are not obvious, each learned from the hub's own code:

* ``category`` must be ``"oauth"``. Manifests with ``category: "test"`` are
  dropped outright by ``core/loaders.py``, so the honest-looking label is the
  one that makes the plugin invisible even when you want it.
* The name must NOT be ``test_provider``. ``oauth_action.py`` short-circuits
  that exact name to a fake auth URL and creates no session, so a flow using it
  can never complete.
* ``get_app_credentials`` must be overridden as well as ``get_user_credentials``.
  ``process_oauth_callback`` calls the app one unconditionally, inside a broad
  ``except`` — so leaving the base ``NotImplementedError`` in place stores the
  user token and *still* reports the callback as failed.
* ``code_request_map`` must yield at least one param or ``ui_login_url`` raises,
  and ``redirect_uri`` needs ``url_encode=True`` because the hub builds the query
  by raw f-string join rather than urlencode.
"""

import os
from typing import List, Optional

from flowpad.hub.builtin.plugin_model import OAuthCredentials, PluginCredentials
from flowpad.hub.external_apis.oauth_lib.oauth_provider_config import (
    OAuthParamMapping,
    OauthProviderConfig,
    OAuthRequestMapping,
    OAuthRequestType,
    RequestParamMappingType,
)

#: Where the dummy provider server is listening. A FIXED port by necessity: this
#: config is imported once and cached, so the URLs are frozen before any test
#: picks one.
DUMMY_BASE_URL = os.getenv("DUMMY_OAUTH_BASE_URL", "http://127.0.0.1:6787")

ENABLED = os.getenv("FLOWPAD_ENABLE_TEST_OAUTH") == "1"


code_request_params: List[OAuthParamMapping] = [
    OAuthParamMapping(name="client_id"),
    OAuthParamMapping(name="scopes", mapping=RequestParamMappingType.CSV, mapped_name="scope"),
    OAuthParamMapping(name="state"),
    # url_encode: the hub joins these into the query with a raw f-string.
    OAuthParamMapping(name="redirect_uri", url_encode=True),
]
code_request_map = OAuthRequestMapping(
    params_mappings=code_request_params, request_type=OAuthRequestType.BROWSER_LINK
)

code_response_params: List[OAuthParamMapping] = [
    OAuthParamMapping(name="state"),
    OAuthParamMapping(name="code"),
]

token_request_params: List[OAuthParamMapping] = [
    OAuthParamMapping(name="code"),
    OAuthParamMapping(name="redirect_uri"),
    OAuthParamMapping(
        name="grant_type", mapping=RequestParamMappingType.VALUE, value="authorization_code"
    ),
    OAuthParamMapping(name="client_id"),
    OAuthParamMapping(name="client_secret"),
]
token_request_map = OAuthRequestMapping(
    params_mappings=token_request_params, request_type=OAuthRequestType.POST
)


class DummyAuthUserCredentials(OAuthCredentials):
    token_type: Optional[str] = None
    scope: Optional[str] = None

    @property
    def access_token(self) -> str:
        if isinstance(self.value, dict):
            return self.value.get("access_token", "")
        return str(self.value) if self.value else ""


class DummyAuthAppCredentials(DummyAuthUserCredentials):
    pass


class DummyAuthCredentials(PluginCredentials):
    user: DummyAuthUserCredentials
    app: DummyAuthAppCredentials


class DummyAuthProvider(OauthProviderConfig):
    def get_user_credentials(self, token_response: dict) -> Optional[DummyAuthUserCredentials]:
        if token_response is None:
            return None
        return DummyAuthUserCredentials(
            value=token_response,
            token_type=token_response.get("token_type", "bearer"),
            scope=token_response.get("scope", ""),
        )

    def get_app_credentials(self, token_response: dict) -> Optional[DummyAuthAppCredentials]:
        # Must exist: the callback calls it unconditionally and swallows the
        # base class's NotImplementedError into a reported failure.
        return None


oauth_config = (
    DummyAuthProvider(
        provider_name="dummyauth",
        auth_url=f"{DUMMY_BASE_URL}/authorize",
        token_url=f"{DUMMY_BASE_URL}/token",
        revoke_url=None,
        client_id=os.getenv("DUMMYAUTH_CLIENT_ID", "dummy-client"),
        client_secret=os.getenv("DUMMYAUTH_CLIENT_SECRET", "dummy-secret"),
        scopes=["read", "write"],
        use_pkce=False,
        extras={},
        code_request_map=code_request_map,
        code_response_mapping=code_response_params,
        token_request_map=token_request_map,
        user_credentials_key="*",
    )
    if ENABLED
    else None
)
