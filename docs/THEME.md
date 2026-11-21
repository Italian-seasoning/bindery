# Bindery visual theme

Two physical objects carry the look. Everything else stays quiet: flat surfaces, hairlines, one cobalt.

| Object | Means | Used for | Never used for |
|---|---|---|---|
| **Keycap** | "Press this to change something" (input) | The Use in switches, the Apply button, the app mark | Labels, shortcut hints, decoration, cards |
| **Readout** | "This is what is true right now" (output) | Live status: the agent face, scan results, apply results, a single key number | Static text, headings, counts that never change, decoration |

The pairing is the idea: you press keys, the readout answers. A keycap never shows status and a readout is
never clickable. If an element is neither an action nor live status, it uses neither object.

## Readout

A small dot-matrix display: a grid of square cells, lit or unlit, behind a dark glass panel.

- **Grid**: 5×7 glyphs, 1-cell gap between glyphs, cell pitch 4px in the app (3px at the small size), lit cell
  3px square with 0.5px radius. Unlit cells drawn at low opacity so the grid is always visible.
- **Glyphs**: `0-9 A-Z space - . / ! ? : +`. Text is shown uppercase. Unknown characters render as a space.
  Text is never longer than 12 glyphs; longer text belongs in normal type.
- **Colour**: lit cells use `--signal` (dark theme) and `--cobalt` (light theme). Unlit cells use the lit colour
  at 10% opacity. Panel: `--readout-bg`, a near-black in both themes with an inset hairline. Warnings light amber
  (`--amber`), errors light `--red`. No other colours.
- **Motion**: glyph changes switch instantly, column by column, left to right, 12ms per column. No scrolling
  marquees. Reduced motion: switch all at once.
- **Agent face**: the mark's eyes drawn on the readout grid. Moods: `idle` (eyes open), `sleep` (closed),
  `look-left`, `look-right`, `happy` (∩ shapes), `alert` (`!` in each eye), `blink` (one frame closed).

Where it appears in the app:
1. Empty detail panel: the agent face, `sleep` mood, above the hint text.
2. Import preview: the safety result (`CLEAN`, `2 MEDIUM`, `1 HIGH`) next to the library name.
3. After Apply: the toast leads with a readout (`DONE` or `UNDONE`) and the face blinks `happy` once.
4. While a git fetch runs: the face alternates `look-left` / `look-right` every 300ms.

On the website the readout is the hero's live element (see the website brief) and appears nowhere else.

## Palette

| Token | Dark | Light | Role |
|---|---|---|---|
| `--ground` | app.css | app.css | Page |
| `--cobalt` | `#3443F5` | `#2E3CF2` | The one accent: primary action, selection, mark |
| `--cobalt-deep` | `#1E28B8` | `#1E28B8` | Keycap skirt, pressed state |
| `--signal` | `#8A94FF` | `#2E3CF2` | Lit readout cells, focus rings on dark |
| `--amber` | `#F2B63D` | `#8A5A00` text | Medium findings, warnings |
| `--red` | `#FF6B5E` | | High findings, errors |
| `--readout-bg` | `#0B0C12` | `#14151C` | Readout panel |

No green accents. No gradients as decoration. Lime `#B8F03C` is retired.

## Type

- UI and site text: the system stack (`-apple-system, system-ui`), weights 450/550/650.
- Departure Mono: paths, shortcut glyphs and code.
- Readouts are SVG with `role="img"` and an `aria-label` carrying the plain text.
