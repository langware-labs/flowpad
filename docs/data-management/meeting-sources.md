---
id: 11279a80-e580-44da-a1a1-446a9a289200
---
# Meeting sources — Zoom, Teams, Google Meet

Research for meeting **recordings (video/audio), transcripts and AI notes** as
data sources, plus where each would sit in our driver model. Researched
2026-09-29; items marked *unconfirmed* were not verifiable from public docs.

## The three vendors

| | Zoom | Teams (Microsoft Graph) | Google Meet |
|---|---|---|---|
| Video | Zoom Cloud MP4/M4A; `download_url` + Bearer | OneDrive (SharePoint for channel meetings); `…/recordings/{id}/content` | organizer's Drive; `files.get?alt=media` |
| Transcript | VTT with speaker names; only for cloud-recorded meetings | VTT with `<v Speaker>` tags, or a plain-text form with no speakers | Google Doc + `transcriptEntries` JSON (participant, timing; kept 30 days) |
| AI notes | AI Companion `GET /meetings/{id}/meeting_summary` (summary, next steps) | `copilot/users/{id}/onlineMeetings/{mid}/aiInsights` (notes, action items with owners); up to 4h after the meeting | `conferenceRecords/{cr}/smartNotes` → the Gemini notes Doc |
| Auth | General (user-managed) OAuth app, or Server-to-Server for account-wide | `OnlineMeetingTranscript.Read.All`, `OnlineMeetingRecording.Read.All`, `OnlineMeetingAiInsight.Read.All` — all admin consent; application permissions also need `New-CsApplicationAccessPolicy` | `meetings.space.readonly` (sensitive) + `drive.meet.readonly` (restricted → verification + yearly CASA assessment) |
| Push | webhooks `recording.completed`, `recording.transcript_completed`, `meeting.summary_completed` | Graph subscriptions; a transcript fires only if the subscription predates transcription | Workspace Events API over Cloud Pub/Sub (7-day subscriptions; pull needs no public URL) |
| Who can read | host only with a user token | organizer | organizer, or a whole domain via domain-wide delegation |
| Plan | Pro+ for cloud recording; AI Companion enabled | work/school tenant; notes need M365 Copilot per user; transcript/recording API metering ended 2025-08-25 | Workspace Business Standard+; consumer Gmail cannot record |

Shared gotcha: artifacts belong to the **organizer**. A person who only attended
sees nothing with their own token; reading everyone's meetings needs the org-level
grant (Zoom Server-to-Server, Graph application permission + access policy,
Google domain-wide delegation).

Unconfirmed: the maximum Graph subscription lifetime for transcript/recording
resources; whether Teams Premium alone (without Copilot) exposes the recap API;
the exact Workspace SKUs for Meet recording and Gemini notes; whether
`smartNotes` is GA.

## Connections

* **Zoom** — `zoom` connector (hub plugin + `ZOOM` desktop descriptor), validated
  on dev 2026-09-30. Scopes: `user:read:user`, `meeting:read:list_meetings`,
  `meeting:read:meeting`, `meeting:read:summary`,
  `cloud_recording:read:list_user_recordings`,
  `cloud_recording:read:list_recording_files`. Zoom refuses a `localhost`
  callback, so a local hub cannot complete consent.
* **Teams** — the existing `microsoft` connector; add the three `OnlineMeeting*`
  scopes (admin consent).
* **Meet** — the existing `google` connector; add `meetings.space.readonly` and a
  Drive scope. The hub `googledrive` plugin already requests `drive.readonly`, so
  its verification status decides whether Meet is days or weeks.

## Fit with the driver model

* Three self-contained driver assets (`zoom_meetings`, `teams_meetings`, `gmeet`)
  under `agentic-assets/data_driver/`; Teams meetings stays separate from the
  `teams` channel-message driver.
* One generic value type in `flow_sdk/sources/values/` — a meeting record
  (id, title, times, organizer, participants, transcript segments with speaker
  and timing, notes, action items, recording as a `FileItem`), `VoiceTurnData`
  being the closest precedent — so all three drivers emit one shape.
* Family: `RecordSource` with the recording as a metadata-only `FileItem` whose
  bytes stream through `open()` into `cache_root()`, as `gdrive` does. Whether
  `RecordSource` supports `open()` today is unchecked.
* Poll first (every vendor lists "since X"); push later through the existing
  webhook hooks, with Meet's Pub/Sub pull as its own variant. Video is fetched on
  demand — transcripts and notes are the payload.

Suggested order: Teams (connector exists), Zoom (connector done), Meet (gated by
Google's restricted-scope review).
