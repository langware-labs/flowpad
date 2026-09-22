Serve HTTP 200 at `/health` on port 8099.

`python3 -m http.server` starts happily and answers 404 for `/health`, so starting
it is not reaching the goal.

The cheap attempt already started one, and it is still holding the port — free it
before you bind, e.g. `pkill -f "http.server 8099"`, then confirm with
`curl -sf localhost:8099/health` that nothing is answering yet.

Then serve a real `/health` route: a few lines of
`http.server.BaseHTTPRequestHandler` returning 200, started in the background
with `nohup … &` so it outlives your shell. The check runs in a FRESH shell, so a
server tied to your session will be gone by the time it is asked.
