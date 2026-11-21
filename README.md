# Bindery - ALPHA Build

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

## Privacy

The hook classifies the first prompt locally, calls no network service and stores only a hashed session identifier in a temporary file. It does not upload prompts. The model and effort choices are advisory. It does not read your personal settings or sync them automatically: edit the plugin's published guidance deliberately instead.

If you installed the earlier standalone starter advisor, disable its old user-level hook in `/hooks` to avoid duplicate suggestions. Stop the optional daily refresh before uninstalling. Disable or remove the plugin with `codex plugin remove agent-compass@agent-compass`. Remove the marketplace with `codex plugin marketplace remove agent-compass`.
