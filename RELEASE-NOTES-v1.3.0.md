# v1.3.0 - Find by text, step-mode setup/teardown, UI polish

A polish + bug-fix release. Eleven changes, no architectural shift.

## New

**Find by text.** When a PestPac page has several look-alike items - multiple open service
orders, several batches, rows that all share the same selector - you can now point a step at
the specific one that matches your data. Turn on "Find by text" on a Click, Type, Select,
Checkbox, Clear, or Verify step. You give it: a container selector (the repeating thing, e.g.
a table row), the match text (a value or a token like the order number from your spreadsheet),
and a match mode (contains, exact, starts/ends with, case-insensitive variants, or regex). BUU
finds the container whose visible text matches, then runs your step on the element inside it.
If zero or more than one container matches, the row fails with a clear message - BUU never
guesses which look-alike is the right one.

**Setup and teardown step through too.** Previously "Step through each step" only paused on
main-flow steps; setup and teardown ran at full speed. Now they pause the same way, so you can
verify a setup or teardown flow step by step while building it. The pause panel labels them
"Setup - step X" / "Teardown - step X".

**Open last log from the toolbar.** When BUU is idle and you've run something, the toolbar Run
button turns into "Open last log" so you can reopen the most recent Excel log in one click.

**Token typo check.** Malformed tokens like `{{Name}` (missing a brace) or `{{}}` (empty) are
now flagged on the step card and in the pre-run check, before they silently end up as literal
text in PestPac.

**Bigger UI text** throughout the builder.

## Fixes

- Text inside step fields is now selectable and copyable - dragging only starts from the
  drag handle, not the whole card.
- The verification panel no longer flickers closed and reopens between steps in step mode.
- Stop-then-start-again is hardened: a 5-second safety timer guarantees the UI never gets
  stuck on "Stopping...", stop/start transitions are logged for diagnosis, and the stop
  routine is now safe to run more than once.
- Removed the Pause button. It was wired to functions that were never connected, so it did
  nothing. Stop already halts safely at a row boundary.

## Installer

This build switches to a per-machine install (installs to Program Files, prompts for admin).
This is an experiment to make the taskbar pin survive auto-updates. If it causes any install
trouble it can be reverted in one line.
