# Word Table Sync

An Obsidian plugin for managing a Markdown vocabulary table with spaced review scheduling.

## Features

- Automatically detects a Markdown vocabulary table.
- Works with existing short binary codes such as `1`, `11`, `111`, `1111`, `11111`, and `111110`.
- Uses the 7th bit as `v`: when the 7th bit is `1`, the row is considered mastered and is archived. For example, `1111101` is valid and means Day 30 is not checked but `v=1`.
- Moves mastered rows to a separate archive table.
- Reactivates archived rows when `v` is changed from `1` back to `0`.
- Generates `单词查看.md` as plain text plus `![[英语陌生单词表]]` (or the configured source-file embed).
- Calculates review dates automatically.
- Allows early/late completion windows, defaulting to `Day 7 ±1`, `Day 14 ±1`, and `Day 30 ±2`.
- Keeps the planned schedule anchored to the original target date, preventing drift caused by the grace window.
- Provides an Obsidian review view with overdue/today counts and one-click completion.
- Stores review state in a JSON file so dates are not added to the vocabulary table itself.
- Runs on desktop and mobile (`isDesktopOnly: false`).

## Default schedule

Review targets are Day 1, 2, 3, 7, 14, and 30. The default gaps are `1,1,4,7,16` days after stages 1-5.

Default grace windows are `0,0,0,1,1,2` days for Day 1, 2, 3, 7, 14, and 30.

## Installation from a release

Copy `manifest.json`, `main.js`, and `styles.css` into:

`.obsidian/plugins/word-table-sync/`

Then enable **Word Table Sync** under **Settings → Community plugins → Installed plugins**.
