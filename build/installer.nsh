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
; 3.0.5 DATA SAFETY (Matthew, decided 2026-07-17: "uninstaller does not delete those
; things"): user data — flows\ logs\ failures\ schedules\ — is NEVER deleted, on ANY
; uninstall path: in-app update, MANUALLY-run installer, or a real uninstall.
; WHY: on 07-17 a manually-run installer skipped the old ${isUpdated}-gated park and
; the uninstaller wiped C:\BUU — flows, schedules and a day of logs were lost, then a
; STALE park in $TEMP silently restored 7/10-era flows over the fresh install.
; HOW: park UNCONDITIONALLY to C:\BUU-preserved (same-volume Rename = instant; NOT
; $TEMP, which cleaners purge). Any stale park is shoved to *-prev FIRST so the park
; can never silently fail on rename-target-exists (the second half of the 07-17 loss).
; customInstall restores; after a real uninstall the data simply waits in
; C:\BUU-preserved until the next install (or the user deletes it deliberately).
!macro customUnInstall
  CreateDirectory "C:\BUU-preserved"
  IfFileExists "C:\BUU-preserved\flows" 0 +2
    Rename "C:\BUU-preserved\flows" "C:\BUU-preserved\flows-prev"
  Rename "$INSTDIR\flows" "C:\BUU-preserved\flows"
  IfFileExists "C:\BUU-preserved\logs" 0 +2
    Rename "C:\BUU-preserved\logs" "C:\BUU-preserved\logs-prev"
  Rename "$INSTDIR\logs" "C:\BUU-preserved\logs"
  IfFileExists "C:\BUU-preserved\failures" 0 +2
    Rename "C:\BUU-preserved\failures" "C:\BUU-preserved\failures-prev"
  Rename "$INSTDIR\failures" "C:\BUU-preserved\failures"
  IfFileExists "C:\BUU-preserved\schedules" 0 +2
    Rename "C:\BUU-preserved\schedules" "C:\BUU-preserved\schedules-prev"
  Rename "$INSTDIR\schedules" "C:\BUU-preserved\schedules"
!macroend

!macro customInstall
  ; LEGACY restore first: the 3.0.4 uninstaller (which runs during the update TO
  ; 3.0.5) still parks flows/logs/failures in $TEMP\buu-preserve. Plain-directory
  ; IfFileExists (no \*.*) — the old wildcard check missed folders that contain only
  ; SUBFOLDERS, which is how a park got stranded in $TEMP in the first place.
  IfFileExists "$TEMP\buu-preserve\flows" 0 +2
    Rename "$TEMP\buu-preserve\flows" "$INSTDIR\flows"
  IfFileExists "$TEMP\buu-preserve\logs" 0 +2
    Rename "$TEMP\buu-preserve\logs" "$INSTDIR\logs"
  IfFileExists "$TEMP\buu-preserve\failures" 0 +2
    Rename "$TEMP\buu-preserve\failures" "$INSTDIR\failures"
  RMDir "$TEMP\buu-preserve"
  ; 3.0.5 restore from the unconditional park. If a folder already landed from the
  ; legacy path the Rename is a no-op-on-fail and the parked copy stays in
  ; C:\BUU-preserved for the *-prev shove next cycle — data is never overwritten,
  ; never deleted.
  IfFileExists "C:\BUU-preserved\flows" 0 +2
    Rename "C:\BUU-preserved\flows" "$INSTDIR\flows"
  IfFileExists "C:\BUU-preserved\logs" 0 +2
    Rename "C:\BUU-preserved\logs" "$INSTDIR\logs"
  IfFileExists "C:\BUU-preserved\failures" 0 +2
    Rename "C:\BUU-preserved\failures" "$INSTDIR\failures"
  IfFileExists "C:\BUU-preserved\schedules" 0 +2
    Rename "C:\BUU-preserved\schedules" "$INSTDIR\schedules"
  RMDir "C:\BUU-preserved"
!macroend
