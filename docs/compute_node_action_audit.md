---
id: bfba1aab-22b7-46fa-a295-8fa95ab6237f
---

# ComputeNode action surface — pre-refactor STATUS

**Checkouts.** Every `compute_node.py` line below is **HUB** = `/Users/shlom/Documents/dev/test_flowpad/FlowPad/flowpad/hub/builtin/faas/compute_node.py` (2340 lines) unless the row says OSS. **OSS** = `/Users/shlom/Documents/dev/flowpad-oss`, whose `flow_sdk/builtin/faas/compute_node.py:76` is a *different, near-parallel class* — note it spells the provider field `node_provider_type` (OSS `flow_sdk/builtin/faas/compute_node.py:81`) where HUB spells it `node_provider` (HUB `compute_node.py:164`). Nothing in this document merges them.

---

## 1. The surface today

`ops/<op>` all enter through one elif chain, HUB `compute_node.py:1899-1934`; tool commands enter the same chain at `:1925` via the `_TOOL_COMMANDS` table (`:1846-1883`) and `_tool_op` (`:1885-1896`).

### Group A — already a clean one-liner (pure delegation, right shape)

| action | where | returns today | provider-leaky? | tested? |
|---|---|---|---|---|
| `get_host(port)` | HUB `compute_node.py:195` | `str` (raw provider URL) | no — seam is `ComputeProviderBase.get_host` | unit `tests/unit/test_compute_node_service_allowlist.py:78,82` |
| `wait_for_ready()` | HUB `compute_node.py:222` | `bool` | no | none found |
| `get_node_status()` | HUB `compute_node.py:226` | `ExecutionEnvironmentStatus` (`NEW` when no provider id) | no | unit `test_compute_node_service_allowlist.py:96` |
| `run_command(...)` | HUB `compute_node.py:246` | `CLICommand` | no | api `tests/api/test_shell_tool_and_command.py` |
| `exists / write_files / read_files / list_dir / create_folders / delete_files` | HUB `compute_node.py:262,266,291,297,301,305` | `bool` / `list[str]` / `dict` / `dict` / `None` / `None` | no | unit `tests/unit/test_faas_transfer.py` |
| `set_env` | HUB `compute_node.py:372` | `None` | no | none found |
| `open_service_url(service)` | HUB `compute_node.py:1936` | `str` (hub URL, no secret, no port) | no | unit `test_open_service_route_contract.py:112,126,148` |
| `_internal_service(name)` / `_INTERNAL_SERVICES` | HUB `compute_node.py:2017` / `:2007` | `InternalService`, raises on miss | no | unit `test_compute_node_service_allowlist.py:29-56,179` |
| `_may_receive_the_gate()` | HUB `compute_node.py:1973` | `bool` | no | api `test_compute_node_open_service.py:135-194` |
| `_stored_cookie_gate()` | HUB `compute_node.py:855` | `str \| None`, never writes | no | unit `test_workspace_health_probe_gate.py:68` |
| `_is_agent` / `_runtime_for` | HUB `compute_node.py:512` / `:524` | `bool` / `str` | no | unit `test_workspace_runtime_label.py:28` |
| tool commands (9) | HUB `compute_node_tools.py:122,137,246,263,277,307,327,342,381` | `ApiResponse` (box envelope passthrough) | no — all go through `call_box_action` | unit `tests/unit/test_compute_node_tools.py`; **`reconcile_manifest` has zero tests** yet is driven from the browser at OSS `ui/src/hooks/use-sandboxes.ts:314` |

### Group B — needs work (envelope/return-shape problems, not provider problems)

| action | where | returns today | provider-leaky? | tested? |
|---|---|---|---|---|
| `_setup_op` | HUB `compute_node.py:463-480` | `ApiSuccessResponse(data=<provider node id str>)` (`:478`); re-hydrates from DB at `:467` because `self` is not the row it saves | **yes** (provider id on the wire) | long `long_tests/test_compute_api.py` — no unit |
| `_setup_lm_proxy_op` | HUB `compute_node.py:655` | `ApiSuccessResponse(data={"message","key_prefix"})` | no | api `test_pentest_secrets_compute.py:532` |
| `_workspace_ready_op` | HUB `compute_node.py:922` | `ApiSuccessResponse(data={"healthy","started_fallback","port","logged_in","login_detail"})` | no | unit `test_workspace_health_probe_gate.py`, `test_workspace_runtime_label.py` |
| `_curl_status` | HUB `compute_node.py:697-720` | **HTTP status as a `str`**, `"000"` sentinel (`:716,:720`) | no | only via `_service_health_code` |
| `_service_health_code` / `_workspace_health_code` | HUB `compute_node.py:722-744` / `:746` | `str` status code | no | unit `test_workspace_health_probe_gate.py:42-84` |
| `_wait_service_healthy` / `_wait_workspace_healthy` | HUB `compute_node.py:750-766` / `:768` | `str` (last code); timeout injectable (`:751`) | no | unit `test_compute_node_service_allowlist.py:154,170` |
| `_workspace_login` | HUB `compute_node.py:866-920` | `tuple[bool, str]` — the same slot carries an email on success and an error sentence on failure, and is then persisted as `logged_in_user` (`:984`) | no | unit `test_workspace_runtime_label.py`; long `test_auto_login_sandbox.py` |
| `_cookie_gate_secret` | HUB `compute_node.py:825-853` | `str` — **and `await self.update()` at `:852`**; a read path that writes | no | api `test_pentest_secrets_compute.py:48-86` |
| `_restart_workspace_app` | HUB `compute_node.py:791` | `str` (trimmed stderr, falling back to stdout) | coupled to E2B env-prefix mechanics (comment `:812`) | none |
| `_open_service_failure` | HUB `compute_node.py:2042-2063` | `ApiFailResponse` **or** starlette `HTMLResponse`, per `Accept` | no | api `test_compute_node_open_service.py:119` |
| `open_service_action` / `_open_service_op` | HUB `compute_node.py:2155` / `:2065` | `RedirectResponse(302)` \| `HTMLResponse` \| `ApiFailResponse` | see §2.4 | api `test_compute_node_open_service.py` (13); long `test_open_internal_service.py` |
| `get_host_action` | HUB `compute_node.py:2293` | `RedirectResponse` by default, else `ApiSuccessResponse(data={"url","port"})` | returns provider URL verbatim | unit `test_open_service_route_contract.py:74,80` |
| `auto_login_action` | HUB `compute_node.py:2170` | `ApiSuccessResponse(data={"auto_login","logged_in_user"})` | no | api `test_auto_login.py` (19 tests) |
| PTY: `terminal_command` + 6 handlers | HUB `compute_node.py:1260,1306,1450,1577,1612,1681,1747,1811` | `ApiResponse` wrapping `ResponseMessage.model_dump()` — **except `_close_pty_session`'s not-found branch, which returns the model, not `model_dump()`** (`:1747+`) | session key is `(self.id, self.node_provider_id, session_id)` at `:1364,1392,1485,1648,1716,1774,1824` | only api `test_pentest_identity_auth.py:159` (case-folding) |
| `_tool_op` / `ops` | HUB `compute_node.py:1885` / `:1899` | `ApiResponse \| StreamingResponse`; every raise flattens to `ApiFailResponse(str(e))` at `:1933-1934` | no | unit `test_compute_node_tools.py:445-475` asserts registration + name-disjointness |

### Group C — provider-bound (the migration surface)

| action | where | returns today | provider-leaky? | tested? |
|---|---|---|---|---|
| `_startup_op` | HUB `compute_node.py:482-495` | `ApiSuccessResponse(data=<provider return, untyped>)`; `if not result → fail` at `:492` | **yes** — falsy-return contract | long only |
| `_shutdown_op` | HUB `compute_node.py:620-640` | same shape; `if not result → fail` at `:636` | **yes** | api `test_pentest_identity_keys.py:504-515` (key revocation, not the return) |
| `_pause_op` | HUB `compute_node.py:642-653` | same shape; `if not result → fail` at `:649`; passes `immediate=True` (`:648`) | **yes** — `immediate` is an E2B-only concept | unit `test_deployment_field_parity.py:96-137` |
| `_resume_op` | HUB `compute_node.py:670-680` | same shape; `if not result → fail` at `:676` | **yes, live bug** — Local returns `None` | unit `test_compute_node_service_allowlist.py:105-108` documents the bypass |
| `_status_op` | HUB `compute_node.py:682-695` | `ApiSuccessResponse(data=<provider dict verbatim>)` (`:693`); docstring `:684-687` "and for E2B also started_at/end_at/cpu_count/memory_mb" | **yes** | long only; consumed untyped at OSS `ui/src/hooks/use-sandboxes.ts:412` |
| `_get_metrics_op` | HUB `compute_node.py:998-1006` | provider-native object; docstring `:999` "(E2B only)"; base returns `[]` | **yes** | **none** |
| `_get_logs_op` | HUB `compute_node.py:1008-1023` | provider-native object; docstring `:1009` "(E2B only)"; base returns `[]` | **yes** | **none** |
| `_command_op` | HUB `compute_node.py:1025-1140` | `StreamingResponse` (SSE) or `ApiSuccessResponse(data=<FlowData XML string>)`; retries on provider **error-text** match at `:1069` | **yes** | api + unit `test_compute_streaming.py` — the retry branch itself untested |
| `setup_node` | HUB `compute_node.py:199-213` | `str` provider id **and** mutates `self.node_provider_id` | no (refuted, §2 R4) | long `long_tests/test_faas_compute.py` |
| `setup_lm_proxy_access` | HUB `compute_node.py:417-458` | `str` (full key); calls `configure_lm_proxy_env` (`:452`) | provider-owned env wiring | api `test_pentest_secrets_compute.py:532` |
| `copy_folder` / `extract_zip` | HUB `compute_node.py:351` / `:333` | `None` | uses `provider.get_temp_folder()` + `provider.path_sep` (`:361`), `provider.extract_archive_command` (`:342`) — refuted, §2 R6 | unit `test_faas_transfer.py` |

---

## 2. Abstraction failures, confirmed

**Coverage limit, stated up front.** The adversarial pass ran on **8** of the ~25 items discovery marked `provider_leak: true`, and **all 8 were refuted** (verdict header: "0 of 8 survived"). Those 8 were taken in list order, not by strength — an audit-design flaw, so "0 survived" says nothing about the other ~17. The failures below are ones re-read and confirmed from source.

> **F1–F6 were all re-verified at source after the audit (2026-08-08).** See
> [Post-audit verification](#post-audit-verification) at the end for the exact
> provider bodies. Nothing in F1–F6 now rests on truncated evidence.

### F1 — There is no success contract for a provider lifecycle call
`_resume_op` at HUB `compute_node.py:675-677`:
```python
result = await self.compute_provider.resume(self.node_provider_id)
if not result:
    return ApiFailResponse(message="Failed to resume compute node")
```
Per evidence, `LocalComputeProvider.resume` is a bare `pass` (`local_compute_provider.py:226-228`) while E2B returns `True` (`e2b_provider.py:362`). A successful local resume is therefore reported to the client as a failure. The identical `if not result` shape sits in `_startup_op:492`, `_shutdown_op:636` and `_pause_op:649` — three more instances of the same latent bug, none of which got the workaround. And the workaround exists, in-source, as a comment: `_open_service_op:2111-2116` calls `self.resume()` and not `_resume_op`, "deliberately not `_resume_op`: that reports failure when the provider returns None (which LocalComputeProvider does)". Calling code branching on provider identity is exactly what that comment is.
**Seam:** the lifecycle methods on `ComputeProviderBase` return `None` and *raise* on failure. The op layer then has nothing to interpret — success is "it returned".

### F2 — Provider failure is typed as English prose
`_command_op` at HUB `compute_node.py:1069`:
```python
if "not found" in error_msg.lower() or "paused" in error_msg.lower():
```
This is the resume-and-retry trigger, and it depends on the wording of the provider SDK's exception text. A provider SDK upgrade silently disables recovery; a new provider silently never gets it.
**Seam:** `NodeNotFound` / `NodePaused` exceptions raised by the provider driver; the op catches the type.

### F3 — Provider-shaped payloads are returned verbatim to clients
`_status_op:693` passes `get_node_details` straight through, and its own docstring (`:684-687`) enumerates the E2B-only keys. `_get_metrics_op:1003` and `_get_logs_op:1021` do the same, docstringed "(E2B only)" (`:999`, `:1009`). The browser consumes this untyped at OSS `ui/src/hooks/use-sandboxes.ts:412` (`opsCall<SandboxDetails>(nodeId, 'status')`), so the frontend's `SandboxDetails` type is *by construction* the union of one provider's field set with another's.
**Seam:** a `NodeStatus` value object on the hub with `state` required and `started_at/ended_at/cpu_count/memory_mb` optional; providers fill what they have. Metrics/logs get an explicit `Capability` answer so "unsupported" is distinguishable from "empty" — today the base returning `[]` makes those the same value.

### F4 — Identity is established as a side effect and then leaked as a payload
`setup_node` (HUB `compute_node.py:199-213`) both returns the provider id and assigns `self.node_provider_id`. `_startup_op:484-486` then re-assigns and re-saves it; `_setup_op:467` re-hydrates a *different* instance from the DB because `self` isn't the row it will save; `_setup_op:478` puts the provider id on the wire as `data`. On the OSS side the browser then writes it back into its own model: `ts_sdk/src/entities/compute-node/compute-node.ts:486` (`this.node_provider_id = data as string`) and `ui/src/hooks/use-sandboxes.ts:489` (`opsCall<string>(draft.id, 'setup', …)`).
That is three copies of one identity with no single writer, and a provider-scoped id crossing a trust boundary it has no business crossing (it is the E2B sandbox id; HUB `compute_node.py:141-146` marks the field `_immutable_update` precisely because a client-writable value would let a user repoint at another tenant's sandbox).
**Seam:** `provision()` returns the *entity's* identity (or nothing), persists the provider id itself, and the response body never contains `node_provider_id`. Clients refetch the entity.

### F5 — `set_node_status` is a mandatory contract method both providers no-op *(evidence, not re-verified)*
Base raises at `compute_provider.py:235`; E2B (`e2b_provider.py:436-439`) and Local (`local_compute_provider.py:234`) both `pass`. The `ERROR` status that `wait_for_ready` writes on a failed probe (`compute_provider.py:401/407/418`) is discarded, unobservable, and therefore untestable.
**Seam:** delete the method, or make status a hub-side field the entity owns.

### F6 — Dead / one-sided contract methods *(evidence, not re-verified)*
`restart` is declared at `compute_provider.py:219`, implemented by nobody, called by nobody. `send` is a real websocket send on the base (`compute_provider.py:423`) and a `pass` on E2B (`e2b_provider.py:713-716`) — so `ComputeNode.send` (HUB `compute_node.py:460`) silently discards on E2B. `get_node_connection` returns `None` unconditionally on E2B (`e2b_provider.py:718`) and a real `ServerConnection` on Local. `DockerComputeProvider` (`docker_compute_provider.py:75`) is unreachable: `get_compute_provider` (`providers/__init__.py:11-21`) is an if/else where local wins and everything else falls through to E2B, and Docker is not imported there.
**Seam:** the base contract should carry only what both providers actually implement; capability gaps become explicit `Capability`/`NotImplementedError`-with-a-type, not benign empty values.

### Refuted — do not flatten these

| claim | why it is legitimate |
|---|---|
| R1 `compute_provider` property (HUB `:186`) is a leak | It *is* the dispatch seam — a null guard plus one registry call; all provider selection lives in `providers/__init__.py:11-21`. |
| R2 `provider_type_id_str` (HUB `:192`) is a leak | An f-string over two of the entity's own fields (`:164-165`), no branch — and it has **zero callers** in either checkout (dead code, a different finding). |
| R3 `get_host` (HUB `:195`) is a leak | One-line delegation; the URL grammar lives in `ComputeProviderBase.get_host` (`compute_provider.py:262`) with per-provider overrides. |
| R4 `setup_node`'s `get_template_version` (HUB `:207`) is a leak | Unconditional polymorphic call; the base returns `None` by contract (`compute_provider.py:196-202`) and `template_version` is nullable (`:168`). Template identity is genuinely provider-specific. |
| R5 `verified_node_provider_id` (HUB `:216`) is a leak | A pure Optional-narrowing accessor written once instead of at ~20 call sites; `get_node_status:226` deliberately does *not* use it, which is the correct handling of the pre-provision case. |
| R6 `extract_zip` / `copy_folder` shelling out via `provider.extract_archive_command`, `get_temp_folder()`, `path_sep` (HUB `:342,:361`) | This is the abstraction *working*: shell-shape differences are provider methods, not inline branches (Local overrides with PowerShell, `local_compute_provider.py:125`). |
| R7 `is_local_node = self.node_provider == ComputeProvider.LOCAL_MACHINE.value` (HUB `:2088`) | The only provider-enum comparison in the class, and it is a **request-topology security decision**, not a capability one: Local's `http://localhost:<port>` resolves on the *browser's* machine, so a remote caller would be handed this node's gate secret (comment `:2089-2093`, enforcement `:2100-2101`, gate suppression `:2146`). No provider method can see the request or the principal. Keep it. |

Two further verdicts were in the refuted set but their subject lines were truncated out of the evidence record; I cannot name them.

---

## 3. Two transports, one box

Both do `node.run_command(<shell string with curl>, background=False)` → `cmd.wait(...)` → read `cmd.all_stdout`. They agree on nothing else.

| | `call_box_action` — HUB `compute_node_tools.py:49-101` | `_curl_status` — HUB `compute_node.py:697-720` |
|---|---|---|
| gate delivery | **cookie exchange**: `GET /auth/gate?cookie-gate=…&next=/` with `-c jar` (`:70,:80`), then replay with `-b jar` (`:81`), then `rm -f jar` (`:83`) | **header**: `-H 'X-Cookie-Gate: {gate}'`, appended only when truthy (`:715`) |
| gate source | `await node._cookie_gate_secret()` (`:68`) — **mints and `await self.update()`s** (`compute_node.py:850-852`) | caller-supplied; `_service_health_code:744` passes `_stored_cookie_gate()`, which never mints |
| quoting | `shlex.quote` on jar, gate url, action url, JSON body (`:69-82`) | hand-written single quotes around the url (`:716`); docstring `:705-712` admits it rests on the callers' alphabets |
| curl timeout | none — no `-m` (`:80-81`) | `-m {connect_timeout}`, default 5 (`:698,:716`) |
| wait budget | `WORKSPACE_ACTION_TIMEOUT = 120.0` (`:46,:86`) | `wait_timeout` default 15.0 (`:698,:719`); `_workspace_login:915` passes 45.0 |
| verb/body | GET or POST/other with JSON body (`:73-78`) | GET only, no body |
| returns | parsed `{status,message,data}` → `ApiResponse` (`:87-101`) | **HTTP status string**, body discarded (`-o /dev/null -w '%{http_code}'`), `"000"` sentinel (`:716,:720`) |
| target | app-relative path on `http://127.0.0.1:{workspace_server_port}` (`:67,:71`) | caller-built absolute url |

**Rule compliance.** The docstring rule at `compute_node_tools.py:23` ("call_box_action owns that transport so no command hand-rolls curl") holds absolutely *inside that module*: all nine commands route through it (`:130,:222,:256,:274,:304,:320,:335,:354,:369`) and the only `curl` literals are inside `call_box_action` itself (`:80,:81`).

**Who is on which, and who is wrong.**

- `_curl_status` is the only other curl string in the hub tree, used by `_service_health_code:744`, `_workspace_health_code:748`, `_wait_service_healthy:761,765`, `_wait_workspace_healthy:770`, and `_workspace_login:914-915`.
- **Neither of those two is "on the wrong transport" — both are structurally excluded**, and the refactor must not fold them in: (a) `_workspace_login` is the request that *arms* the gate (`compute_node.py:886-887`), so it cannot ride a channel that presupposes an armed gate; (b) `_service_health_code:740-743` states in-source that a health probe **must never mint** a gate, which `call_box_action:68` does.
- **The genuinely wrong caller is `login-status`.** `login_status` (`compute_node_tools.py:381`) → `read_login_status` (`:357`) → `call_box_action(..., method="GET")` (`:369`) → `_cookie_gate_secret()` (`:68`). A pure read probe mints a 32-byte secret, strips the legacy `node_config["cookie_gate"]` key, and writes the row (`compute_node.py:850-852`). Two knock-ons: `gated_host_url:1967` branches on `_stored_cookie_gate()` being truthy, so after one status probe a node that used to hand out a bare host starts handing out `…/auth/gate?cookie-gate=<secret>&next=/`; and the box's app is armed only by `_workspace_login`, so between mint and next login the hub holds a secret the app has never seen.
- **Layering violation, both transports:** `call_box_action` takes an untyped duck-typed `node` and reaches into the entity's private `node._cookie_gate_secret()` from a service module; nothing in `compute_node_tools.py` imports or annotates `ComputeNode`.

**Consolidation target:** one `node.http(path, *, method, json, gate: GateMode)` where `GateMode` is `MINT | STORED | NONE`, plus one `node.probe(port, path)` implemented on top of it with `-o /dev/null -w`. Both `shlex.quote`d, both `-m`'d, one wait budget per call site (do not widen any of the existing three — see the repo's timeout policy).

---

## 4. Proposed one-liner surface

Failure is an exception, never a falsy return and never an envelope. `ApiResponse` appears **once**, in a `_envelope(coro)` wrapper inside `ops()` (HUB `compute_node.py:1899`). HTTP status codes become `int`, not `str`; `"000"` becomes `0` or `None`.

```python
# --- errors (new module, HUB flowpad/hub/core/faas/compute/errors.py) ---
class NodeError(Exception): ...
class NodeNotProvisioned(NodeError): ...   # replaces verified_node_provider_id's RuntimeError
class NodeNotFound(NodeError): ...         # replaces the "not found" string match
class NodePaused(NodeError): ...           # replaces the "paused" string match
class NodeUnsupported(NodeError): ...      # replaces base-returns-[] and NotImplementedError

# --- value objects (new) ---
@dataclass(frozen=True) class NodeStatus:   state: ExecutionEnvironmentStatus; started_at: datetime|None; ended_at: datetime|None; cpu_count: int|None; memory_mb: int|None
@dataclass(frozen=True) class CommandResult: stdout: str; stderr: str; exit_code: int
@dataclass(frozen=True) class LoginResult:   ok: bool; principal_label: str|None; http_code: int

# --- lifecycle ---
async def provision(self, *, size: NodeSize|None = None, lm_proxy: bool = True) -> str
async def start(self)  -> None
async def stop(self)   -> None
async def pause(self, *, immediate: bool = True) -> None
async def resume(self) -> None
async def status(self) -> NodeStatus

# --- execution / transport ---
async def run(self, command: str, *, timeout: float, env: dict|None = None) -> CommandResult
async def http(self, path: str, *, method: str = "POST", json: dict|None = None, gate: GateMode = GateMode.STORED) -> ApiResponse
async def probe(self, port: int, path: str = DEFAULT_HEALTH_PATH, *, timeout: float = 15.0) -> int
async def wait_healthy(self, port: int, path: str = DEFAULT_HEALTH_PATH, *, timeout: float = WORKSPACE_HEALTH_TIMEOUT) -> int

# --- routing ---
def host(self, port: int) -> str
def gated_host(self, port: int) -> str
def service_url(self, service: str) -> str

# --- observability (capability-typed) ---
async def metrics(self) -> list[NodeMetric]     # raises NodeUnsupported, never returns [] to mean "can't"
async def logs(self, limit: int = 100) -> list[str]

# --- session ---
async def login(self, principal) -> LoginResult
async def end_session(self) -> None
```

| proposed | replaces | move or rewrite |
|---|---|---|
| `provision` | `setup_node:199` + `_setup_op:463` | **rewrite** — drops the DB re-hydration at `:467` and the double-assign at `_startup_op:484-486` |
| `start` / `stop` / `pause` / `resume` | `startup:234`+`_startup_op:482`, `shutdown:258`+`_shutdown_op:620`, `pause:243`+`_pause_op:642`, `resume:238`+`_resume_op:670` | **rewrite** — deletes all four `if not result` checks (`:492,:636,:649,:676`); `immediate` becomes a base-contract kwarg |
| `status` | `get_node_status:226` + `_status_op:682` | **rewrite** — normalizes `get_node_details` into `NodeStatus` |
| `run` | `run_command:246` + the `cmd.wait/all_stdout` idiom repeated at `compute_node_tools.py:84-90`, `compute_node.py:344,394,718,802` | **move**, with the retry-on-`NodePaused` from `_command_op:1069` folded in as a typed catch |
| `http` | `call_box_action:49` | **move** onto the entity + `GateMode` param; fixes §3's `login-status` mint |
| `probe` / `wait_healthy` | `_curl_status:697`, `_service_health_code:722`, `_workspace_health_code:746`, `_wait_service_healthy:750`, `_wait_workspace_healthy:768` | **rewrite** — five functions to two; `str`→`int`; do **not** change any timeout value |
| `host` / `gated_host` / `service_url` | `get_host:195`, `gated_host_url:1954`, `open_service_url:1936` | **move** unchanged — these are already correct |
| `metrics` / `logs` | `_get_metrics_op:998`, `_get_logs_op:1008` | **rewrite** — base must raise `NodeUnsupported`, not return `[]` |
| `login` | `_workspace_login:866` | **rewrite** — kills the `tuple[bool, str]` overload where success-email and failure-sentence share one slot (`:984`) |
| `end_session` | `_end_box_session:2231` | **move** |

**Identity as a return value, not a side effect.** Three places currently establish identity by mutation and then also leak it:
1. `setup_node:199-213` assigns `self.node_provider_id` *and* returns it; `_startup_op:484-486` assigns and saves it a second time. `provision()` must be the single writer and must persist before returning.
2. `_setup_op:478` returns the **provider-side** id as the API payload; OSS `ts_sdk/…/compute-node.ts:486` and `ui/src/hooks/use-sandboxes.ts:489` consume it. The wire value must become the node's own id (or nothing) — the provider id is `_immutable_update`-protected server-side (`compute_node.py:141-146`) precisely because it is a tenancy-sensitive handle.
3. PTY sessions are keyed on `(self.id, self.node_provider_id, session_id)` (`:1364,1392,1485,1648,1716,1774,1824`) and `_list_pty_sessions:1811` filters on the provider id. A resume that changes the provider id orphans every session. The key must be `(self.id, session_id)`.

---

## 5. Test plan

**One fake unlocks most of this:** `FakeComputeProvider(ComputeProviderBase)` returning a scripted `CLICommand` (`stdout`, `stderr`, `exit_code`) and recording every shell string it was handed. Register it by monkeypatching `get_compute_provider` (HUB `providers/__init__.py:11`) — which is also worth making an explicit enum map rather than an `else: E2B` fallthrough while you are there.

| one-liner | what makes it unit-testable | seam/fake needed |
|---|---|---|
| `provision` | returns the id and the row is saved once; assert `node_provider_id` written exactly once and absent from the response body | FakeProvider `create_node` |
| `start/stop/pause/resume` | no return value to assert — assert **no exception** for a provider returning `None` (the F1 regression) and `NodeError` propagation for one that raises | FakeProvider with `None`-returning and raising variants |
| `status` | `NodeStatus` is asserted field-by-field for a rich (E2B-shaped) and a thin (Local-shaped) `get_node_details` | FakeProvider returning both dict shapes |
| `run` | assert the **exact shell string** and that `NodePaused` triggers exactly one resume+retry — the `:1069` branch is untested today | FakeProvider raising `NodePaused` on first call |
| `http` | assert the composed curl (shlex-quoted, `-m` present) and, per `GateMode`, whether `_cookie_gate_secret` was called; a `GateMode.STORED` call on an ungated node must perform **zero DB writes** | FakeProvider + a spy on `update()` |
| `probe` / `wait_healthy` | `int` return; unreachable → `0`; `timeout` already injectable at `compute_node.py:751` so failure paths run sub-second — keep that parameter, do not raise the default | FakeProvider scripted status sequence |
| `host` / `gated_host` / `service_url` | pure string functions; already covered at `test_compute_node_service_allowlist.py:59,78,82` and `test_open_service_route_contract.py:112` | none |
| `metrics` / `logs` | assert `NodeUnsupported` on a provider without the capability — the first tests these ops will ever have | FakeProvider without the methods |
| `login` | `LoginResult.ok` and `principal_label` asserted separately; `logged_in_user` must only ever receive `principal_label` | stub as at `test_agent_git_deploy_contract.py:62` |
| `end_session` | already exercised at `test_auto_login.py:116,133,147,159`; port them to the new signature | existing |

**Still requires a real provider (do not fake):** E2B `pause(immediate=…)`'s deferred-pause task and `_pause_tasks` registry; template-version resolution against actually-built templates; `get_logs`, which shells out to the `e2b` CLI binary rather than the SDK; the PTY streams; and the end-to-end open-service redirect. Keep those in `long_tests/test_faas_compute.py`, `long_tests/test_compute_api.py`, `long_tests/test_open_internal_service.py`.

---

## 6. Order of work

Repo policy: **`../test_flowpad/FlowPad` requires explicit user approval before any change.** Steps 1-9 are all HUB. Only step 10 is OSS-only.

1. **[HUB]** Land `NodeError` hierarchy + `NodeStatus` / `CommandResult` / `LoginResult` value objects and the `FakeComputeProvider`. Pure addition, nothing wired. Green trivially.
2. **[HUB]** Make `get_compute_provider` (`providers/__init__.py:11-21`) an exhaustive enum map; delete `restart` (`compute_provider.py:219`) and `DockerComputeProvider` (`docker_compute_provider.py:75`) — both unreachable. Green: nothing referenced them.
3. **[HUB]** Fix F1 in isolation: lifecycle provider methods return `None` and raise; delete the four `if not result` checks (`compute_node.py:492,636,649,676`). Add the `test_local_resume_succeeds` unit test that fails before this step. Update `test_compute_node_service_allowlist.py:105-108`, whose current assertion **documents the bug**.
4. **[HUB]** Introduce `probe`/`wait_healthy` returning `int`; collapse the five `str`-code functions. Callers comparing `!= "200"` (`compute_node.py:762,968,2136`) move to `!= 200`. Timeout defaults unchanged.
5. **[HUB]** Introduce `node.http(..., gate: GateMode)`; move `call_box_action` onto it and switch `login-status`/`read_login_status` to `GateMode.STORED`. This is the §3 fix and the one behavior change a user could notice (a status probe stops arming a gate) — ship it alone.
6. **[HUB]** `status()` → `NodeStatus`; `metrics()`/`logs()` → `NodeUnsupported`. Their first tests land here. Wire shape changes, so pair with step 10.
7. **[HUB]** Typed provider errors; replace the `:1069` string sniff with `except NodePaused`. Test the retry.
8. **[HUB]** `provision()` as single identity writer; strip `node_provider_id` from the `setup` response body; delete the `_setup_op:467` re-hydration and the `_startup_op:484-486` double-write.
9. **[HUB]** Re-key PTY sessions on `(node.id, session_id)`; fix `_close_pty_session`'s model-vs-`model_dump()` inconsistency. **Last** — it is the least-tested cluster (only `test_pentest_identity_auth.py:159`), so write characterization tests before touching it.
10. **[OSS]** Consumers: `ts_sdk/src/entities/compute-node/compute-node.ts:474-489` (`setup` no longer returns the provider id), `:506`/`:560` (command), `ui/src/hooks/use-sandboxes.ts:155-160` (`opsCall`), `:412` (`SandboxDetails` becomes the normalized `NodeStatus` shape), `:489`, `:586`. Ships after 6 and 8. No hub approval needed.

Steps 1-5 are independently shippable and mutually non-conflicting. 6+8 are a coordinated pair with 10. 9 is deliberately last.

---

## 7. Unknowns

| unresolved | what settles it |
|---|---|
| The provider-contract evidence arrived truncated (cut off at `compute_provider.py:635-637`) — F5/F6 rest on it unverified, and the `shutdown` contract entry is missing entirely. | `grep -n "def \(shutdown\|set_node_status\|send\|restart\|get_node_connection\)" flowpad/hub/core/faas/compute/providers/*.py` in HUB, then read each body. |
| 17 of ~25 discovery-flagged leaks never went through refutation; the refuted-8 record is itself missing 2 subject lines. | Re-run the adversarial pass over the Group C rows in §1 that are not F1-F4. |
| Whether `_restart_workspace_app:791` actually depends on `e2b_provider._env_prefix` semantics or the comment at `:812` is stale. | `grep -n "_env_prefix" flowpad/hub/core/faas/compute/providers/e2b_provider.py` and read `run_command`'s `env` handling in both providers. |
| Whether OSS `flow_sdk/builtin/faas/compute_node.py:76` should be refactored in the same shape or is genuinely divergent (it uses `node_provider_type`, HUB uses `node_provider`; OSS `setup_node:286` has no `setup_lm_proxy`). | `diff <(grep -n "async def \|def " /Users/shlom/Documents/dev/flowpad-oss/flow_sdk/builtin/faas/compute_node.py) <(grep -n "async def \|def " /Users/shlom/Documents/dev/test_flowpad/FlowPad/flowpad/hub/builtin/faas/compute_node.py)` |
| Whether the PTY handlers have *any* coverage beyond `test_pentest_identity_auth.py:159`. | `grep -rn "terminal-command\|_start_pty_session\|pty_session" flowpad/hub/tests/` in HUB. |
| Whether `reconcile-manifest` (`compute_node_tools.py:263`, driven from OSS `use-sandboxes.ts:314`) has any test at all. | `grep -rn "reconcile_manifest\|reconcile-manifest" flowpad/hub/tests/` in HUB — discovery reports zero hits; confirm before relying on it. |
| Whether `provider_type_id_str` (HUB `:192`, OSS `:280`) is truly dead. | `grep -rn "provider_type_id_str" /Users/shlom/Documents/dev/test_flowpad/FlowPad /Users/shlom/Documents/dev/flowpad-oss --include='*.py' --include='*.ts'` |
---

## Post-audit verification

Run 2026-08-08 against the HUB checkout, to settle the items §2 and §7 left open.
Every line below is a direct read, not an inference.

### F1 — confirmed, and it is a live bug

`flowpad/hub/core/faas/compute/providers/`:

| method | base `compute_provider.py` | `e2b_provider.py` | `local_compute_provider.py` |
|---|---|---|---|
| `startup` | `:204` raises | `:241` | `:173` → `return True` |
| `shutdown` | `:207` raises | `:252` | `:177` |
| `pause` | `:210` raises | `:261` | `:218` → `return True` |
| `resume` | `:216` raises | `:323` | **`:226` → `pass` (returns `None`)** |

So `_resume_op`'s `if not result: return ApiFailResponse(...)` reports a *successful*
local resume as a failure. Its three siblings (`_startup_op`, `_shutdown_op`,
`_pause_op`) carry the identical shape and survive only because Local happens to
`return True` in those three. Nothing enforces that; the next provider method
written as a bare `pass` re-creates the bug.

### F5 — confirmed

`set_node_status`: base `compute_provider.py:234` **raises**, E2B `e2b_provider.py:436-439`
is `pass`, Local `local_compute_provider.py:234-236` is `pass`. A mandatory contract
method that no implementation implements.

### F6 — confirmed, all four claims

* `restart` — declared `compute_provider.py:219` (raises); **absent from both providers**.
* `send` — real implementation on the base (`compute_provider.py:423`), `pass` on E2B
  (`e2b_provider.py:713-716`). `ComputeNode.send` silently discards on an E2B node.
* `get_node_connection` — base raises (`:237`), E2B `return None` (`e2b_provider.py:718-721`),
  Local returns a real `ServerConnection` (`local_compute_provider.py:238-240`).
* `DockerComputeProvider` unreachable — `providers/__init__.py` is an `if provider ==
  LOCAL_MACHINE: … else: E2B`. Docker is never imported and cannot be selected. Anything
  that is not local silently becomes E2B, including a typo'd or future provider value.

### Dead code, confirmed

* `provider_type_id_str` — HUB `compute_node.py:192` and OSS
  `flow_sdk/builtin/faas/compute_node.py:280`. **Zero callers** in either checkout
  (the only other hits are copies of the same definition under `.claude/worktrees/`).
* `reconcile_manifest` — `compute_node_tools.py:263`. **Zero tests**
  (`grep -rn 'reconcile_manifest' flowpad/hub/tests/` → no hits), yet it is driven from
  the browser at OSS `ui/src/hooks/use-sandboxes.ts:314`.

### Still open

The unknowns in §7 that these greps did **not** settle: whether
`_restart_workspace_app`'s `_env_prefix` comment is stale, whether the PTY handlers have
coverage beyond `test_pentest_identity_auth.py:159`, whether OSS
`flow_sdk/builtin/faas/compute_node.py` should move in the same shape, and the ~17
provider-leak claims that never went through refutation.

