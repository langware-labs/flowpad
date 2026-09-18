Serve HTTP 200 at `/health` on port 8099.

`python3 -m http.server` starts happily and answers 404 for `/health`, so starting it is not reaching the goal. Serve a real `/health` route instead — a few lines of `http.server.BaseHTTPRequestHandler` in a background process is enough. Free the port first if something is already holding it.
