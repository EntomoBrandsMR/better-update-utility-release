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
