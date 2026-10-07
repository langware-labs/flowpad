# Networking between the Mac and the guest

> Invariants (inline by design): the guest reaches the Mac at `10.0.2.2`; `hostfwd_add` forwards
> die with QEMU — re-run `expose-port.sh` after every VM restart; system changes go through the
> admin lane (`vmrun.py -a`).

QEMU user networking (slirp): the guest is NATed. Outbound works; `10.0.2.2` is the Mac's
127.0.0.1, so a Mac server bound to localhost is reachable from the guest. Inbound exists only
for forwards: quickemu adds one persistent forward (host 22220 → guest 22, unused — see
`control.md`); everything else is added at runtime.

## Guest port → Mac

`scripts/expose-port.sh GUEST_PORT [HOST_PORT]` (host port defaults to guest + 10000). It does the
three hops that are all required — skip any and Mac `curl` returns `000` (`<GP>` = guest port,
`<HP>` = host port):
1. guest `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=<HP> connectaddress=127.0.0.1 connectport=<GP>`
   — guest apps bind 127.0.0.1, which slirp can't reach; portproxy needs the `iphlpsvc` service running.
2. guest inbound firewall rule for `<HP>`.
3. HMP `hostfwd_add tcp:127.0.0.1:<HP>-:<HP>`, verified in `info usernet` (an echoed command proves nothing).

`--remove` undoes it. Steps 1–2 persist across guest reboots; step 3 is lost on every QEMU restart.

## Mac service → guest, as "localhost"

Some clients insist the server be on localhost (Flowpad's cloud login refuses a non-localhost
hub — the local hub is `<PORT>` = 8093). Proxy the Mac's `<PORT>` onto the guest's own loopback,
admin lane:

```bash
scripts/vmrun.py -a 'netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=<PORT> connectaddress=10.0.2.2 connectport=<PORT>'
```

Then point the guest client at `http://localhost:<PORT>`. The rule persists across reboots;
remove it with
`scripts/vmrun.py -a 'netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=<PORT>'`.

## Moving files

- **Mac → guest:** serve a folder on the Mac (`python3 -m http.server 8799 --bind 127.0.0.1 -d <dir>`),
  fetch in a job: `Invoke-WebRequest -UseBasicParsing http://10.0.2.2:8799/<file> -OutFile C:\…`.
  Use it for wheels, installers and single-file patches.
- **Small text:** the shared clipboard (`operate.md`), or base64 inside a `vmrun.py` job.
- **Guest → Mac:** print it from a job (`Get-Content -Raw`), or `Invoke-WebRequest -Method Put`
  to a small Mac receiver.
- Install from artifacts rather than copying trees into the guest: every guest write grows the
  qcow2 on the Mac's disk, and a full Mac disk pauses the VM.

## Driving Edge in the guest over CDP

Start a **separate** Edge profile with a debug port (a user's already-running Edge ignores the
flag), user lane:

```powershell
Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" -ArgumentList '--remote-debugging-port=9222','--user-data-dir=C:\flowpad-test\edge-cdp','--no-first-run','--window-size=1280,860','<url>'
```

Then `scripts/expose-port.sh 9222` and from the Mac `curl -s 127.0.0.1:19222/json/version` — the
`webSocketDebuggerUrl` it returns (rewrite its host to `127.0.0.1:19222`) drives the page with any
CDP client (Playwright `connect_over_cdp`, `websockets`).

## Windows Firewall prompt

The first time a new program listens on a non-loopback address, Windows shows an "allow access"
dialog that covers the desktop and takes the keyboard. Loopback-only servers don't need it:
dismiss it with Cancel (`qmp.py shot`, then `qmp.py click`). Pre-adding a firewall rule
(expose-port step 2) avoids it for ports you publish.
