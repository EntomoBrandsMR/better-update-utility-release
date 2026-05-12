# v1.2.9 - Hotfix: once-flow dropdown showed every flow as ''buu-flow''

Single-issue hotfix. Setup and teardown dropdowns in v1.2.8 showed every saved once-flow as the literal string uu-flow, regardless of what you named the file at save time. Caused by a fallback chain in saveFlow that bottomed out at 
ame: ''buu-flow'' when no flow name was set in memory (and the UI has no field to enter one).

Fixed by treating the filename stem as the source of truth. The save handler rewrites the JSON''s name field to match the filename at write time, so old files self-heal on next save. The three server-side lookup paths (list-once-flows, esolveOnceFlowByName, alidate-flow-references) now read the filename stem directly and ignore the data.name field.

For users with existing v1.2.8 flows that show as ''buu-flow'' in the dropdown: after installing v1.2.9, just relaunch BUU. The dropdown will show your flows by their filename without any further action. (Saving any of those flows once will also rewrite the name field on disk.)

No other changes. Same v1.2.8 functionality otherwise.
