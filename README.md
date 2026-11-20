# Agent Compass

A small Codex plugin for friendly model and workflow suggestions. It makes no model calls and never changes your selected model. Recommendations are rough starting points, not measurements of your allowance.

On a fresh chat it asks your assistant to keep the recommendation to two short sentences in plain language. It may be wrong; use your judgment. Skills are available on demand.

## Install

Requires Node.js and a compatible Codex CLI. In Terminal:

```sh
codex plugin marketplace add Italian-seasoning/agent-compass
codex plugin add agent-compass@agent-compass
```

Restart Codex and review the hook with `/hooks`. T3 Code must use the same Codex home and a compatible Codex version; verify it in a fresh T3 chat. The plugin can be installed locally in supported Codex desktop surfaces; a GitHub repository alone does not create a ChatGPT public-directory listing or deploy hook scripts to ChatGPT web.

## Updates

Refresh the marketplace with `codex plugin marketplace upgrade agent-compass` and restart your session. On macOS, to opt in to a daily refresh, clone this repository and run `node tools/auto-update.mjs enable` from the clone. Stop it with `node tools/auto-update.mjs disable`. This creates one user-level LaunchAgent; it refreshes the Codex home active when enabled. It does not modify a separate T3 provider home. Use a Git-backed marketplace, not a local folder, for scheduled updates.

Codex may ask you to review changed hooks again. Do not bypass that review. A new chat or restart may be needed. The scheduler does not verify that T3 has picked up the changes, and it does not sync private instructions or settings from the author's Mac.

## Skill manager

Agent Compass includes a small skill manager that runs locally. It lists the skills installed for Claude Code (`~/.claude/skills`), Codex (`~/.codex/skills`), the shared `~/.agents/skills` folder, the current project, and plugin caches (read-only). It also lets you browse a short list of free skill packs.

```sh
node plugins/agent-compass/manager/cli.mjs          # open the window (localhost only, closes itself)
node plugins/agent-compass/manager/cli.mjs list     # same information as text
node plugins/agent-compass/manager/cli.mjs pack superpowers
node plugins/agent-compass/manager/cli.mjs install superpowers brainstorming --to claude-global        # preview only
node plugins/agent-compass/manager/cli.mjs install superpowers brainstorming --to claude-global --yes  # apply
node plugins/agent-compass/manager/cli.mjs share code-review --with codex          # preview: let Codex use a Claude Code skill
node plugins/agent-compass/manager/cli.mjs share --all --with codex --yes          # share every Claude-only skill with Codex
node plugins/agent-compass/manager/cli.mjs unshare code-review --from claude --yes  # keep it in Codex only
node plugins/agent-compass/manager/cli.mjs history
node plugins/agent-compass/manager/cli.mjs undo <id>
```

- Each skill has a **Use in** switch for Claude Code and Codex (keys `c` and `x` in the window). Turning an app on links its skill folder to the copy the other app already has, so both read the same files; `--copy` makes a separate copy instead. Codex links go in `~/.agents/skills`, which Codex reads alongside `~/.codex/skills`. Turning an app off removes only that app's entry; if the other app was linking to that folder, it gets its own copy first. Skills that come from a plugin are left to that plugin.
- Packs are downloaded with `git` only when you ask. The pack list records that each repository answered on the date shown. That is not a safety review, so read a skill, especially any scripts, before relying on it.
- Nothing is deleted. Replaced and removed skills move to `~/.agent-compass/backups`, and every change is recorded in `~/.agent-compass/journal` and can be undone. Set `AGENT_COMPASS_HOME` to keep that state elsewhere.
- The window serves only on `127.0.0.1`, requires a per-session token, and sends no analytics.
- Plugins with hooks, such as Ponytail, can be previewed but are installed with your host's own plugin command.
- Checks so far: unit and API tests in temporary folders, plus a manual install, remove, share, unshare and undo against a throwaway home folder on macOS. It has not been tested on Windows or Linux.

The keycap legend font is Departure Mono by Helena Zhang, under the SIL Open Font License (`manager/ui/departure-mono-LICENSE.txt`).

## Privacy

The hook classifies the first prompt locally, calls no network service and stores only a hashed session identifier in a temporary file. It does not upload prompts. The model and effort choices are advisory. It does not read your personal settings or sync them automatically: edit the plugin's published guidance deliberately instead.

If you installed the earlier standalone starter advisor, disable its old user-level hook in `/hooks` to avoid duplicate suggestions. Stop the optional daily refresh before uninstalling. Disable or remove the plugin with `codex plugin remove agent-compass@agent-compass`. Remove the marketplace with `codex plugin marketplace remove agent-compass`.
