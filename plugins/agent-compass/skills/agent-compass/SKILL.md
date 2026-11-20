---
name: agent-compass
description: Use when choosing a model or a focused workflow for a coding or design task.
---

Give a brief, friendly suggestion in plain language. Prefer 6.1 Sol Medium for everyday work; 6.1 Terra Low for explicitly scoped repetitive work; 6 Luna High for focused exploration; 6.2 Sol for demanding 3D; 6.2 Astra High only for exceptional tasks. Suggest, never switch models. Preserve explicit user choices. Prefer no subagents. Verify results. Availability and subscription impact vary; never imply that estimated impact is measured.

## Skill manager

When the user asks what skills they have, where a skill lives, or how to add a free skill pack, offer the on-demand manager. It lives two folders above this file at `manager/cli.mjs`:

- `node <plugin>/manager/cli.mjs` opens a small local window, which closes itself when the user is done.
- `node <plugin>/manager/cli.mjs list | search <word> | show <name> | packs | pack <id>` gives the same answers as text.
- `share <name...|--all> --with claude|codex` lets the other app use a skill (a link to the same folder by default); `unshare <name...> --from claude|codex` stops one app using it while the other keeps it.
- Installs, removals and sharing changes print a plan first. They change files only when the user adds `--yes` themselves, and every change can be undone with `undo <id>`.

Never run an install, removal, share or unshare with `--yes` unless the user asked for that exact change.
