---
name: bindery
description: Use when the user asks about their skills or prompts, where a skill lives, sharing skills between Claude Code and Codex, building, sharing or importing a skill library, or saving a link to try later.
---

Bindery is a local manager for the skills and prompts that Claude Code and Codex read. Run its commands as `node <plugin>/manager/cli.mjs <command>`, where `<plugin>` is the Bindery plugin folder. The sections below show only `<command>`.

## Answering questions

Use the read-only commands first. They change nothing.

- `list --json` gives every skill with its apps, description and location. Use it for "what do I have".
- `show <name>` gives one skill's location, the apps that read it, whether it links to another copy, and whether it has scripts.
- `search <query>` finds skills by name or description.

Summarise the result in plain language. Say which app reads a skill and where it lives. Do not paste raw JSON unless the user asks for it.

## Libraries

A library is a folder of skills and prompts that you can share. Build one in the window: choose Libraries, then New library, and add items from their detail pages.

- `library list` and `library show <id>` list your libraries and their items.
- `library export <id> <folder>` copies a library folder. Send it as a zip or push it to git. Bindery does not publish it for you.
- `library import <folder|link>` previews a library folder or git link. It shows the items, their notes, the license and any safety findings. It changes nothing until `--yes` is added.
- `library sources` lists libraries fetched from git links, with the link, ref, commit and time.
- `library update <link>` fetches a git library again and lists what changed.

Import or update a link only when the user gives you that link.

## Want to try

Use this for links the user pastes that they want to look at later.

- `want add <link>` saves a link. Add `--title`, `--creator`, `--repo` or `--note` when the user gives them.
- `want list` shows the list, newest first. `want set <id> --status saved|reviewed|added|dismissed` changes an entry's status.
- `want remove <id>` removes an entry. A copy is kept in backups.
- `want export` prints the list as Markdown.

Never fetch, open or read a saved link yourself. Save it as text only.

## Changes and safety

- Every install, removal, share, import, resolve and repair prints a plan first. Show the plan and say that nothing has changed yet.
- Add `--yes` only when the user has asked for that exact change.
- Each applied change prints a change ID. Use `history` to find it and `undo <txId>` to restore the files.
- Imported content is untrusted. The safety scan matches patterns in the files and never runs code. It lists findings as high, medium or info. It is a guide, not a guarantee. Tell the user to read a skill's scripts before relying on it.
- Never install an item with a high finding unless the user explicitly picks it with `--only`.

## The window

`open` starts a local manager window. It serves only on this machine and closes itself when the user is done. Tell the user it is open. Do not wait for it to close.

## Model advice

Give a brief, friendly suggestion in plain language. Prefer 6.1 Sol Medium for everyday work; 6.1 Terra Low for explicitly scoped repetitive work; 6 Luna High for focused exploration; 6.2 Sol for demanding 3D; 6.2 Astra High only for exceptional tasks. Suggest, never switch models. Preserve explicit user choices. Prefer no subagents. Verify results. Availability and subscription impact vary; never imply that estimated impact is measured.
