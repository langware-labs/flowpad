test 1: Flowpad Assistant collab space lists the shipped sample doc
- navigate to {APP_URL}/dock/project/@flowpad_assistant
- wait for the project page (CollaborationPage) to render
- expand the DOCS category in the left sidebar
- validate a doc with name "Hello from Flowpad" is visible in the DOCS list
  (the seeded markdown title; the filename on disk is hello-flowpad.md)
- click it
- wait 500 ms
- validate a room tab opens with the title "Hello from Flowpad"
- validate the rendered markdown contains the heading "Hello from Flowpad" and the body text "Welcome to the Flowpad Assistant workspace."

test 2: Footer "Flowpad docs" button opens the Flowpad Assistant collab space
- navigate to {APP_URL}/dock/home
- locate the application footer (bottom bar of the window)
- validate a button with aria-label="Flowpad docs" is visible to the LEFT of the ClaudeUsageChip
- click the "Flowpad docs" button
- wait up to 1 second for navigation
- validate the URL is /dock/project/@flowpad_assistant (URL-encoded as /dock/project/%40flowpad_assistant)
- validate the CollaborationPage rendered for the Flowpad Assistant project

test 3: Server include_system filter default hides system markdown rows
- with the backend running at {API_URL} (default http://localhost:9008/api/v1)
- run: curl -sS '{API_URL}/search?record_type=markdown&q=hello-flowpad'
- validate the JSON response has data.total == 0 (system records hidden by default)
- run: curl -sS '{API_URL}/search?record_type=markdown&q=hello-flowpad&include_system=true'
- validate the JSON response has data.total >= 1 and at least one result has asset_ref ending in /hello-flowpad.md (the seeded system markdown)

test 4: Bootstrap re-scans markdown after system projects are ensured (recovery path)
- stop the backend
- locate the backend's SQLite DB used by fs_store (e.g. /root/.flow/dev_db/flowpad_db inside the dev container)
- run: sqlite3 <path> "DELETE FROM entities WHERE type='markdown' AND json_extract(data, '$.asset_ref') LIKE '%/hello-flowpad.md';"
- start the backend
- once the server reports ready, hit GET {API_URL}/graph/bootstrap
- wait for the bootstrap response (200 OK)
- run: sqlite3 <path> "SELECT count(*) FROM entities WHERE type='markdown' AND json_extract(data, '$.asset_ref') LIKE '%/hello-flowpad.md';"
- validate the row reappears (bootstrap re-indexed system project markdowns)
