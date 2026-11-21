# Bindery - ALPHA Build

Bindery builds, shares and installs libraries of skills and prompts for Claude Code and Codex, and gives light advice on which model and workflow to start with.

It runs on your machine. It makes no model calls and never changes your selected model. Its recommendations are rough starting points, not measurements of your usage allowance.

## Install

Bindery needs Node.js. For Codex, run these in Terminal:

```sh
codex plugin marketplace add Italian-seasoning/bindery
codex plugin add bindery@bindery
```

Restart Codex and review the hook with `/hooks`. T3 Code must use the same Codex home and a compatible Codex version; verify it in a fresh T3 chat. The plugin can be installed locally in supported Codex desktop surfaces. A GitHub repository alone does not create a ChatGPT public-directory listing or deploy hook scripts to ChatGPT web.

The manager (the window and the command line) does not need the plugin. Clone this repository and run it from the clone:

```sh
git clone https://github.com/Italian-seasoning/bindery
cd bindery
node plugins/bindery/manager/cli.mjs
```

## Libraries

A library is a folder that holds a set of skills and prompts you want to reuse or share:

- `library.json` names the library and lists its items. Each item has a type, a name, a "best for" note, and the apps it goes to (Claude Code, Codex, or both).
- `skills/<name>/` holds a copy of each skill folder.
- `prompts/<name>.md` holds each prompt as one file.
- `README.md` is generated and explains the library to whoever receives it.

Libraries are self-contained. A zip or a git repository of the folder is the whole library.

### Create one

Open the window and choose Libraries, then New library. Add skills and prompts from their detail pages with Add to library, and edit each item's "best for" note. Copies are stored in `~/.bindery/libraries`.

### Export and share

Export from the window with Export folder, or from the command line:

```sh
node plugins/bindery/manager/cli.mjs library list
node plugins/bindery/manager/cli.mjs library show ui-kit
node plugins/bindery/manager/cli.mjs library export ui-kit ~/Downloads/ui-kit
```

Send the folder as a zip, or push it to a git repository. Bindery does not publish anything for you.

### Import

Import takes a folder or a git link (`owner/repo` or an `https://` address). Links are fetched with a shallow `git clone` into `~/.bindery/cache/libraries`. Only `https` links are accepted.

Import always shows a preview first: the items, their "best for" notes, the license, and any safety findings. Nothing changes until you add `--yes`. Items with a high safety finding are skipped unless you name them.

```sh
node plugins/bindery/manager/cli.mjs library import ~/Downloads/ui-kit
node plugins/bindery/manager/cli.mjs library import owner/ui-kit
node plugins/bindery/manager/cli.mjs library import owner/ui-kit --only impeccable --yes
```

The window's Import page works the same way: paste a folder path or a link, review the preview, then install. Each applied import prints a change ID you can use with `undo`.

### Update

A library imported from a link can be fetched again. Bindery lists what was added, changed and removed since the last fetch, and installs nothing until you import again.

```sh
node plugins/bindery/manager/cli.mjs library sources
node plugins/bindery/manager/cli.mjs library update owner/ui-kit
```

## Want to try

A private list of links you want to look at later: a Reel, a repo, a post. It is stored only in `~/.bindery/want.json`. Bindery never opens or fetches a saved link. Removed entries are kept in `~/.bindery/backups`.

```sh
node plugins/bindery/manager/cli.mjs want add https://github.com/owner/repo --note "try the review skill"
node plugins/bindery/manager/cli.mjs want list
node plugins/bindery/manager/cli.mjs want set <id> --status reviewed
node plugins/bindery/manager/cli.mjs want export
```

In the window, Want to try sits in the Libraries view. A saved link with a source repo can be imported from its detail page.

## Skills and prompts across both apps

The skill manager lists skills in `~/.claude/skills`, `~/.codex/skills`, the shared `~/.agents/skills` folder, the current project, and plugin caches. Plugin caches are read-only.

Turning an app on for a skill links its folder to the copy the other app already has, so both read the same files. Use `--copy` to make a separate copy instead. Codex links go in `~/.agents/skills`, which Codex reads alongside `~/.codex/skills`. Turning an app off removes only that app's entry. If the other app was linking to that folder, it gets its own copy first. Skills that come from a plugin are left to that plugin.

```sh
node plugins/bindery/manager/cli.mjs list
node plugins/bindery/manager/cli.mjs share code-review --with codex
node plugins/bindery/manager/cli.mjs share code-review --with codex --yes
node plugins/bindery/manager/cli.mjs unshare code-review --from claude --yes
node plugins/bindery/manager/cli.mjs diff code-review
node plugins/bindery/manager/cli.mjs resolve code-review --keep codex --yes
node plugins/bindery/manager/cli.mjs repair code-review --yes
```

Prompts install to `~/.claude/commands/<name>.md` for Claude Code and `~/.codex/prompts/<name>.md` for Codex. Bindery writes to those folders; whether each app loads prompts from them has not been verified in this release.

Free skill packs are listed in the window and on the command line. Bindery downloads a pack with `git` only when you ask for it.

```sh
node plugins/bindery/manager/cli.mjs packs
node plugins/bindery/manager/cli.mjs pack superpowers
node plugins/bindery/manager/cli.mjs install superpowers brainstorming --to claude-global
node plugins/bindery/manager/cli.mjs install superpowers brainstorming --to claude-global --yes
```

Nothing is deleted. Replaced and removed skills move to `~/.bindery/backups`. Every change is recorded in `~/.bindery/journal` and can be undone:

```sh
node plugins/bindery/manager/cli.mjs history
node plugins/bindery/manager/cli.mjs undo <txId>
```

Set `BINDERY_HOME` to keep this state somewhere other than `~/.bindery`.

Plugins that ship hooks, such as Ponytail, can be previewed, but install them with your host's own plugin command.

## Safety

The import scan is static. It matches patterns in the files and never runs code. It lists findings at three levels: high, medium and info. High covers things such as piping a download into a shell, deleting large parts of a disk, and reading credentials. Medium covers executable scripts, network addresses, hook and settings files, and very long lines. Info covers a missing license.

The scan is not a guarantee. Read a skill, especially its scripts, before you rely on it.

The window serves only on `127.0.0.1`, requires a token for each session, and closes itself when you are done.

## Privacy

Bindery has no analytics. It sends nothing over the network except the `git` downloads you ask for, such as fetching a pack.

The model advice hook classifies your first prompt in a new session with local keyword rules. It makes no network calls and does not upload the prompt. It stores only a hashed session identifier in a temporary file.

Bindery does not read or sync your personal settings. Changes to the published guidance are made deliberately, in this repository.

## Model advice

On the first prompt of a new session, a small advisory hook adds a short, plain-language suggestion about which model and effort to start with. It suggests and never switches models. If you choose a model or effort yourself, that choice stands.

Model names, limits and availability in the suggestions are not verified. Treat them as starting points.

## Updates and removal

Refresh the marketplace with:

```sh
codex plugin marketplace upgrade bindery
```

Then restart your session. On macOS, you can opt in to a daily refresh by running this from a clone of the repository:

```sh
node tools/auto-update.mjs enable
```

Stop it with `node tools/auto-update.mjs disable`. This creates one user-level LaunchAgent that refreshes the Codex home active when it was enabled. It does not change a separate T3 provider home. Scheduled updates need a Git-backed marketplace, not a local folder.

Codex may ask you to review changed hooks again. Do not bypass that review. A new chat or a restart may be needed. The scheduler does not check whether T3 has picked up the changes, and it does not sync private instructions or settings from the author's Mac.

If you installed the earlier standalone starter advisor, disable its old user-level hook in `/hooks` to avoid duplicate suggestions.

To remove Bindery, stop the daily refresh first, then run:

```sh
codex plugin remove bindery@bindery
codex plugin marketplace remove bindery
```

## Status

Tested so far: unit and API tests in temporary folders, and a manual install, remove, share, unshare and undo against a throwaway home folder on macOS. It has not been tested on Windows or Linux.

## Roadmap

See [docs/ROADMAP.md](docs/ROADMAP.md) for what is done, in progress and planned, and [docs/THEME.md](docs/THEME.md) for the visual rules.

## License

MIT. The pixel font is Departure Mono by Helena Zhang, under the SIL Open Font License (`plugins/bindery/manager/ui/departure-mono-LICENSE.txt`).
