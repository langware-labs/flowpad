---
name: Find out why my Flowpad "Report issue"…
---

Find out why my Flowpad "Report issue" clicks never reached the server on Mon 27 July 2026, around 17:15 local time.

Background: the Flowpad server logged exactly ONE report from me that day, at 14:14:56 UTC (17:14:56 Israel time), but I clicked the button about 16 times. We need to know what happened to the other clicks — did they leave my machine and fail on the network, or did they never fire at all?

My local Flowpad backend logs this. Please:

1. Locate my Flowpad backend logs. Try, in order:
     ~/.flow/instances/*/logs/
     ~/.flow/dev_logs/app/
     the Flowpad desktop app log folder (Electron: ~/Library/Logs/ on macOS)

2. Search them for the report action:
     grep -r "\[report\] POST" <each log dir>

3. For entries around 2026-07-27 17:15 local time, count how many match each of these two shapes — this difference is the whole answer:
     "... transport error: ..."   -> the request NEVER left this machine
     "... returned 500: ..."      -> the request DID reach the server, which rejected it

4. Report back:
     - the count of each shape
     - the matching log lines (timestamp + status is enough)
     - whether you find ~16 attempts, or only 1

5. Also check and report: does my Flowpad account have a display NAME set, or only an email address? (Account / profile screen.) This confirms the root cause of the server-side crash.

Nothing sensitive is needed — just timestamps, the URL, and status codes.

<!-- flowpad:capsule identity
version: 1
data:
  id: 9642b0ee-3485-4619-8ef9-0597cf396ce4
flowpad:endcapsule identity -->
