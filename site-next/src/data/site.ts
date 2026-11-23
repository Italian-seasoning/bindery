// All copy for the site. Every path and command here is real Bindery behaviour.
// The skill names in the story (pr-review, polish, release-notes, dev-setup, tidy-commits,
// figma-notes) are ordinary examples, not claims about anyone's setup.

export const site = {
  name: 'Bindery',
  role: 'Skill libraries for Claude Code and Codex',
  url: 'https://italian-seasoning.github.io/bindery/',
  repo: 'https://github.com/Italian-seasoning/bindery',
  description:
    'Bindery gathers the skills and prompts Claude Code and Codex read into libraries you can share, import after a safety check, and undo. Free, local, MIT.',
};

/** Prefix a site path ('/story/') with the deploy base ('/bindery'). */
export const withBase = (p: string) => import.meta.env.BASE_URL.replace(/\/+$/, '') + p;

export const nav = [
  { href: '/', label: 'Home' },
  { href: '/story/', label: 'Story' },
  { href: '/format/', label: 'Format' },
];

export type Chapter = {
  id: string;
  readout: string; // at most 8 glyphs
  face: 'look' | 'idle' | 'alert' | 'happy';
  tone: 'signal' | 'amber' | 'red';
  title: string;
  body: string;
};

export const chapters: Chapter[] = [
  {
    id: 'looking',
    readout: 'LOOKING',
    face: 'look',
    tone: 'signal',
    title: 'Three folders, one of me.',
    body: 'You asked me to review a pull request, and I know a skill for that. Claude Code keeps its skills in ~/.claude/skills, Codex in ~/.codex/skills, and some live in the shared ~/.agents/skills. So I look in all three.',
  },
  {
    id: 'drift',
    readout: '2 COPIES',
    face: 'alert',
    tone: 'amber',
    title: 'Two copies, two opinions.',
    body: 'pr-review is in two folders, and the copies no longer agree. One says to read the diff first. The other says to read the tests first. Which one I follow depends on the app you happened to open.',
  },
  {
    id: 'linked',
    readout: 'LINKED',
    face: 'happy',
    tone: 'signal',
    title: 'Keep one. Link the other.',
    body: 'Bindery puts both copies side by side. You keep the one you trust, and the other app gets a link to the same folder. One file to edit, and both apps read it.',
  },
  {
    id: 'library',
    readout: '4 ITEMS',
    face: 'idle',
    tone: 'signal',
    title: 'The good ones, bound together.',
    body: 'You pick the skills worth keeping and add them to a library: a plain folder with a library.json that says what each item is best for and which app it belongs to.',
  },
  {
    id: 'shared',
    readout: 'SHARED',
    face: 'happy',
    tone: 'signal',
    title: 'A folder you can hand over.',
    body: 'Export it, zip it, or push it to a repo. Bindery never publishes anything for you. A friend pastes owner/ui-kit into their own copy of Bindery.',
  },
  {
    id: 'scan',
    readout: '1 HIGH',
    face: 'alert',
    tone: 'red',
    title: 'Read before it runs.',
    body: 'Their Bindery reads every file before anything installs, and nothing runs while it reads. dev-setup pipes a download straight into the shell, so it stays unticked until they choose it by name.',
  },
  {
    id: 'done',
    readout: 'DONE',
    face: 'happy',
    tone: 'signal',
    title: 'Installed, and undoable.',
    body: 'Three items land in the apps they were made for. Every change is written to a journal, so one undo puts everything back. Me? I go back to the pull request.',
  },
];

export const commands = [
  { note: 'Every skill both apps can read, in one list', cmd: 'bindery list' },
  { note: 'Keep the Claude Code copy; Codex links to it', cmd: 'bindery resolve pr-review --keep claude' },
  { note: 'Write a library to a folder you can zip or push', cmd: 'bindery library export ui-kit ~/Desktop/ui-kit' },
  { note: 'Read a shared library: items, notes, licence, findings', cmd: 'bindery library import owner/ui-kit' },
  { note: 'Install what you ticked', cmd: 'bindery library import owner/ui-kit --yes' },
  { note: 'Put it all back', cmd: 'bindery undo <id>' },
];

export const facts = [
  { big: 'On your machine.', small: 'The window serves only on 127.0.0.1 and closes itself when you are done. Nothing is uploaded and there is no account.' },
  { big: 'Plans before changes.', small: 'Every install, removal, share and repair prints exactly which folders move. Nothing changes until you say yes.' },
  { big: 'Backups, not deletes.', small: 'Anything replaced or removed moves into ~/.bindery/backups and is listed in History with its undo.' },
  { big: 'Free, MIT.', small: 'Use it, fork it, ship it inside your own tools. The pixel font is Departure Mono by Helena Zhang.' },
];
