# `flow connect --docker <container>` — enroll a Docker container into the hub

A running container becomes a hub compute node (`user_machine`) exactly like a
laptop that ran `flow connect`: the hub drives it over the WebSocket the container
opens, `Open` runs `workspace-ready` inside it, and the workspace app comes up on
the container's port 9007. There is no desktop-local "docker compute node" any more
(`flow compute connect|worker|list`, `/api/v1/compute/ws`, the terminal "docker"
opener and the `docker_*` bootstrap fields were removed).

```
docker run -d --name mybox --add-host=host.docker.internal:host-gateway -p 9007:9007 python:3.12-slim sleep infinity
flow connect --docker mybox            # from a checkout with dist/*.whl (uv build --wheel --out-dir dist/)
```

What the host CLI does:
1. `docker cp` the newest `dist/flowpad-*.whl` + `install_flow_on_docker.sh` and installs into `/opt/flow`.
2. Writes `/etc/flowpad/machine.env`: `FLOWPAD_HUB_URL` (loopback hubs rewritten to
   `host.docker.internal`), `PYTHON_KEYRING_BACKEND=keyrings.alt.file.PlaintextKeyring`,
   `LOCAL_SERVER_PORT=9007`, `FLOW_INSTANCE=docker`.
3. Kills a previous in-container `flow connect`, then starts `flow connect` detached
   (`--code-file/--ready-file` markers under `/tmp`, log at `/tmp/flowpad-connect.log`).
4. Host logged in (`flow auth login`, or `FLOWPAD_CLOUD_API_KEY`) → it looks the code up and
   **approves it itself**; the node is `@docker-<container>` (or `--name`). Not logged in →
   the container's code/QR is printed for you to approve in the hub UI (Add Machine).
5. Waits until the container reports "connected", prints the node, and exits — the worker
   keeps running inside the container. Re-run the same command to reconnect (the container
   is signed in, so no code is needed the second time).

Prerequisites / gotchas: python3 ≥ 3.10 in the image; `curl` inside the container (the hub
probes the app with curl) and `procps` are nice to have; on Linux hosts add
`--add-host=host.docker.internal:host-gateway`; publish 9007 if you want to open the app
from the host. Manual `flow` commands inside the container should source the env first:
`set -a; . /etc/flowpad/machine.env; set +a`.

Old desktop `@docker-*` ComputeNode rows are removed by the `0.2.137` migration and, until
it runs, hydrate with an unset provider instead of failing the whole node list.

End-to-end check: `scripts/e2e_flow_connect_docker.sh` (`APPROVE=manual` for the code path).

<!-- flowpad:capsule identity
version: 1
data:
  id: ef2ffb57-bf41-4793-812f-3dd429f90539
flowpad:endcapsule identity -->
