# obvi-plan

Makes omp's plan mode impossible to miss. While plan mode is active, the whole terminal background
turns lilac (or a color you choose). The moment plan mode ends, your terminal gets its own
background back.

## What you get

- **A tinted background while planning.** It turns on however plan mode starts: `/plan`, the
  mode-cycle key, or resuming a session that was in plan mode. It covers everything omp draws
  without its own background color, which is most of the screen, including scrollback.
- **Your background back afterwards.** It restores when you run `/plan` again, approve the plan,
  pause plan mode, quit omp, or switch to a session that isn't in plan mode.
- **Readable text on a light tint.** If omp picks its theme automatically (the default), it
  switches to its light theme while the background is lilac and back to your usual theme
  afterwards (see [Readable text](#readable-text)).
- **Nothing permanent.** obvi-plan never reads or changes your terminal profile or your omp theme
  settings. A paused plan (`plan_paused`) counts as not in plan mode.

## Install

```
/marketplace add mlg87/omp-plugins
/marketplace install obvi-plan@mlg87
```

Restart the omp session; omp loads extension modules only at startup. Skip the first line if you
already added the `mlg87` marketplace for another plugin.

To receive updates automatically at startup (omp's default only logs that one exists):

```
omp config set marketplace.autoUpdate auto
```

Without the marketplace, you can copy `src/obvi-plan.ts` into `~/.omp/agent/extensions/` instead.

## Commands

`/obvi-plan` with no arguments is the same as `/obvi-plan show`.

| Command | Effect |
|---|---|
| `/obvi-plan show` | Print the color, whether the tint and theme matching are on, whether plan mode is active, and which config sources are in effect. |
| `/obvi-plan color <hex\|preset>` | Set the plan-mode background. Takes hex (`#2a1f3d`, `2a1f3d`, `#fff`) or a preset. Applies immediately if plan mode is active. |
| `/obvi-plan on` / `off` | Turn the tint on or off without uninstalling. `off` during plan mode restores your background right away. |
| `/obvi-plan theme on` / `off` | Turn theme matching on or off (see [Readable text](#readable-text)). |
| `/obvi-plan preview` | Show the color for three seconds, even outside plan mode. |
| `/obvi-plan reset` | Delete your user config, returning to lilac with theme matching on. |

Presets:

| Preset | Hex | Brightness |
|---|---|---|
| `lilac` | `#c8a2c8` | light (default) |
| `lavender` | `#e6e6fa` | light |
| `mauve` | `#e0b0ff` | light |
| `plum` | `#3d2b4f` | dark |
| `midnight` | `#1e1b3a` | dark |

## Configuration

Commands save to your user config file. You can also edit that file by hand, commit a per-project
file, or use environment variables.

| Key | Type | Default | Environment variable | Meaning |
|---|---|---|---|---|
| `color` | hex or preset | `"#c8a2c8"` (lilac) | `OBVI_PLAN_COLOR` | Background color during plan mode. |
| `enabled` | boolean | `true` | `OBVI_PLAN_ENABLED` | Tint the background at all. |
| `matchTheme` | boolean | `true` | `OBVI_PLAN_MATCH_THEME` | Let omp's automatic theme follow the tint. |

For the environment variables, `0`, `false`, `off`, and `no` mean false; any other value means true.

Sources, lowest to highest precedence; later sources override individual keys:

1. Built-in defaults.
2. User config: `~/.omp/agent/obvi-plan.json`, or `$PI_CODING_AGENT_DIR/obvi-plan.json` if you use a
   custom omp agent directory.
3. Project config: `<project>/.omp/obvi-plan.json`. Useful for giving each repository its own
   plan color.
4. Environment variables.

```json
{ "color": "plum", "enabled": true, "matchTheme": true }
```

Hand edits take effect the next time plan mode turns on or off, with no restart. Changes made with
`/obvi-plan` commands apply immediately. A malformed file is ignored rather than breaking the
session.

### Readable text

Lilac is a light color, so light text on it is hard to read. omp's automatic theme picks
between two themes, `theme.dark` and `theme.light`, based on how bright the terminal background
is, but normally checks only at startup, when your OS switches between light and dark, and on
Ctrl+L. With `matchTheme` on, obvi-plan asks omp to check again after every background change:

- **Plan mode on:** lilac reads as light, so omp switches to its light theme (dark text).
- **Plan mode off:** your background comes back, and so does your usual theme.
- **Session only:** omp treats the switch as temporary, so your saved settings are never written.

Theme matching has no effect if you chose a single fixed theme instead of the automatic one. It
also doesn't work in terminals that can't report their background color, including inside tmux:
tmux tints the pane but reports the outer terminal's color. In those cases, pick a dark tint
instead: `/obvi-plan color plum`.

`/obvi-plan theme off` stops omp from switching themes. If you turn it off while plan mode is
tinted, omp stays on the light theme until plan mode ends, and still switches back then.

## How it works

- **Setting the color:** obvi-plan sends the standard OSC 11 escape sequence
  (`ESC ] 11 ; rgb:c8/a2/c8 BEL`). It changes the terminal's default background, so every cell
  omp draws without its own background changes at once, with no redraw.
- **Restoring:** it sends OSC 111 (`ESC ] 111 BEL`), which resets the background to your terminal
  profile's setting. It only sends this after it has set a color itself, so a background you set
  some other way is never overwritten while plan mode is off.
- **Detecting plan mode:** omp doesn't give extensions a plan-mode event. It does add a
  `mode_change` entry to the session each time plan mode starts, pauses, or ends; that's how omp
  restores the mode when you resume. Every 250 ms, obvi-plan checks whether the session has a new
  entry; that check is a single lookup. Only when something was added does it read back to the most
  recent `mode_change`.
- **Theme matching:** after each background change it calls omp's `refreshAppearance()`, which asks
  the terminal for its background color. omp's automatic theme then picks a theme based on the
  answer.
- **Ordering:** the escape sequences go through omp's own terminal writer, so the color change
  always reaches the terminal before the theme check.
- **Cleanup:** leaving plan mode, `session_shutdown`, and a process `exit` handler all restore the
  background, so quitting from inside plan mode never leaves your shell lilac.

## Terminal support

| Your terminal | Result |
|---|---|
| Supports OSC 11 and OSC 111 (xterm, kitty, WezTerm, Ghostty, foot, and VTE-based terminals such as GNOME Terminal, among others) | Full behavior. |
| tmux (recent versions) | The pane is tinted and restored; theme matching usually doesn't work (see above). |
| Supports OSC 11 but not OSC 111 | Tints, but the tint stays after plan mode ends. Use `/obvi-plan off`. |
| Ignores OSC 11 | No tint; omp's theme is unaffected. |

## Limitations

- **Interactive terminal only.** In RPC, ACP, and print modes, stdout carries omp's protocol, so
  obvi-plan writes nothing.
- **A hard kill skips cleanup.** `kill -9` doesn't let any exit handler run. If that leaves the
  background tinted, run `printf '\e]111\a'` or open a new tab.
- **Fallback path.** obvi-plan gets omp's terminal writer through a zero-height widget. Where
  widgets are unavailable, it writes to stdout directly and skips theme matching.
- **Self-contained module.** Its only runtime imports are `node:*` built-ins; omp packages are
  imported for types only, so the file works from a plugin cache or a bare
  `~/.omp/agent/extensions/` folder.

## Troubleshooting

- **No tint in plan mode.** Restart omp after installing, then check that `/plugins list` shows
  `obvi-plan@mlg87` as enabled. `/obvi-plan show` should report the tint as on and plan mode as
  active. Try `/obvi-plan preview`; if even that shows no color, your terminal ignores OSC 11.
- **Text is hard to read on the tint.** omp didn't switch themes. You probably have a fixed theme,
  or you're in tmux. Use a dark preset (`plum`, `midnight`), or switch omp to its automatic theme.
- **The tint stays after plan mode ends.** Your terminal doesn't support OSC 111. Run
  `printf '\e]111\a'` to clear it now, and `/obvi-plan off` to stop it happening again.
- **omp stays on the light theme after plan mode.** Press Ctrl+L so omp checks the background again.
- **A project uses a different color than expected.** Run `/obvi-plan show`. A
  `<project>/.omp/obvi-plan.json` file or an `OBVI_PLAN_*` environment variable overrides your
  user config.

## Uninstall

```
/marketplace uninstall obvi-plan@mlg87
```

Your settings stay in `~/.omp/agent/obvi-plan.json`; delete it (or run `/obvi-plan reset` first)
for a clean removal.

## Development

```
bun install
bun run lint        # biome
bun run typecheck   # tsc --strict
bun run test        # bun test
```

To run your working copy in omp, link it and restart the session:

```
omp plugin link ./plugins/obvi-plan
```

Layout:

- `src/obvi-plan.ts` — the extension: config loading, `ModeTracker` (plan-mode detection),
  `Backdrop` (writes the escape sequences, only when something changed), and the event and
  command wiring.
- `src/obvi-plan.test.ts` — tests for color parsing, config precedence, the escape sequences, mode
  tracking (including how many lookups it takes), the backdrop, and the extension wiring against a
  fake omp (tint, restore, and theme-check order).

## Changelog

| Version | Change |
|---|---|
| 1.0.0 | Initial release: lilac tint during plan mode, restore on exit, theme matching, `/obvi-plan` commands, and config files. |

## License

MIT
