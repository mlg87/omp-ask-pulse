// Ask Pulse — pulsing dayglo "waiting for your input" banner for omp `ask` calls.
//
// WHY this is an extension and not a patch: the ask dialog's own border is painted with the
// static theme token `theme.fg("border", …)` in `src/modes/components/overlay-box.ts`, and
// `AskDialogComponent` is not exported from the public component barrel — there is no seam to
// animate it from outside. Patching the installed package would be erased by omp's several
// updates per day, which the user explicitly ruled out. So instead we mount an *adjacent*
// animated banner via the stable extension API. `~/.omp/agent/extensions/` is never touched by
// package updates, and every API used here is documented/public.
//
// Placement: `setWidget(..., { placement: "aboveEditor" })` mounts into `hookWidgetContainerAbove`,
// which renders immediately above `editorContainer`; the ask dialog is mounted *into*
// `editorContainer`. The banner therefore sits directly on top of the dialog for its whole life.
//
// Degradation contract:
//  - RPC/ACP modes only accept string-array widgets, so `setWidget` with a component factory can
//    throw there. Every call is wrapped in try/catch: silent no-op, never an error.
//  - If `tool_execution_end` is skipped (e.g. the user aborts the ask with Esc), `agent_end` and
//    `session_shutdown` clear the banner.
//  - Colors are emitted as 24-bit truecolor. Non-truecolor terminals approximate; nothing breaks.
//
// v1.2: the palette is configurable (see `loadConfig`) rather than a source edit, because a
// marketplace install lives in a read-only plugin cache that `omp plugin upgrade` overwrites.
//
// Package imports are type-only, so this file has ZERO runtime module resolution against the
// omp packages. That is deliberate: `~/.omp/agent/extensions/` sits outside any `node_modules`
// tree, and a bare runtime specifier resolves to bun's package *cache*, where
// `@oh-my-pi/pi-tui`'s native addon sibling is absent (verified: importing it there throws
// "Failed to load pi_natives native addon"). Text measuring and wrapping are therefore done
// locally with bun's own `stringWidth` instead of pi-tui's helpers. Runtime builtins are exempt
// from the rule above — `bun` and `node:*` resolve from the runtime, not from a package tree.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent"
import type { Component, TUI } from "@oh-my-pi/pi-tui"
import { stringWidth } from "bun"

const WIDGET_KEY = "ask-pulse"
const TITLE = " WAITING FOR YOUR INPUT "
const CONFIG_BASENAME = "ask-pulse.json"

// v1.6: 33ms (~30 fps) instead of 100ms. Perceptual mixing alone removes most of the banding, but
// a 10 fps step is visible as stutter on a slow fade, so the tick and the mixing were fixed together.
const FRAME_MS = 33 // render tick; phase is derived from wall clock, not from tick count
/**
 * Half-width of the caret wave's blend band, as a fraction of a segment (v1.6 idle mode). Wider =
 * a longer color gradient trailing the front; narrower = a hard edge that reads as a jump at 30 fps.
 */
const WAVE_SOFTNESS = 0.18
const MAX_QUESTIONS = 3
const MAX_LINES_PER_QUESTION = 3
const MIN_WIDTH = 8
const PREVIEW_MS = 4000

export type RGB = readonly [number, number, number]

/**
 * Resolved pulse appearance: the two interpolation endpoints, cycle length, and when to stop.
 * The pulse fades `colorB` (phase 0) → `colorA` (phase 1); the hold lock pins at `colorA`.
 */
interface Palette {
  colorB: RGB
  colorA: RGB
  periodMs: number
  /**
   * Milliseconds of pulsing before the banner locks at full brightness and the repaint tick is
   * killed. An unattended pane would otherwise repaint at ~30 Hz indefinitely; the locked bright
   * state is just as visible as the pulse once you finally look at the screen. `<= 0` never locks.
   */
  holdAfterMs: number
}

// v1.5: the pulse fades between two configurable colors; these are the omp-logo pink/cyan pair.
const DEFAULT_COLOR_A: RGB = [0xff, 0x10, 0xf0] // "dayglo pink"
const DEFAULT_COLOR_B: RGB = [0x0a, 0xf0, 0xff] // cyan
// v1.6: 2000ms, up from 1200ms. A slower cycle is what makes the fade read as smooth rather than
// as a throb; the user explicitly allowed trading speed for smoothness.
const DEFAULT_PERIOD_MS = 2000 // 0.5 Hz
const DEFAULT_HOLD_AFTER_MS = 30 * 60 * 1000

/** Named endpoints, so `/ask-pulse color pink` beats memorising a hex triplet. */
const PRESETS: Readonly<Record<string, RGB>> = {
  pink: DEFAULT_COLOR_A,
  green: [0x39, 0xff, 0x14],
  cyan: [0x0a, 0xf0, 0xff],
  amber: [0xff, 0xb0, 0x00],
  violet: [0xa9, 0x4c, 0xff],
  red: [0xff, 0x30, 0x3c],
}

/**
 * Fallback secondary endpoint: used when only one color is configured, so `/ask-pulse color green`
 * alone still means "green pulsing against dim green" (the pre-v1.5 behavior). 0.24 keeps the
 * trough visible on a dark terminal without competing with the theme's own borders.
 */
export function deriveDim(bright: RGB): RGB {
  return [Math.round(bright[0] * 0.24), Math.round(bright[1] * 0.24), Math.round(bright[2] * 0.24)]
}

/** Accepts `#rgb`, `#rrggbb`, either without the hash, or a {@link PRESETS} name. */
export function parseColor(raw: unknown): RGB | undefined {
  if (typeof raw !== "string") return undefined
  const value = raw.trim().toLowerCase()
  if (value === "") return undefined
  const preset = PRESETS[value]
  if (preset !== undefined) return preset

  const hex = value.startsWith("#") ? value.slice(1) : value
  if (hex.length === 3 && /^[0-9a-f]{3}$/.test(hex)) {
    const [r, g, b] = [...hex].map((c) => Number.parseInt(c + c, 16))
    return [r as number, g as number, b as number]
  }
  if (hex.length === 6 && /^[0-9a-f]{6}$/.test(hex)) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ]
  }
  return undefined
}

function toHex(color: RGB): string {
  return `#${color.map((c) => c.toString(16).padStart(2, "0")).join("")}`
}

/** The active profile's agent directory — `PI_CODING_AGENT_DIR` wins, matching omp's own resolution. */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent")
const USER_CONFIG_PATH = join(AGENT_DIR, CONFIG_BASENAME)

function readConfigFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {} // A hand-edited config with a typo must never break the ask dialog.
  }
}

/** Everything the runtime reads from disk: appearance plus the idle-pulse toggle. */
export interface PulseConfig {
  palette: Palette
  idle: boolean
}

/**
 * Precedence, lowest to highest: built-in default, user config, project config, environment.
 * Re-read on every mount, so an edit takes effect on the next turn rather than the next session
 * — a marketplace install cannot be source-edited, which is the whole point of this layer.
 */
export function loadConfig(cwd: string): PulseConfig {
  const sources = [
    readConfigFile(USER_CONFIG_PATH),
    readConfigFile(join(cwd, ".omp", CONFIG_BASENAME)),
    {
      color: process.env.ASK_PULSE_COLOR,
      color2: process.env.ASK_PULSE_COLOR2,
      periodMs: process.env.ASK_PULSE_PERIOD_MS,
      idle: process.env.ASK_PULSE_IDLE,
      holdAfterMs: process.env.ASK_PULSE_HOLD_AFTER_MS,
    },
  ]

  let colorA = DEFAULT_COLOR_A
  let colorASet = false
  let colorB: RGB | undefined // undefined = no source configured a secondary endpoint
  let periodMs = DEFAULT_PERIOD_MS
  let idle = true
  let holdAfterMs = DEFAULT_HOLD_AFTER_MS
  for (const source of sources) {
    const a = parseColor(source.color)
    if (a !== undefined) {
      colorA = a
      colorASet = true
    }
    const b = parseColor(source.color2)
    if (b !== undefined) colorB = b
    const period = Number(source.periodMs)
    if (Number.isFinite(period) && period >= 100) periodMs = period
    // Accept booleans from JSON and "0"/"false" from the environment, ignore anything else.
    if (typeof source.idle === "boolean") idle = source.idle
    else if (typeof source.idle === "string" && source.idle !== "") idle = !/^(0|false|off|no)$/i.test(source.idle)
    // `Number("")` is 0, which would mean "lock instantly" — an unset env var must not do that.
    if (source.holdAfterMs !== undefined && source.holdAfterMs !== "") {
      const hold = Number(source.holdAfterMs)
      if (Number.isFinite(hold)) holdAfterMs = hold
    }
  }
  // Only `color` set → keep the pre-v1.5 look (color ⇄ its own dim). Nothing set → the pink/cyan pair.
  const resolvedB = colorB ?? (colorASet ? deriveDim(colorA) : DEFAULT_COLOR_B)
  return { palette: { colorB: resolvedB, colorA, periodMs, holdAfterMs }, idle }
}

/** Persist a partial config to the user file, preserving unrelated keys. */
function writeUserConfig(patch: Record<string, unknown>): string {
  const merged = { ...readConfigFile(USER_CONFIG_PATH), ...patch }
  for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key]
  mkdirSync(AGENT_DIR, { recursive: true })
  writeFileSync(USER_CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`)
  return USER_CONFIG_PATH
}

/** sRGB channel (0–255) → linear-light [0,1]. */
function toLinear(channel: number): number {
  const x = channel / 255
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
}

/** Linear-light [0,1] → sRGB channel (0–255), clamped. */
function toSrgb(value: number): number {
  const x = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055
  return Math.round(Math.min(1, Math.max(0, x)) * 255)
}

/**
 * Perceptual mix: `t=0` → `from`, `t=1` → `to`, interpolated in OKLab.
 *
 * WHY not a per-channel RGB lerp (what v1.5 did): the default pink→cyan path passes through
 * desaturated gray at the midpoint, so the fade visibly dips to mud instead of staying dayglo.
 * OKLab is perceptually uniform, so the midpoint stays saturated and the ramp reads as even.
 * Matrices are Björn Ottosson's standard sRGB↔OKLab pair.
 *
 * Endpoints short-circuit so the roundtrip's rounding can never perturb them — callers and tests
 * rely on `t=0`/`t=1` being byte-exact palette colors.
 */
export function mixColors(from: RGB, to: RGB, t: number): RGB {
  if (t <= 0) return from
  if (t >= 1) return to

  const lab = (color: RGB): [number, number, number] => {
    const r = toLinear(color[0])
    const g = toLinear(color[1])
    const b = toLinear(color[2])
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ]
  }

  const [l0, a0, b0] = lab(from)
  const [l1, a1, b1] = lab(to)
  const L = l0 + (l1 - l0) * t
  const A = a0 + (a1 - a0) * t
  const B = b0 + (b1 - b0) * t

  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3
  return [
    toSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    toSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    toSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ]
}

/** Truecolor SGR wrapper — the single place the escape sequence shape is spelled out. */
function sgr(color: RGB, text: string): string {
  return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m${text}\x1b[39m`
}

/** Perceptual interpolation between the two endpoints, emitted as a truecolor SGR pair. */
function paint(text: string, t: number, palette: Palette): string {
  return sgr(mixColors(palette.colorB, palette.colorA, t), text)
}

/** One column of the idle caret wave: the glyph to draw and its position on the colorB→colorA ramp. */
interface WaveCell {
  glyph: string
  t: number
}

/**
 * Color ramp and flip state for the caret `i` steps in from its segment's *outer* edge (v1.6).
 *
 * The wave front `f` advances in the same normalised space as `q`, so a caret behind the front is
 * fully `colorA`, one ahead of it fully `colorB`, and the {@link WAVE_SOFTNESS} band between them
 * is smoothstepped — a linear band leaves a visible crease at the front on a dark terminal. The
 * glyph flips at the band's midpoint, which is where the color visibly changes over.
 */
function waveCell(i: number, n: number, f: number, normal: string, flipped: string): WaveCell {
  const q = (i + 0.5) / n
  const raw = Math.min(1, Math.max(0, (f - q + WAVE_SOFTNESS) / (2 * WAVE_SOFTNESS)))
  return { glyph: raw >= 0.5 ? flipped : normal, t: raw * raw * (3 - 2 * raw) }
}

/** Concatenate cells, emitting one SGR pair per maximal same-color run rather than per glyph. */
function paintCells(cells: readonly WaveCell[], palette: Palette): string {
  let out = ""
  let run = ""
  let runColor: RGB = [-1, -1, -1]
  for (const { glyph, t } of cells) {
    const color = mixColors(palette.colorB, palette.colorA, t)
    if (color[0] !== runColor[0] || color[1] !== runColor[1] || color[2] !== runColor[2]) {
      if (run !== "") out += sgr(runColor, run)
      run = ""
      runColor = color
    }
    run += glyph
  }
  return run === "" ? out : out + sgr(runColor, run)
}

/** Sine pulse in [0, 1] derived from wall-clock time so frames stay smooth regardless of tick jitter. */
function pulsePhase(periodMs: number): number {
  return (1 + Math.sin((Date.now() / periodMs) * 2 * Math.PI)) / 2
}

/**
 * Greedy word wrap for plain (ANSI-free) text. Overlong single words are hard-split so a pasted
 * URL can never blow past the box width and corrupt the frame.
 */
function wrapPlain(text: string, width: number): string[] {
  if (width < 1) return [text]
  const lines: string[] = []
  let current = ""
  for (const word of text.split(/\s+/)) {
    if (word === "") continue
    const candidate = current === "" ? word : `${current} ${word}`
    if (stringWidth(candidate) <= width) {
      current = candidate
      continue
    }
    if (current !== "") lines.push(current)
    let rest = word
    while (stringWidth(rest) > width) {
      let cut = 0
      while (cut < rest.length && stringWidth(rest.slice(0, cut + 1)) <= width) cut++
      lines.push(rest.slice(0, Math.max(1, cut)))
      rest = rest.slice(Math.max(1, cut))
    }
    current = rest
  }
  if (current !== "") lines.push(current)
  return lines
}

/** `event.args` is model-supplied and may be anything; extract question lines defensively. */
function extractQuestionLines(args: unknown): string[] {
  const questions = (args as { questions?: unknown } | null | undefined)?.questions
  if (!Array.isArray(questions)) return []

  const lines: string[] = []
  for (const entry of questions.slice(0, MAX_QUESTIONS)) {
    const record = entry as { question?: unknown; header?: unknown } | null
    const question = record?.question
    if (typeof question !== "string" || question.trim() === "") continue
    const header = typeof record?.header === "string" && record.header.trim() !== "" ? `[${record.header.trim()}] ` : ""
    lines.push(`${header}${question.trim()}`)
  }
  if (questions.length > MAX_QUESTIONS && lines.length > 0) {
    const extra = questions.length - MAX_QUESTIONS
    lines.push(`…and ${extra} more question${extra === 1 ? "" : "s"} on the dialog below`)
  }
  return lines
}

/** Subset of `Theme["boxRound"]` the banner draws with, so symbol presets are respected. */
interface BoxGlyphs {
  topLeft: string
  topRight: string
  bottomLeft: string
  bottomRight: string
  horizontal: string
  vertical: string
}

const FALLBACK_GLYPHS: BoxGlyphs = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
}

/**
 * Rounded box whose border color is recomputed on every render from the wall clock.
 * Wrapped content is cached per width so only the (cheap) paint pass runs per frame.
 */
export class AskPulseBanner implements Component {
  readonly #questions: readonly string[]
  readonly #glyphs: BoxGlyphs
  readonly #palette: Palette
  readonly #mountedAt = Date.now()
  #cachedWidth = -1
  #cachedBody: string[] = []

  constructor(questions: readonly string[], boxRound: BoxGlyphs, palette: Palette) {
    this.#questions = questions
    this.#glyphs = boxRound
    this.#palette = palette
  }

  /**
   * Whether the hold window has elapsed. Checked here rather than only in the extension's timer so
   * a later repaint — a resize, a re-layout — still paints the locked state after the tick is dead.
   */
  #locked(): boolean {
    const { holdAfterMs } = this.#palette
    return holdAfterMs > 0 && Date.now() - this.#mountedAt >= holdAfterMs
  }

  /** Box-mode phase for this frame, or a hard 1 once the hold window has elapsed. */
  #phase(): number {
    return this.#locked() ? 1 : pulsePhase(this.#palette.periodMs)
  }

  invalidate(): void {
    this.#cachedWidth = -1
    this.#cachedBody = []
  }

  /** Word-wrap each question to the inner width, capped, with an ellipsis on truncation. */
  #body(innerWidth: number): string[] {
    if (this.#cachedWidth === innerWidth) return this.#cachedBody
    const body: string[] = []
    for (const question of this.#questions) {
      const wrapped = wrapPlain(question, innerWidth)
      const kept = wrapped.slice(0, MAX_LINES_PER_QUESTION)
      if (wrapped.length > MAX_LINES_PER_QUESTION && kept.length > 0) {
        kept[kept.length - 1] = `${kept[kept.length - 1]}…`
      }
      body.push(...(kept.length > 0 ? kept : [""]))
    }
    this.#cachedWidth = innerWidth
    this.#cachedBody = body
    return body
  }

  render(width: number): readonly string[] {
    const palette = this.#palette
    // Degenerate terminals must not crash the render loop.
    if (width < MIN_WIDTH) return [paint(TITLE.trim(), this.#phase(), palette)]

    // Idle mode: no questions to show, so the banner collapses to a single titled rule that sits
    // directly above the editor without competing with the response text it follows. v1.6 replaces
    // the uniform horizontal rule with caret runs that a color wave sweeps inward from both edges
    // to the text and back out again, each caret flipping to point *with* the wave as it passes.
    if (this.#questions.length === 0) {
      const titleWidth = Math.min(stringWidth(TITLE), width)
      const left = Math.max(0, Math.floor((width - titleWidth) / 2))
      const right = Math.max(0, width - titleWidth - left)
      const locked = this.#locked()
      // Cosine ping-pong: the front runs edges→text over the first half period and back over the
      // second, with zero velocity at both turnarounds so the bounce reads as a bounce, not a snap.
      // The range overshoots [0, 1] by one softness half-width at each end so the extremes are
      // fully swept / fully reset instead of frozen mid-blend. Locked: front parked past the text.
      const u = (Date.now() % this.#palette.periodMs) / this.#palette.periodMs
      const f = locked ? 1 : -WAVE_SOFTNESS + (1 + 2 * WAVE_SOFTNESS) * ((1 - Math.cos(2 * Math.PI * u)) / 2)
      const cells: WaveCell[] = []
      // Locked carets stay unflipped — pointing inward at the text is the resting attention state.
      for (let i = 0; i < left; i++) cells.push(locked ? { glyph: ">", t: 1 } : waveCell(i, left, f, ">", "<"))
      for (const glyph of TITLE.slice(0, titleWidth)) cells.push({ glyph, t: f })
      // The right segment mirrors: its outer edge is the *last* column, so `i` counts back from it.
      for (let k = 0; k < right; k++) {
        cells.push(locked ? { glyph: "<", t: 1 } : waveCell(right - 1 - k, right, f, "<", ">"))
      }
      return [paintCells(cells, palette)]
    }

    const t = this.#phase()
    const { topLeft, topRight, bottomLeft, bottomRight, horizontal, vertical } = this.#glyphs
    const innerWidth = width - 4 // "│ " + content + " │"

    // Top rule with the title inset and centered.
    const ruleWidth = width - 2
    const titleWidth = Math.min(stringWidth(TITLE), ruleWidth)
    const title = TITLE.slice(0, titleWidth)
    const leftRule = Math.max(0, Math.floor((ruleWidth - titleWidth) / 2))
    const rightRule = Math.max(0, ruleWidth - titleWidth - leftRule)
    const top = paint(
      `${topLeft}${horizontal.repeat(leftRule)}${title}${horizontal.repeat(rightRule)}${topRight}`,
      t,
      palette,
    )

    const bar = paint(vertical, t, palette)
    const lines: string[] = [top]
    for (const line of this.#body(innerWidth)) {
      const pad = Math.max(0, innerWidth - stringWidth(line))
      // Title text stays readable: floor the phase at the midpoint so it biases toward `colorA`
      // (and, for a dim-derived palette, keeps the old readability guarantee).
      lines.push(`${bar} ${paint(line, Math.max(0.5, t), palette)}${" ".repeat(pad)} ${bar}`)
    }
    lines.push(paint(`${bottomLeft}${horizontal.repeat(ruleWidth)}${bottomRight}`, t, palette))
    return lines
  }
}

/** `1800000`, `30m`, `90s`, `2h` → milliseconds. `undefined` when it is not a duration at all. */
export function parseDuration(raw: string): number | undefined {
  const match = /^(-?\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(raw.trim())
  if (match === null) return undefined
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]?.toLowerCase() ?? "ms"] ?? 1
  return Number(match[1]) * scale
}

const USAGE = [
  "/ask-pulse show — print the active palette and where it came from",
  "/ask-pulse color <first> [second] — set the fade endpoints; one color pulses against its own dim",
  "/ask-pulse period <ms> — set the pulse cycle length (min 100)",
  "/ask-pulse idle <on|off> — pulse a rule above the editor whenever the agent yields the turn",
  "/ask-pulse hold <30m|0> — lock bright and stop animating after this long; 0 never locks",
  "/ask-pulse preview — mount the banner for a few seconds",
  "/ask-pulse reset — delete the user config",
].join("\n")

export default function askPulse(pi: ExtensionAPI) {
  pi.setLabel("Ask Pulse")

  let activeToolCallId: string | undefined
  let timer: Timer | undefined
  let holdTimer: Timer | undefined
  let mounted = false
  let tuiRef: TUI | undefined

  /** Stop the repaint tick and the hold deadline; the widget itself is left to the caller. */
  const stopTimers = (ctx: ExtensionContext): void => {
    if (timer !== undefined) {
      ctx.clearTimer(timer)
      timer = undefined
    }
    if (holdTimer !== undefined) {
      ctx.clearTimer(holdTimer)
      holdTimer = undefined
    }
  }

  const clear = (ctx: ExtensionContext): void => {
    if (!mounted) return // idempotent
    mounted = false
    activeToolCallId = undefined
    tuiRef = undefined
    stopTimers(ctx)
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined)
    } catch {
      // Widget surface unavailable (RPC/ACP or teardown) — nothing to clean up.
    }
  }

  /** Mount the banner and start the repaint tick. Returns false when the surface refuses it. */
  const mount = (ctx: ExtensionContext, questions: string[], palette: Palette): boolean => {
    try {
      ctx.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          tuiRef = tui
          // `theme` can be undefined under jiti / dual-module-graph installs (omp issue #5366,
          // the same hazard `dynamic-border.ts` guards). Degrade to glyphs, never crash the TUI.
          return new AskPulseBanner(questions, theme?.boxRound ?? FALLBACK_GLYPHS, palette)
        },
        { placement: "aboveEditor" },
      )
    } catch {
      return false // Component-factory widgets unsupported here; stay a silent no-op.
    }
    mounted = true
    // The tick only asks for a repaint; the pulse phase comes from the wall clock in render().
    timer = ctx.setInterval(() => tuiRef?.requestRender(), FRAME_MS)

    // Kill the tick once the banner locks bright: an unattended pane must not repaint at ~30 Hz
    // forever. `render()` re-derives the locked state from its own clock, so any later repaint
    // still paints bright.
    if (palette.holdAfterMs > 0) {
      holdTimer = ctx.setTimeout(() => {
        if (timer !== undefined) {
          ctx.clearTimer(timer)
          timer = undefined
        }
        holdTimer = undefined
        tuiRef?.requestRender() // one final frame, now at full brightness
      }, palette.holdAfterMs)
    }
    return true
  }

  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "ask" || !ctx.hasUI) return

    const questions = extractQuestionLines(event.args)
    if (questions.length === 0) questions.push("The agent is waiting for your answer.")

    if (!mount(ctx, questions, loadConfig(ctx.cwd).palette)) return
    activeToolCallId = event.toolCallId
  })

  // `ask` is concurrency-exclusive, so at most one is ever live — matching on either field is safe.
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolCallId === activeToolCallId || event.toolName === "ask") clear(ctx)
  })

  // The agent has yielded the turn: every path back to the user ends here, including a plain
  // prose answer that never called `ask`. An empty question list renders the one-line rule.
  pi.on("agent_end", (_event, ctx) => {
    clear(ctx) // also the safety net for an Esc-aborted ask, which skips `tool_execution_end`
    if (!ctx.hasUI) return
    const config = loadConfig(ctx.cwd)
    if (config.idle) mount(ctx, [], config.palette)
  })

  // The user answered, so the wait is over before any output appears.
  pi.on("agent_start", (_event, ctx) => clear(ctx))
  pi.on("session_shutdown", (_event, ctx) => clear(ctx))

  pi.registerCommand("ask-pulse", {
    description: "Configure the ask-pulse banner (color, period, preview)",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [subcommand = "show", ...rest] = args.trim().split(/\s+/).filter(Boolean)
      const value = rest.join(" ")
      const { palette, idle } = loadConfig(ctx.cwd)

      switch (subcommand) {
        case "show": {
          const projectPath = join(ctx.cwd, ".omp", CONFIG_BASENAME)
          const origins = [
            existsSync(USER_CONFIG_PATH) ? `user: ${USER_CONFIG_PATH}` : undefined,
            existsSync(projectPath) ? `project: ${projectPath}` : undefined,
            process.env.ASK_PULSE_COLOR !== undefined ? `env: ASK_PULSE_COLOR` : undefined,
            process.env.ASK_PULSE_COLOR2 !== undefined ? `env: ASK_PULSE_COLOR2` : undefined,
          ].filter(Boolean)
          ctx.ui.notify(
            `ask-pulse ${toHex(palette.colorA)} ⇄ ${toHex(palette.colorB)} @ ${palette.periodMs}ms, idle ${idle ? "on" : "off"}, hold ${palette.holdAfterMs > 0 ? `${palette.holdAfterMs}ms` : "never"}` +
              (origins.length > 0 ? ` (${origins.join(", ")})` : " (defaults)"),
          )
          return
        }
        case "idle": {
          if (!/^(on|off)$/i.test(value)) {
            ctx.ui.notify(`Usage: /ask-pulse idle <on|off> (got "${value}")`, "error")
            return
          }
          const enabled = value.toLowerCase() === "on"
          writeUserConfig({ idle: enabled })
          ctx.ui.notify(`ask-pulse idle → ${enabled ? "on" : "off"}`)
          return
        }
        case "hold": {
          const ms = parseDuration(value)
          if (ms === undefined) {
            ctx.ui.notify(`Usage: /ask-pulse hold <30m|90s|1800000|0> (got "${value}")`, "error")
            return
          }
          writeUserConfig({ holdAfterMs: ms })
          ctx.ui.notify(ms > 0 ? `ask-pulse holds bright after ${ms}ms` : "ask-pulse pulses indefinitely")
          return
        }
        case "color": {
          if (rest.length === 0 || rest.length > 2) {
            ctx.ui.notify(
              `Usage: /ask-pulse color <first> [second] — hex or preset (${Object.keys(PRESETS).join(" ")})`,
              "error",
            )
            return
          }
          const parsed: RGB[] = []
          for (const token of rest) {
            const color = parseColor(token)
            if (color === undefined) {
              ctx.ui.notify(
                `Unrecognized color "${token}". Use a hex value or: ${Object.keys(PRESETS).join(", ")}`,
                "error",
              )
              return
            }
            parsed.push(color)
          }
          const [first, second] = parsed as [RGB, RGB?]
          // `writeUserConfig` deletes undefined keys, so a lone color clears `color2` and restores
          // the dim-derived fallback rather than leaving a stale second endpoint behind.
          const path = writeUserConfig({ color: toHex(first), color2: second && toHex(second) })
          ctx.ui.notify(
            second === undefined
              ? `ask-pulse color → ${toHex(first)} (dim-derived pulse) (${path})`
              : `ask-pulse colors → ${toHex(first)} ⇄ ${toHex(second)} (${path})`,
          )
          return
        }
        case "period": {
          const ms = Number(value)
          if (!Number.isFinite(ms) || ms < 100) {
            ctx.ui.notify(`Period must be a number of milliseconds ≥ 100 (got "${value}")`, "error")
            return
          }
          writeUserConfig({ periodMs: ms })
          ctx.ui.notify(`ask-pulse period → ${ms}ms`)
          return
        }
        case "preview": {
          if (!ctx.hasUI) return
          clear(ctx)
          const label = `Preview — ${toHex(palette.colorA)} ⇄ ${toHex(palette.colorB)} @ ${palette.periodMs}ms`
          if (!mount(ctx, [label], palette)) return
          // No real ask is in flight, so nothing else will tear this down.
          ctx.setTimeout(() => clear(ctx), PREVIEW_MS)
          return
        }
        case "reset": {
          if (existsSync(USER_CONFIG_PATH)) rmSync(USER_CONFIG_PATH)
          ctx.ui.notify(
            `ask-pulse reset to ${toHex(DEFAULT_COLOR_A)} ⇄ ${toHex(DEFAULT_COLOR_B)} @ ${DEFAULT_PERIOD_MS}ms`,
          )
          return
        }
        default:
          ctx.ui.notify(`Unknown subcommand "${subcommand}".\n${USAGE}`, "warning")
      }
    },
  })
}
