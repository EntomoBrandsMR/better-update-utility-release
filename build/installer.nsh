; ─────────────────────────────────────────────────────────────────────────────
; installer.nsh — 3.2.2 rewrite.
;
; The whole "park user data out and restore it after" dance is GONE. Through 3.2.1,
; user data (flows/schedules/logs/failures) lived INSIDE the install dir (next to the .exe),
; so every uninstall/update could wipe it and this script tried to rescue it — fragile, and it
; broke the moment the install location wasn't exactly where it expected (the 07-31 data loss).
;
; 3.2.2: user data lives at C:\BUU-Data, OUTSIDE the install dir (see main.js buuRoot). The
; uninstaller only ever removes $INSTDIR (C:\BUU), which no longer contains user data — so data
; survives every install/update/uninstall automatically, with no rescue logic. The installer's
; only data job is to CREATE C:\BUU-Data once (elevated) with user-writable ACLs so the
; non-elevated app can read/write it at runtime.
; ─────────────────────────────────────────────────────────────────────────────

; Kill any lingering BUU before install/uninstall so a stuck worker/coordinator can't hold
; files open or the single-instance lock. IMPORTANT: NO /T. The /T tree-kill is what broke
; the in-app updater — the updater's installer ran as a descendant of "BUU 2.0.exe", so a
; /T kill of the app tree also killed the installer. Killing by IMAGE NAME alone still clears
; the app AND its workers (they share the "BUU 2.0.exe" image), without reaching the updater.
!macro customInit
  nsExec::Exec 'taskkill /F /IM "BUU 2.0.exe"'
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM "BUU 2.0.exe"'
!macroend

; Force a fixed per-machine install root of C:\BUU. package.json sets perMachine:true, so the
; installer is elevated and CAN write C:\. Setting $INSTDIR here is what actually relocates the
; install — the pre-3.2.2 script only wrote the InstallLocation registry value and never set
; $INSTDIR, so installs silently landed in %LOCALAPPDATA%\Programs while the user launched a
; hand-moved C:\BUU copy (the install-location drift behind "update downloads but never
; applies"). A stable C:\BUU\BUU 2.0.exe path also keeps taskbar pins working across updates.
!macro preInit
  SetRegView 64
  StrCpy $INSTDIR "C:\BUU"
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\BUU"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\BUU"
  SetRegView 32
  StrCpy $INSTDIR "C:\BUU"
  WriteRegExpandStr HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\BUU"
  WriteRegExpandStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "C:\BUU"
!macroend

; Create the data root ONCE, elevated, and grant the local Users group (well-known SID
; S-1-5-32-545, locale-independent) Modify rights so the non-elevated app can read/write
; flows/schedules/logs there at runtime. Inheritance flags (OI)(CI) so future files inherit it.
; NEVER delete or overwrite C:\BUU-Data — user data lives here. If this grant somehow fails,
; the app detects C:\BUU-Data isn't writable and falls back to a per-user data dir, so data is
; still safe outside the install dir either way.
!macro customInstall
  CreateDirectory "C:\BUU-Data"
  nsExec::Exec 'icacls "C:\BUU-Data" /grant *S-1-5-32-545:(OI)(CI)M /T'
!macroend
