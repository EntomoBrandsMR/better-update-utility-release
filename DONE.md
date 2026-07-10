# BUU DONE — completed items by version

Newest first. Started 2026-07-04; versions before 2.2.9 are summarized in
`DESIGN-INDEX.md` and `docs/design/`.

## 2.2.9 — 2026-07-04

- **If-click step** (first slice of IF logic, C6/item 40): conditional click — polls for an
  element up to a configurable presence window (default 1s); present → click, absent →
  continue, no error. Branch taken (`clicked` / `not present`) recorded per row in the step
  trail and fieldsWritten. Plain-selector targeting only.
- **Repo made self-buildable**: `build/installer.nsh` (recreated minimal: taskkill lingering
  BUU processes on install/uninstall — partial mitigation for KB1) and the pool-worker +
  html-js validators force-added past the blanket gitignore rules. Chromium recoverable from
  any installed copy. First release ever shipped from a machine other than bigma.

## 2.2.8 and earlier

See `DESIGN-INDEX.md` (2.x history) and `docs/KNOWN-BUGS.md` FIXED section.
