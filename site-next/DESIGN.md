# Bindery site: design plan

## Brief
- Subject: Bindery, a free local manager for the skills and prompts that Claude Code and Codex read. Core: libraries (build, share as folder or repo, import after a safety scan, undo).
- Audience: developers who use Claude Code and/or Codex and have collected skills.
- Job: make the problem felt (skills scattered and drifting across three folders), show the fix as a story, get people to the GitHub repo.
- Assets: the cobalt keycap app icon with pixel eyes, Departure Mono, the 5×7 readout system from the app (docs/THEME.md).
- Owner's ask: "a real story teller".
- Assumptions: no screenshots of real users' machines; every path and command on the site is real Bindery behaviour. Skill names in the story (pr-review, polish, release-notes, dev-setup) are examples and labelled as such nowhere because they are generic; they are not claims.

## Concepts
| | Idea | Anchor | Signature | O/F/Fe/P |
|---|---|---|---|---|
| A. Material | The page is your home folder: scroll reorganises a real directory tree | Bindery moves and links folders in `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills` | rows file themselves from three trees into one | 3 / 5 / 4 / 2 |
| B. Name | A bindery gathers loose signatures, sews and binds them | the name | chapters as binding steps | 2 / 3 / 4 / 3 |
| C. Character | The agent tells its own story on its dot-matrix readout: it wakes, looks for its skills, finds copies that disagree, gets a library from a friend, reads it before running it | the product's real mascot (pixel eyes) and the readout the app already uses for live status | a sticky stage where the agent's face and a one-line readout narrate each chapter while the file panels change | 4 / 5 / 4 / 2 |

Pick C, with A's real folder panels as the stage it looks at. The storyteller is the agent itself; the folders are what it sees. Steal from A for the 404: a path that resolves to nothing.

## Concept card
```
Idea:        The agent tells you, on its own dot-matrix readout, how its skills got scattered and how a library brought them back.
Metaphor:    a status display narrating a story: every chapter is a state the readout reports.
Signature:   sticky stage: the agent's face + a readout line + the folder panels change state per chapter (7 chapters); the face follows the pointer and blinks at rest.
Emotion:     curious and a little funny in the first 3 s (a big face waking up), then relief.
Motion verb: switch column by column, like a dot-matrix (stepped left-to-right wipes, never smooth fades).
Screenshot:  the giant face looking left at three folders that disagree, readout saying 2 COPIES in amber.
```

## System
- Palette: ground `#101116` (graphite), panel `#0B0C12` (readout glass), ink `#ECEAE3`, muted `#A9ABB3` (AA on ground), line `rgba(236,234,227,.12)`, accent cobalt `#3443F5`, signal `#8A94FF` (lit cells), amber `#F2B63D`, red `#FF6B5E` (only inside the story's safety chapter). Curtain: panel colour with a dot grid. Named after THEME.md; no green.
- Type: General Sans (Fontshare) 400/500/600 for everything set in words; Departure Mono for paths, commands and the 404 path. Display 600, tracking -0.04em, leading 0.92. Body 18px/1.55.
- Grid: 12 columns, gutter clamp(16px, 2.5vw, 40px), left-aligned. Story: captions in columns 1-5, stage sticky in 6-12. Section rhythm varies: hero full height, story long, CLI compact, facts as a big list, footer as a readout poster.
- Shape: radius 14px on panels, 8px on rows, 0 on the dot cells (0.5 unit).
- Motion: one ease family (expo); concept transitions use `steps(n)` for the column-by-column look. Panels enter with a stepped clip-path wipe left to right. Durations 0.5 to 0.8 s.
- Hovers (two treatments): primary (CTA, nav, footer links) = a stepped fill/underline sweep left to right; inline links = underline at rest that thickens.
- Idle: the agent face blinks every 4 to 7 s and its eyes follow the pointer (look-left / idle / look-right); the footer readout runs a slow scan column. Off under reduced motion.
- Reduced motion: no smooth scroll, no loader theatrics, stage still switches state but instantly.

## Composition
```
HERO      [mark Bindery ......................... Story  Format  GitHub]
          [h1 huge, 6 cols          ][ giant face readout, 6 cols ]
          [lede + keycap CTA        ][ "the agent" caption        ]
STORY     [caption 1 (sticky-free)  ][ STAGE sticky: face+readout ]
          [caption 2                ][ folder panels / library /  ]
          [... 7 chapters           ][ friend's preview           ]
CLI       [h2 left][ terminal block spanning 8 cols, offset right  ]
FACTS     [four big statements stacked, numbers only where true   ]
FOOTER    [giant BINDERY readout full width][links row]
FORMAT    spec sheet: tree left, annotated library.json right, rules list
404       face looking around, path in mono, link home
```

## Genericness test
- A generic model would put a feature grid and a terminal on a dark page with a glow. Changed: no cards grid; the whole middle is one narrated sequence; the only "glow" is lit dot cells, which are the product's own status display.
- A generic model would accent one headline word in cobalt. Changed: headlines stay one colour; colour only appears as state (lit cells, amber drift, red risk).

## QA pass 1 decisions (2026-11-21)

- Loader removed. On a throttled phone it held the hero for 4.3 s. The first moment is now the hero
  agent waking (sleep face, then idle at 0.55 s), which is the concept's own intro and costs nothing.
- Dimmed chapters step to `--c-faint` instead of 38% opacity, so text you are not reading still passes AA.
- Stage layers are `div`s: the stage is an aria-hidden illustration and its inactive states are hidden
  on purpose; the chapter text carries the content.
- Idle life: gazing agents glance left or right after 1.8 s without pointer movement, and the header
  mark (same agent, small) glances and blinks on every page. All off under reduced motion.
- Hover: the brand's eyes look toward the name; the current nav item switches an ink line over its
  signal line, same stepped sweep as other links.
- Format page is a quiet reference page. Its only idle life is the header mark glancing (about 1 px at
  26 px size), below the shoot detector's threshold. Kept still on purpose: it is a spec you read.
