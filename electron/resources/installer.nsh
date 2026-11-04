; Custom NSIS hooks for the Windows installer (electron-builder.json → nsis.include).
;
; Uninstall (FLOWPAD-2250): the uninstaller removes only what FlowPad Desktop provably owns and
; nothing else uses. The decisions and the deleting are flow-rs's (`flow-rs uninstall`, see
; flow_sdk/rust/src/uninstall/); this file is the UI around it:
;   * a page that shows what will happen to the engine and offers, unchecked, to delete data —
;     exactly the folders flow-rs reported, with a confirmation that defaults to No;
;   * the run, and a finish page that says what really happened (complete / restart required /
;     items left in place), never an unconditional success.
; Nothing here runs during an update (`--updated`, which electron-builder passes to the old
; uninstaller on EVERY install over an existing copy, including a manual reinstall), and the
; switches /REMOVEENGINE, /DELETEAPPDATA, /DELETEDATA are the only way a silent uninstall
; removes anything that is only offered.

!include LogicLib.nsh

; Defining customCheckAppRunning makes electron-builder skip these; its own check, which the
; installer pass (and a broken installation) still uses, needs them.
!include "getProcessInfo.nsh"
Var pid

!define FLOWPAD_RS "$INSTDIR\resources\flow-rs\flow-rs.exe"

!ifdef BUILD_UNINSTALLER
!include nsDialogs.nsh

Var FlowpadUpdating
Var FlowpadRemoveEngine
Var FlowpadDeleteAppData
Var FlowpadDeleteData
Var FlowpadIni
Var FlowpadEngineBox
Var FlowpadAppDataBox
Var FlowpadDataBox
Var FlowpadFinishTitle
Var FlowpadFinishText
!endif

!macro customUnInit
  ; ${isUpdated} is not defined where this file's functions are compiled; remember it here.
  StrCpy $FlowpadUpdating 0
  ${If} ${isUpdated}
    StrCpy $FlowpadUpdating 1
  ${EndIf}
  StrCpy $FlowpadRemoveEngine 0
  StrCpy $FlowpadDeleteAppData 0
  StrCpy $FlowpadDeleteData 0
  StrCpy $FlowpadFinishTitle "FlowPad was uninstalled"
  StrCpy $FlowpadFinishText ""
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/REMOVEENGINE" $R1
  ${IfNot} ${Errors}
    StrCpy $FlowpadRemoveEngine 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/DELETEAPPDATA" $R1
  ${IfNot} ${Errors}
    StrCpy $FlowpadDeleteAppData 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/DELETEDATA" $R1
  ${IfNot} ${Errors}
    StrCpy $FlowpadDeleteAppData 1
    StrCpy $FlowpadDeleteData 1
  ${EndIf}
  ClearErrors
!macroend

; Is the app running? electron-builder's own check runs `powershell -C "Get-CimInstance
; Win32_Process …"` with no time limit; on the Windows test VM it hung at 100% CPU and could not
; be killed (Phase 0, P8). The uninstaller asks flow-rs instead: exact `$INSTDIR\Flowpad.exe`,
; Toolhelp, bounded by its own deadline. The installer pass keeps electron-builder's check (the
; flow-rs it could call is the previous version's).
!macro customCheckAppRunning
  !ifdef BUILD_UNINSTALLER
    ${If} ${FileExists} "${FLOWPAD_RS}"
      nsExec::ExecToStack '"${FLOWPAD_RS}" app-running --install-dir "$INSTDIR" --deadline-secs 20'
      Pop $R0
      Pop $R1
      ${If} $R0 == 1
        MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK flowpad_app_close
        Quit
        flowpad_app_close:
        DetailPrint "$(appClosing)"
        nsExec::ExecToStack '"${FLOWPAD_RS}" app-running --install-dir "$INSTDIR" --stop --deadline-secs 30'
        Pop $R0
        Pop $R1
        ${If} $R0 != 0
          MessageBox MB_OK|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDOK
          Quit
        ${EndIf}
      ${EndIf}
    ${Else}
      !insertmacro IS_POWERSHELL_AVAILABLE
      !insertmacro _CHECK_APP_RUNNING
    ${EndIf}
  !else
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
  !endif
!macroend

!macro customUnWelcomePage
  ; Read by the finish page electron-builder inserts after the uninstall section.
  !define MUI_FINISHPAGE_TITLE "$FlowpadFinishTitle"
  !define MUI_FINISHPAGE_TEXT "$FlowpadFinishText"
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.flowpadOptionsCreate un.flowpadOptionsLeave
  ; Defined here, not at the top of this file: electron-builder includes MUI2 after this file,
  ; and this macro is expanded where MUI is already loaded (uninstaller pass only).
  !insertmacro flowpadOptionsPage
!macroend

!macro flowpadOptionsPage
Function un.flowpadOptionsCreate
  ${If} $FlowpadUpdating == 1
  ${OrIf} ${Silent}
    Abort
  ${EndIf}
  StrCpy $FlowpadEngineBox ""
  StrCpy $FlowpadAppDataBox ""
  StrCpy $FlowpadDataBox ""
  InitPluginsDir
  StrCpy $FlowpadIni "$PLUGINSDIR\flowpad-page.ini"
  Delete $FlowpadIni
  ${If} ${FileExists} "${FLOWPAD_RS}"
    nsExec::ExecToStack '"${FLOWPAD_RS}" uninstall --install-dir "$INSTDIR" --classify-only --ini "$FlowpadIni" --deadline-secs 60'
    Pop $0
    Pop $1
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Choose what to remove" "FlowPad keeps your data unless you choose otherwise."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${IfNot} ${FileExists} $FlowpadIni
    ${NSD_CreateLabel} 0 0 100% 40u "FlowPad could not check its other components, so it will keep them: the engine, its runtime and your data stay. Only the app is removed."
    Pop $0
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${WM_SETTEXT} 0 "STR:&Uninstall"
    nsDialogs::Show
    Return
  ${EndIf}

  ReadINIStr $1 $FlowpadIni engine remove
  ReadINIStr $2 $FlowpadIni engine offer
  ReadINIStr $3 $FlowpadIni engine reason
  ${If} $1 == 1
    ${NSD_CreateLabel} 0 0 100% 20u "The FlowPad engine will be removed."
    Pop $0
  ${ElseIf} $2 == 1
    ${NSD_CreateCheckbox} 0 0 100% 12u "Also remove the FlowPad engine. The flow command line will stop working."
    Pop $FlowpadEngineBox
    ${NSD_CreateLabel} 12u 13u -12u 14u "$3"
    Pop $0
  ${Else}
    ${NSD_CreateLabel} 0 0 100% 26u "The FlowPad engine will be kept: $3"
    Pop $0
  ${EndIf}

  ReadINIStr $4 $FlowpadIni appdata text
  ${NSD_CreateCheckbox} 0 32u 100% 12u "Delete FlowPad Desktop settings, cache and desktop logs"
  Pop $FlowpadAppDataBox
  ${NSD_CreateLabel} 12u 45u -12u 20u "$4"
  Pop $0

  ReadINIStr $5 $FlowpadIni instances offer
  ReadINIStr $6 $FlowpadIni instances warn
  ReadINIStr $7 $FlowpadIni instances text
  ReadINIStr $8 $FlowpadIni instances kept
  ${If} $5 == 1
    ${NSD_CreateCheckbox} 0 70u 100% 12u "Delete my FlowPad data: database, records, logs and stored credentials"
    Pop $FlowpadDataBox
    ${If} $6 == 1
      ${NSD_CreateLabel} 12u 83u -12u 28u "$7$\r$\nThis cannot be undone. This data may also be used by the flow command line."
    ${Else}
      ${NSD_CreateLabel} 12u 83u -12u 28u "$7$\r$\nThis cannot be undone."
    ${EndIf}
    Pop $0
  ${EndIf}
  ${If} $8 != ""
    ${NSD_CreateLabel} 0 114u 100% 24u "Kept: $8"
    Pop $0
  ${EndIf}
  ; The next step removes FlowPad: say so on the button.
  GetDlgItem $0 $HWNDPARENT 1
  SendMessage $0 ${WM_SETTEXT} 0 "STR:&Uninstall"
  nsDialogs::Show
FunctionEnd

Function un.flowpadOptionsLeave
  ; Each box decides its choice from scratch: this runs again after "No" keeps the page open,
  ; and a box unticked since must not keep an earlier tick.
  ${If} $FlowpadEngineBox != ""
    StrCpy $FlowpadRemoveEngine 0
    ${NSD_GetState} $FlowpadEngineBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $FlowpadRemoveEngine 1
    ${EndIf}
  ${EndIf}
  ${If} $FlowpadAppDataBox != ""
    StrCpy $FlowpadDeleteAppData 0
    ${NSD_GetState} $FlowpadAppDataBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $FlowpadDeleteAppData 1
    ${EndIf}
  ${EndIf}
  ${If} $FlowpadDataBox != ""
    StrCpy $FlowpadDeleteData 0
    ${NSD_GetState} $FlowpadDataBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $FlowpadDeleteData 1
    ${EndIf}
  ${EndIf}
  ${If} $FlowpadDeleteAppData == 1
  ${OrIf} $FlowpadDeleteData == 1
    StrCpy $1 ""
    ${If} $FlowpadDeleteAppData == 1
      ReadINIStr $2 $FlowpadIni appdata text
      StrCpy $1 "$1$\r$\n- FlowPad Desktop settings and cache: $2"
    ${EndIf}
    ${If} $FlowpadDeleteData == 1
      ReadINIStr $2 $FlowpadIni instances text
      StrCpy $1 "$1$\r$\n- Your FlowPad data: $2"
    ${EndIf}
    MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "This permanently deletes:$\r$\n$1$\r$\n$\r$\nDelete it?" IDYES flowpad_confirmed
    ; No: nothing is deleted. The boxes are cleared and the page stays open, so the user can
    ; choose again or cancel; Uninstall from here removes no data unless a box is ticked again.
    StrCpy $FlowpadDeleteAppData 0
    StrCpy $FlowpadDeleteData 0
    ${NSD_Uncheck} $FlowpadAppDataBox
    ${If} $FlowpadDataBox != ""
      ${NSD_Uncheck} $FlowpadDataBox
    ${EndIf}
    Abort
    flowpad_confirmed:
  ${EndIf}
FunctionEnd
!macroend


!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${If} ${FileExists} "${FLOWPAD_RS}"
      InitPluginsDir
      StrCpy $0 '"${FLOWPAD_RS}" uninstall --install-dir "$INSTDIR" --log "$TEMP\flowpad-uninstall.log" --result "$PLUGINSDIR\flowpad-result.json"'
      ${If} $FlowpadRemoveEngine == 1
        StrCpy $0 "$0 --remove-engine"
      ${EndIf}
      ${If} $FlowpadDeleteAppData == 1
        StrCpy $0 "$0 --delete-app-data"
      ${EndIf}
      ${If} $FlowpadDeleteData == 1
        StrCpy $0 "$0 --delete-instance-data"
      ${EndIf}
      DetailPrint "Removing FlowPad components"
      nsExec::ExecToLog $0
      Pop $1
      ; The first line of flow-rs's summary is plain ASCII; the full report is in the log.
      StrCpy $2 ""
      ClearErrors
      FileOpen $3 "$PLUGINSDIR\flowpad-result.txt" r
      ${IfNot} ${Errors}
        FileRead $3 $2
        FileClose $3
      ${EndIf}
      ${If} $1 == 0
        StrCpy $FlowpadFinishTitle "FlowPad was uninstalled"
      ${ElseIf} $1 == 10
        StrCpy $FlowpadFinishTitle "Sign out or restart to finish"
      ${Else}
        StrCpy $FlowpadFinishTitle "FlowPad was uninstalled, with items left in place"
      ${EndIf}
      ${If} $2 == ""
        StrCpy $2 "FlowPad could not report what it removed."
      ${EndIf}
      StrCpy $FlowpadFinishText "$2$\r$\n$\r$\nThe full report: $TEMP\flowpad-uninstall.log"
    ${Else}
      StrCpy $FlowpadFinishTitle "FlowPad was uninstalled, with items left in place"
      StrCpy $FlowpadFinishText "The app was removed. Its engine, runtime and your data were kept, because the uninstall helper is missing from this installation."
    ${EndIf}
    ; main.js registers flowpad:// at launch (app.setAsDefaultProtocolClient), which writes
    ; HKCU\Software\Classes\flowpad. NSIS did not write that key, so the stock uninstaller leaves
    ; it behind and browsers keep treating flowpad:// as installed. An update keeps it: the new
    ; version only registers it again once it launches.
    DeleteRegKey HKCU "Software\Classes\flowpad"
  ${endIf}
!macroend

; A previous uninstall may have left items in use, scheduled for the next sign-in. A new install
; finishes that cleanup before the app first runs (flow-rs re-proves every item first).
!macro customInstall
  ${If} ${FileExists} "$LOCALAPPDATA\Flowpad\fc\state.json"
    nsExec::ExecToLog '"$INSTDIR\resources\flow-rs\flow-rs.exe" deferred-cleanup --trigger installer --deadline-secs 120'
    Pop $0
  ${EndIf}
!macroend
