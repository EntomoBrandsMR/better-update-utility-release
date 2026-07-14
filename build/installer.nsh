; Recreated 2026-07-04 on the work machine — the original installer.nsh lived only on the
; bigma box (swept up by the blanket build/ gitignore) and its contents are unknown. This
; replacement is intentionally minimal: kill any lingering BUU processes before install and
; uninstall so a stuck worker/coordinator can't hold files open or the single-instance lock
; (documented bug: lingering processes block ready-to-show and the update prompt).
; Now tracked in git (!build/installer.nsh) so every machine can build.

!macro customInit
  nsExec::Exec 'taskkill /F /IM "BUU 2.0.exe" /T'
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM "BUU 2.0.exe" /T'
!macroend

; R8: fixed install root C:\BUU. A stable path means taskbar pins survive updates
; (the old per-user versioned paths broke pins) and everything BUU lives in one place:
; app files + flows\ + logs\ + failures\.
!macro preInit
  SetRegView 64
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\BUU"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\BUU"
  SetRegView 32
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\BUU"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\BUU"
!macroend

; R8: preserve user data through UPDATES. electron-builder runs the OLD uninstaller
; first, which removes $INSTDIR recursively — park flows\/logs\/failures\ in %TEMP%
; on the way down (updates only; a real uninstall leaves nothing parked), then
; customInstall restores them after the new files land. Rename is same-volume (C:)
; so this is instant regardless of size.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Goto buu_preserve_done
  ${endIf}
  CreateDirectory "$TEMP\buu-preserve"
  Rename "$INSTDIR\flows" "$TEMP\buu-preserve\flows"
  Rename "$INSTDIR\logs" "$TEMP\buu-preserve\logs"
  Rename "$INSTDIR\failures" "$TEMP\buu-preserve\failures"
  buu_preserve_done:
!macroend

!macro customInstall
  IfFileExists "$TEMP\buu-preserve\flows\*.*" 0 +2
    Rename "$TEMP\buu-preserve\flows" "$INSTDIR\flows"
  IfFileExists "$TEMP\buu-preserve\logs\*.*" 0 +2
    Rename "$TEMP\buu-preserve\logs" "$INSTDIR\logs"
  IfFileExists "$TEMP\buu-preserve\failures\*.*" 0 +2
    Rename "$TEMP\buu-preserve\failures" "$INSTDIR\failures"
  RMDir "$TEMP\buu-preserve"
!macroend
