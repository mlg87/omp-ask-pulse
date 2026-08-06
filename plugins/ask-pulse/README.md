# ask-pulse

A pulsing dayglo banner for a waiting agent, mounted directly above the editor so it is the
last thing on screen — impossible to miss in a wall of terminal panes.

Two modes, both pinned below all transcript output:

- **ask** — a rounded box carrying the questions, for the whole life of an `ask` dialog.
- **idle** — a single titled rule, whenever the agent yields the turn at all, including a
  plain prose answer that never called `ask`. Cleared the moment you submit.

Wrapping the assistant's actual response text is not possible from an extension:
`registerMessageRenderer` only accepts custom message types, and decorating real transcript
blocks would mean patching `AssistantMessageComponent` — see below for why that is refused.

![ask-pulse in action](docs/ask-pulse.gif)

<sub>Preview rendered from the same color/glyph math the extension uses; the lower box stands in for omp's own ask dialog.</sub>

## Why an extension, not a patch

The ask dialog paints its own border with the static theme token `theme.fg("border", …)`
and `AskDialogComponent` is not exported from the public component barrel — there is no
seam to animate it from outside. Patching the installed package would be erased by omp's
several releases per day. So this mounts an *adjacent* animated banner through the stable
extension API (`pi.setWidget(..., { placement: "aboveEditor" })`), which renders immediately
above the editor container the dialog lives in.

## Install

```
/marketplace add mlg87/omp-ask-pulse
/marketplace install ask-pulse@mlg87
```

Restart the session — newly installed extension modules are loaded at startup.

Or, without the marketplace, drop `src/ask-pulse.ts` into `~/.omp/agent/extensions/`.

## Configuration

No source edits — a marketplace install lives in a plugin cache that `omp plugin upgrade`
overwrites. Use the slash command:

```
/ask-pulse show                 print the active palette and where it came from
/ask-pulse color pink cyan      fade between two colors (presets: pink green cyan amber violet red)
/ask-pulse color #39ff14        one color pulses against its own 24%-brightness dim
/ask-pulse period 800           pulse cycle in ms (min 100)
/ask-pulse idle off             stop pulsing on plain end-of-turn (ask still pulses)
/ask-pulse hold 30m             lock at the first color after this long; 0 pulses forever
/ask-pulse preview              mount the banner for four seconds
/ask-pulse reset                delete the user config
```

`color`, `color2`, `period`, and `idle` persist to `~/.omp/agent/ask-pulse.json`. Precedence, lowest to
highest:

| Source | Example |
|---|---|
| built-in default | pink `#ff10f0` ⇄ cyan `#0af0ff` @ 1200 ms |
| user config | `~/.omp/agent/ask-pulse.json` |
| project config | `<project>/.omp/ask-pulse.json` |
| environment | `ASK_PULSE_COLOR=#ff10f0 ASK_PULSE_COLOR2=#0af0ff ASK_PULSE_PERIOD_MS=800 ASK_PULSE_IDLE=0 ASK_PULSE_HOLD_AFTER_MS=0` |

```json
{ "color": "#ff10f0", "color2": "#0af0ff", "periodMs": 1200, "idle": true, "holdAfterMs": 1800000 }
```

The config is re-read on every mount, so a change lands on the next turn — no restart.

After `holdAfterMs` (default 30 minutes) the banner stops animating and locks at `color`, and
the repaint tick is killed — an unattended pane must not repaint at 10 Hz
overnight. The locked state is just as visible as the pulse once you look at the screen.
The deadline is re-derived inside `render()`, so a resize or re-layout after the tick dies
still paints bright. `0` or negative disables the lock.

The pulse fades between two endpoints: `color` at the peak and `color2` at the trough (v1.5).
Set only `color` and the trough is derived from it at 24% brightness, so one word still
recolors the whole banner and pre-v1.5 single-color configs keep their look. A malformed
config is ignored rather than fatal.

Compile-time knobs still living in `src/ask-pulse.ts`: `FRAME_MS` (repaint tick),
`MAX_QUESTIONS`, `MAX_LINES_PER_QUESTION`.

## Degradation

- RPC/ACP modes only accept string-array widgets; every `setWidget` call is wrapped in
  try/catch and silently no-ops there.
- If `tool_execution_end` is skipped (Esc-aborted ask), `agent_end` and `session_shutdown`
  clear the banner.
- Colors are 24-bit truecolor; non-truecolor terminals approximate.
- The only runtime imports are `bun` and `node:*` builtins; every omp package import is
  type-only, so the module resolves nothing from a package tree.

## Local development

Point omp at a working copy instead of the published cache, then restart the session:

```
omp plugin link ./plugins/ask-pulse
```

```
bun install
bun run lint        # biome
bun run typecheck   # tsc --strict
bun run test        # bun test
```

`scripts/frame.html` renders one preview frame; it mirrors the color and glyph math in
`src/ask-pulse.ts` and takes the pulse phase as `?t=<elapsed ms>` (period 1200 ms). To
refresh `docs/ask-pulse.gif` after a color change, screenshot it across one period — 24
frames at 50 ms — and encode:

```
ffmpeg -framerate 20 -i f%03d.png \
  -vf "scale=800:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  -loop 0 docs/ask-pulse.gif
```

## License

MIT
