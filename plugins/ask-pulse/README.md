# ask-pulse

A pulsing dayglo banner for a waiting agent, framing the last reply so it is impossible to miss
in a wall of terminal panes.

Two modes:

- **ask** — a rounded box carrying the questions, for the whole life of an `ask` dialog.
- **idle** — a caret rule (`^^^ WAITING FOR YOUR INPUT ^^^`) above the editor whenever the agent
  yields the turn at all, including a plain prose answer that never called `ask`, plus a full-width
  `v` divider appended to the transcript directly above that reply (v1.8). The divider is dim while
  the agent works and animates once the turn yields; it stays a dim `v` line in scrollback only when
  the reply was taller than the screen (removing an already-scrolled-off row would corrupt history).
  Both are cleared the moment you submit.

By default both flow a rainbow hue toward the text (v1.7); `/ask-pulse color <a> [b]` switches back
to the pre-v1.7 two-color fade-and-bounce.

Wrapping the assistant's actual response text is not possible from an extension:
`registerMessageRenderer` only accepts custom message types, decorating real transcript blocks
would mean patching `AssistantMessageComponent`, and omp rejects a direct `setTheme(ThemeObject)`
call from an extension — see below for why all three are refused.

![ask-pulse in action](docs/ask-pulse.gif)

![idle caret wave](docs/idle-wave.gif)

![rainbow frame](docs/rainbow-frame.gif)

<sub>All previews are captured from the real components via `scripts/render-preview.ts`, so they cannot drift from what the extension renders.</sub>

## Why an extension, not a patch

The ask dialog paints its own border with the static theme token `theme.fg("border", …)`
and `AskDialogComponent` is not exported from the public component barrel — there is no
seam to animate it from outside. Patching the installed package would be erased by omp's
several releases per day. So this mounts an *adjacent* animated banner through the stable
extension API (`pi.setWidget(..., { placement: "aboveEditor" })`), which renders immediately
above the editor container the dialog lives in, plus a divider component (v1.8) appended to
omp's transcript at each assistant `message_start` so the rainbow frames the specific reply the
agent just gave, not the whole screen.

Fading the transcript text itself (every line the agent already printed) is not reachable from an
extension at all: `setTheme(ThemeObject)` is rejected ("Direct theme object not supported"),
`setHeader`/`setFooter` are no-ops, and the components that paint transcript text have no external
seam. A transcript divider plus the rule above the editor is the closest attention-grabbing effect
the documented surface allows.

## Install

```
/marketplace add mlg87/omp-ask-pulse
/marketplace install ask-pulse@mlg87
```

Restart the session — newly installed extension modules are loaded at startup.

Updates install at startup only if omp is told to install them — its default `notify` merely logs
that a newer version exists:

```
omp config set marketplace.autoUpdate auto
```

Or, without the marketplace, drop `src/ask-pulse.ts` into `~/.omp/agent/extensions/`.

## Configuration

No source edits — a marketplace install lives in a plugin cache that `omp plugin upgrade`
overwrites. Use the slash command:

```
/ask-pulse show                 print the active palette and where it came from
/ask-pulse color pink cyan      fade between two colors (presets: pink green cyan amber violet red)
/ask-pulse color #39ff14        one color pulses against its own 24%-brightness dim
/ask-pulse color rainbow        flow a rainbow along the frame toward the text (default)
/ask-pulse period 800           pulse/flow cycle in ms (min 100)
/ask-pulse idle off             stop pulsing on plain end-of-turn (ask still pulses)
/ask-pulse hold 30m             lock at the first color/hue after this long; 0 pulses forever
/ask-pulse preview              mount the banner for four seconds
/ask-pulse reset                delete the user config
```

`color`, `color2`, `period`, and `idle` persist to `~/.omp/agent/ask-pulse.json`. Precedence, lowest to
highest:

| Source | Example |
|---|---|
| built-in default | rainbow @ 2000 ms |
| user config | `~/.omp/agent/ask-pulse.json` |
| project config | `<project>/.omp/ask-pulse.json` |
| environment | `ASK_PULSE_COLOR=#ff10f0 ASK_PULSE_COLOR2=#0af0ff ASK_PULSE_PERIOD_MS=800 ASK_PULSE_IDLE=0 ASK_PULSE_HOLD_AFTER_MS=0` |

```json
{ "color": "rainbow", "periodMs": 2000, "idle": true, "holdAfterMs": 1800000 }
```

Setting `color` to a hex value or preset name switches every mode from the rainbow flow to the
pre-v1.7 two-endpoint fade-and-bounce; `color2` (or a derived 24%-brightness dim, if omitted) is
the second endpoint. `"rainbow"` (or omitting `color` entirely) switches back.

The config is re-read on every mount, so a change lands on the next turn — no restart.

After `holdAfterMs` (default 30 minutes) the banner stops animating and locks at `color`, and
the repaint tick is killed — an unattended pane must not repaint at 30 Hz
overnight. The locked state is just as visible as the pulse once you look at the screen.
The deadline is re-derived inside `render()`, so a resize or re-layout after the tick dies
still paints bright. `0` or negative disables the lock.

In rainbow mode the hold lock freezes the clock rather than snapping to one hue, so a locked
screen still reads as a full gradient instead of a single flat color.

The pulse fades between two endpoints: `color` at the peak and `color2` at the trough (v1.5),
interpolated in OKLab rather than per-channel RGB (v1.6) so the midpoint stays saturated instead of
dipping through gray. Set only `color` and the trough is derived from it at 24% brightness, so one
word still recolors the whole banner and pre-v1.5 single-color configs keep their look. A malformed
config is ignored rather than fatal.

The default cycle is 2000 ms (v1.6, up from 1200 ms): a slower fade at ~30 fps reads as a smooth
ramp where the old 1200 ms at 10 fps read as a throb.

Compile-time knobs still living in `src/ask-pulse.ts`: `FRAME_MS` (repaint tick),
`WAVE_SOFTNESS` (idle wave gradient width), `MAX_QUESTIONS`, `MAX_LINES_PER_QUESTION`.

## Degradation

- RPC/ACP modes only accept string-array widgets; every `setWidget` call is wrapped in
  try/catch and silently no-ops there.
- If `tool_execution_end` is skipped (Esc-aborted ask), `agent_end` and `session_shutdown`
  clear the banner.
- The divider is a transcript block found by duck-typing omp's `TranscriptContainer`; if the
  container is not found the divider is skipped and only the rule renders. It is never removed
  once it may have reached terminal scrollback.
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

### Regenerating the preview GIFs

`scripts/render-preview.ts` imports the real `AskPulseBanner`/`AskPulseDivider` and writes one HTML
file per frame — 50 frames × 40 ms = one full 2000 ms period — so the published preview cannot
drift from the code (the pre-v1.6 `scripts/frame.html` mirrored the color math by hand and did
drift). Screenshot the `<pre>` element of each frame into `f000.png … f049.png`, then encode:

```
bun scripts/render-preview.ts idle    # or: ask, frame
# screenshot each scripts/preview-idle-NNN.html <pre> to /tmp/frames/fNNN.png
ffmpeg -framerate 25 -i /tmp/frames/f%03d.png \
  -vf "scale=800:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  -loop 0 docs/idle-wave.gif
```

`ask` and `frame` mode encode to `docs/ask-pulse.gif` and `docs/rainbow-frame.gif` the same way.
The generated `preview-*.html` files are gitignored; only the GIFs are committed.

## License

MIT
