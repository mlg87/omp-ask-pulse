# ask-pulse

A pulsing dayglo banner that mounts directly above the omp `ask` dialog, so an agent
waiting on your input is impossible to miss in a wall of terminal panes.

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

Recolor by swapping the two pulse endpoints at the top of `src/ask-pulse.ts`. The default
is dayglo pink:

```ts
const DIM: RGB = [0x3d, 0x0a, 0x33]
const DAYGLO: RGB = [0xff, 0x10, 0xf0] // "dayglo pink"
```

Dayglo green: `DIM = [0x12, 0x3d, 0x0a]`, `DAYGLO = [0x39, 0xff, 0x14]`.

Other knobs: `PULSE_PERIOD_MS` (cycle length), `FRAME_MS` (tick rate),
`MAX_QUESTIONS`, `MAX_LINES_PER_QUESTION`.

## Degradation

- RPC/ACP modes only accept string-array widgets; every `setWidget` call is wrapped in
  try/catch and silently no-ops there.
- If `tool_execution_end` is skipped (Esc-aborted ask), `agent_end` and `session_shutdown`
  clear the banner.
- Colors are 24-bit truecolor; non-truecolor terminals approximate.
- All imports are type-only, so the module has zero runtime resolution cost.

## Local development

Point omp at a working copy instead of the published cache, then restart the session:

```
omp plugin link ./plugins/ask-pulse
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
