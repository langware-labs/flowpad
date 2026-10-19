; Custom NSIS hooks for the Windows installer (electron-builder.json → nsis.include).

; main.js registers flowpad:// at launch (app.setAsDefaultProtocolClient), which
; writes HKCU\Software\Classes\flowpad. NSIS did not write that key, so the stock
; uninstaller leaves it behind. The browser then still treats flowpad:// as
; installed, and the invite page never switches to "Install Flowpad". Delete the key
; on a real uninstall. electron-updater runs the old uninstaller with --updated
; during an update, and that run must keep the key: the new version only registers
; it again once it launches.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\flowpad"
  ${endIf}
!macroend
