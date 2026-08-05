# ask-pulse

A pulsing dayglo banner that mounts directly above the omp `ask` dialog, so an agent
waiting on your input is impossible to miss in a wall of terminal panes.

![what it does](#) <!-- drop a gif here -->

## Why an extension, not a patch

The ask dialog paints its own border with the static theme token `theme.fg("border", …)`
and `AskDialogComponent` is not exported from the public component barrel — there is no
seam to animate it from outside. Patching the installed package would be erased by omp's
several releases per day. So this mounts an *adjacent* animated banner through the stable
extension API (`pi.setWidget(..., { placement: "aboveEditor" })`), which renders immediately
above the editor container the dialog lives in.

## Install

```
/marketplace add masongoetz/omp-ask-pulse
/marketplace install ask-pulse@masongoetz
```

Restart the session — newly installed extension modules are loaded at startup.

Or, without the marketplace, drop `src/ask-pulse.ts` into `~/.omp/agent/extensions/`.

## Configuration

Recolor by swapping the two pulse endpoints at the top of `src/ask-pulse.ts`:

```ts
const DIM: RGB = [0x12, 0x3d, 0x0a]
const DAYGLO: RGB = [0x39, 0xff, 0x14] // "dayglo green"
```

Dayglo pink: `DIM = [0x3d, 0x0a, 0x33]`, `DAYGLO = [0xff, 0x10, 0xf0]`.

Other knobs: `PULSE_PERIOD_MS` (cycle length), `FRAME_MS` (tick rate),
`MAX_QUESTIONS`, `MAX_LINES_PER_QUESTION`.

## Degradation

- RPC/ACP modes only accept string-array widgets; every `setWidget` call is wrapped in
  try/catch and silently no-ops there.
- If `tool_execution_end` is skipped (Esc-aborted ask), `agent_end` and `session_shutdown`
  clear the banner.
- Colors are 24-bit truecolor; non-truecolor terminals approximate.
- All imports are type-only, so the module has zero runtime resolution cost.

## License

MIT
