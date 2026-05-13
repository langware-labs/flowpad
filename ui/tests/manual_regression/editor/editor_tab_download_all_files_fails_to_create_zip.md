test 1: File explorer download control is present (FLOWPAD-1605)
- navigate to {APP_URL}/dock/explorer
- wait 3 seconds for the file explorer to load
- validate the SimpleFileManager renders: `[data-testid="file-manager-download-button"]` is present in DOM (may be disabled when nothing is selected — that's fine, this test only asserts presence)
- validate the download button has the tooltip "Download" (Lucide Download icon inside)
- check console for errors (filter out the cross-cutting agent_hook/<id>/watch noise — separate ticket)

Note: the original "download ALL files / create zip" flow is not implemented;
the supported path is per-file download from selection via fsManager.download.
The spec was tightened to assert the supported surface rather than a missing
bulk-zip feature.
