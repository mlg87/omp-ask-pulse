# obvi-plan

Makes omp's plan mode impossible to miss: while plan mode is active the whole terminal background
turns lilac, and the moment you leave plan mode (`/plan` again, approving the plan, pausing it, or
quitting omp) your terminal is handed back its own default background.

## How it works

- **The color** is set with OSC 11, which changes the terminal's *default* background. Everything
  omp paints without an explicit background — most of the screen, scrollback included — changes
  at once, with no repaint.
- **The restore** is OSC 111, which resets the background to whatever your terminal profile
  configures. Your theme is never read, saved, or rewritten, so "back to default" is exact.
- **Readable text** (`matchTheme`, on by default): omp's auto theme picks its `theme.dark` or
  `theme.light` slot from the background brightness the terminal reports, but only checks at
  startup, on OS appearance changes, and on Ctrl+L. After each tint change obvi-plan asks omp's
  terminal layer to check again, so lilac flips omp to its light theme (dark text) and the restore
  flips it back. The switch is session-only; your saved theme settings are never written.
- **Detection**: omp has no plan-mode event for extensions, but every plan-mode transition appends a
  `mode_change` entry to the session (it is how omp itself restores plan mode on resume). A 250 ms
  tick checks the session leaf id — one O(1) call — and only when it moves walks back to the latest
  `mode_change`. Only `plan` counts as active; `plan_paused` and `none` restore your background.
- The reset is only written after obvi-plan set a color, so a background you set yourself is never
  clobbered while you are outside plan mode. `session_shutdown` and a process `exit` hook both
  reset, so quitting from inside plan mode never leaves your shell lilac.

## Install

```
/marketplace add mlg87/omp-plugins
/marketplace install obvi-plan@mlg87
```

`obvi-plan` is published in the `mlg87` marketplace ([mlg87/omp-plugins](https://github.com/mlg87/omp-plugins)),
together with `ask-pulse`. If you already added it for ask-pulse, skip the first line.

Restart the session — newly installed extension modules are loaded at startup.

Updates install at startup only if omp is told to install them — its default `notify` merely logs
that a newer version exists:

```
omp config set marketplace.autoUpdate auto
```

Or, without the marketplace, drop `src/obvi-plan.ts` into `~/.omp/agent/extensions/`.

## Configuration

No source edits — a marketplace install lives in a plugin cache that `omp plugin upgrade`
overwrites. Use the slash command:

```
/obvi-plan show               print the active color and where it came from
/obvi-plan color plum         set the plan-mode background (hex, or a preset below)
/obvi-plan color #2a1f3d      any #rgb / #rrggbb hex value
/obvi-plan off                keep plan mode untinted without uninstalling (/obvi-plan on to undo)
/obvi-plan theme off          keep omp's current theme while tinted (see Contrast below)
/obvi-plan preview            show the color for three seconds
/obvi-plan reset              delete the user config (back to lilac)
```

| Preset | Hex | Notes |
|---|---|---|
| `lilac` | `#c8a2c8` | default |
| `lavender` | `#e6e6fa` | light |
| `mauve` | `#e0b0ff` | light |
| `plum` | `#3d2b4f` | dark — keeps a dark theme's light text readable |
| `midnight` | `#1e1b3a` | dark |

A color change made while plan mode is active applies immediately.

`color`, `enabled`, and `matchTheme` persist to `~/.omp/agent/obvi-plan.json`. Precedence, lowest to highest:

| Source | Example |
|---|---|
| built-in default | lilac `#c8a2c8`, enabled, theme matching on |
| user config | `~/.omp/agent/obvi-plan.json` |
| project config | `<project>/.omp/obvi-plan.json` |
| environment | `OBVI_PLAN_COLOR=#3d2b4f OBVI_PLAN_ENABLED=0 OBVI_PLAN_MATCH_THEME=0` |

```json
{ "color": "#c8a2c8", "enabled": true, "matchTheme": true }
```

The config is re-read on every plan-mode transition, so a hand edit lands the next time plan mode
toggles — no restart. A malformed config is ignored rather than fatal.

### Contrast

Lilac is a light color, so light text on it is hard to read. With omp's default auto theme,
theme matching handles this: while plan mode is tinted omp uses its light theme (`theme.light`,
`light` by default), and your dark theme returns with your background.

Theme matching only works when omp chooses the theme from the terminal (the default). If you
pinned one theme, or your terminal cannot report its background color (common inside tmux, which
tints the pane but answers the query with the outer terminal's color), omp keeps its current
theme. For a dark theme, pick a dark tint instead: `/obvi-plan color plum`.

With `/obvi-plan theme off` omp never switches themes. Turning it off while tinted takes effect at
the next plan-mode change; leaving plan mode still switches omp back.

## Degradation

- Only active with an interactive UI on a TTY. In RPC/ACP/print modes stdout is a protocol
  channel, so nothing is written.
- Terminals that ignore OSC 11 simply show no tint, and omp's theme is unaffected (the recheck
  reads the unchanged background). Terminals that support OSC 11 but not OSC 111
  keep the tint after plan mode ends. Most modern terminals support both (xterm, kitty, WezTerm,
  Ghostty, foot, and VTE-based terminals among them; tmux applies them to the pane). If the tint
  lingers after plan mode, your terminal lacks OSC 111 — `/obvi-plan off` is the escape hatch.
- A hard kill (`kill -9`) skips every exit hook. If that leaves the background tinted, run
  `printf '\e]111\a'` or open a new tab.
- Escape sequences go through omp's own terminal writer (captured by a zero-row widget), so the
  tint always reaches the terminal before the recheck. If the widget surface is unavailable they
  go straight to stdout and theme matching is skipped.
- The only runtime imports are `node:*` builtins; every omp package import is type-only, so the
  module resolves nothing from a package tree.

## Local development

Point omp at a working copy instead of the published cache, then restart the session:

```
omp plugin link ./plugins/obvi-plan
```

```
bun install
bun run lint        # biome
bun run typecheck   # tsc --strict
bun run test        # bun test
```

## License

MIT
