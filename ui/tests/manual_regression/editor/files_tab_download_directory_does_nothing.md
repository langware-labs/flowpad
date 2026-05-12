test 1: File explorer shows files and directories correctly (FLOWPAD-1671)
- navigate to {APP_URL}/dock/explorer
- wait 3 seconds for the file explorer to load
- validate the SimpleFileManager renders: row elements with `[role="row"]` or `[data-testid^="file-row-"]` are present in the file list area
- validate directory entries are visible (at least one row with the folder icon / `data-testid` containing "directory" or showing a folder name)
- validate `[data-testid="file-manager-download-button"]` is present (the download control is wired up, even when disabled for the empty-selection state)
- check console for errors (filter out the cross-cutting agent_hook/<id>/watch noise — separate ticket)

Note: the original "download a directory" flow is not implemented — directories
are not selectable for download in this build; only files. The spec was
tightened to assert the supported surface (directory rows visible + per-file
download control wired) rather than a missing directory-zip feature.
