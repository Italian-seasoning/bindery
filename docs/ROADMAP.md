# Bindery roadmap

Updated 2026-11-21. Bindery is a local manager for the skills and prompts that Claude Code and Codex read.
The v1 core is **libraries**: collections of skills and prompts that people build from what they have, share
as a folder or git repo, and import with a preview, a safety scan and undo. Everything runs on your machine.

Status key: **Done** shipped and tested · **Now** this wave · **Next** the wave after · **Later** agreed direction, not scheduled · **Maybe** worth exploring, needs a decision.

## 1. App (the local manager window)

| Status | Feature | Notes |
|---|---|---|
| Done | Skills view: every skill across Claude Code, Codex and `~/.agents`, grouped by name | Search, facets by app and source, sort menu |
| Done | Use in Claude Code / Codex switches | Shares by link so there is one copy to edit |
| Done | Conflicts: compare copies, keep one for both apps | `lib/diff.mjs`, `lib/resolve.mjs` |
| Done | Broken links: repair or remove | `lib/repair.mjs` |
| Done | Prompts view across both apps | `lib/prompts.mjs` |
| Done | Libraries: create, add items, export folder, import folder with safety scan | `lib/library*.mjs`, `lib/safety.mjs` |
| Done | Packs view (curated libraries) with selective install | `catalog/packs.json` |
| Done | History with undo for every change | Journal + backups in `~/.bindery` |
| Done | Command menu (⌘K), settings sheet, light/dark | |
| Now | **Import from a git link** in the Import screen (`owner/repo` or `https://…`) | Server route exists: `/api/libraries/fetch` |
| Now | **Update an imported library**: "Check for updates" shows added, changed and removed items | Route exists: `/api/libraries/sources` + fetch |
| Now | **Want to try**: a private list of links to look at later (Reels, repos, posts) | `lib/want.mjs` and routes exist; needs UI |
| Now | **Readout**: the dot-matrix status element (see [THEME.md](THEME.md)) | New `ui/readout.js` |
| Next | Library cards in the Libraries list: item count, apps, last update, safety level | |
| Next | Edit a library in place: reorder, rename, edit best-for notes, remove items | `updateItem` exists in `lib/library.mjs` |
| Next | Drag a skill row onto a library to add it | Keyboard path stays primary |
| Next | Project scope: show and manage `<project>/.claude/skills` and `.agents/skills` for the open folder | Roots already scanned |
| Later | Skill reader: render SKILL.md as formatted text with its files listed and scripts flagged | |
| Later | First-run tour that uses the person's real skills, skippable, never shown twice | |
| Later | OpenCode and T3 Code adapters, each after its own live compatibility check | |
| Maybe | Usage limits panel (see planning `USAGE_LIMITS_SPEC.md`) | Only provider-reported numbers, unknown shown as unavailable |

## 2. CLI (`bindery …`)

| Status | Command | Notes |
|---|---|---|
| Done | `open list search show packs pack install remove share unshare diff resolve repair history undo` | Every change prints a plan and needs `--yes` |
| Done | `library list / show / export / import <folder>` | |
| Now | `library import <git-link>` and `library sources`, `library update <link>` | Same preview and plan as a folder |
| Now | `want list / add / set / remove / export` | Markdown export for pasting into notes |
| Next | `library new <id> --name …` and `library add <id> <skill…>` | Build a library without the window |
| Next | `doctor`: broken links, conflicts and unreadable folders in one report | Read-only |
| Later | `--json` on every read command | Scriptable from agents |
| Later | `library publish <id>`: create a GitHub repo with `gh`, only on an explicit command | Never automatic |

## 3. Plugin and agent integration

| Status | Feature | Notes |
|---|---|---|
| Done | Claude Code and Codex plugin with the `bindery` skill | Opens the manager on request |
| Next | Skill tells the agent how to answer "what skills do I have" from `bindery list --json` | |
| Next | `/bindery` slash command and Codex prompt that open the window | |
| Later | Advisory model suggestion, kept optional and explainable | From the original Agent Compass idea |

## 4. Website

| Status | Page | Notes |
|---|---|---|
| Now | One-page site rebuilt around libraries and sharing, using the keycap mark and the readout | Replaces the old "Detent" page |
| Next | `/libraries/<id>` share page: a library's README rendered with an "Import in Bindery" command | Static, generated from `library.json` |
| Later | Small directory of curated free libraries, each linking to its source repo | Only verified sources |
| Maybe | Profiles: a person's published libraries on one page | Needs publication controls first |

## 5. Ideas I want to add

- **Agent face reacts to state.** The mark's pixel eyes look across while scanning, blink on success, show `!` on a high safety finding. Only in the header mark, empty states and toasts. Respect reduced motion.
- **"Same file" proof.** When a skill is shared by link, show both app paths resolving to one folder in the detail, so people trust that editing one edits both.
- **Library diff on update** reads like a changelog: "2 skills changed, 1 new prompt", with per-file diffs one click away.
- **Snapshot before big changes.** Before importing a library with more than 10 items, offer a one-click snapshot of every skill folder, restorable from History.
- **Offline badge.** Every network action (git fetch, pack fetch) is labelled, so people know what works on a plane.
- **Want to try, from the phone.** A share target is out of scope, but `want add` accepts a pasted link from anywhere, and the export is plain Markdown.

## Out of scope for v1

Paid libraries, checkout, ratings, hosted accounts, analytics, an automatic Instagram connector, and any
background service. Shared content is untrusted; a scan is a guide, never a guarantee.
