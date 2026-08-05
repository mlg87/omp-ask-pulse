// Ask Pulse — pulsing dayglo-green "waiting for your input" banner for omp `ask` calls.
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
//    `session_shutdown` clear the banner. Worst case it lingers until the turn ends.
//  - Colors are emitted as 24-bit truecolor. Non-truecolor terminals approximate; nothing breaks.
//
// All imports are type-only, so this file has ZERO runtime module resolution. That is deliberate:
// `~/.omp/agent/extensions/` sits outside any `node_modules` tree, and a bare runtime specifier
// resolves to bun's package *cache*, where `@oh-my-pi/pi-tui`'s native addon sibling is absent
// (verified: importing it there throws "Failed to load pi_natives native addon"). Text measuring
// and wrapping are therefore done locally with `Bun.stringWidth` instead of pi-tui's helpers.
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent"
import type { Component, TUI } from "@oh-my-pi/pi-tui"

const WIDGET_KEY = "ask-pulse"
const TITLE = " WAITING FOR YOUR INPUT "

// Pulse endpoints. Swap these two to recolor the whole banner.
const DIM: RGB = [0x12, 0x3d, 0x0a]
const DAYGLO: RGB = [0x39, 0xff, 0x14] // "dayglo green"

const PULSE_PERIOD_MS = 1200 // ~0.83 Hz
const FRAME_MS = 100 // render tick; phase is derived from wall clock, not from tick count
const MAX_QUESTIONS = 3
const MAX_LINES_PER_QUESTION = 3
const MIN_WIDTH = 8

type RGB = readonly [number, number, number]

/** Linear per-channel interpolation, emitted as a truecolor SGR pair. */
function paint(text: string, t: number): string {
  const r = Math.round(DIM[0] + (DAYGLO[0] - DIM[0]) * t)
  const g = Math.round(DIM[1] + (DAYGLO[1] - DIM[1]) * t)
  const b = Math.round(DIM[2] + (DAYGLO[2] - DIM[2]) * t)
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`
}

/** Sine pulse in [0, 1] derived from wall-clock time so frames stay smooth regardless of tick jitter. */
function pulsePhase(): number {
  return (1 + Math.sin((Date.now() / PULSE_PERIOD_MS) * 2 * Math.PI)) / 2
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
    if (Bun.stringWidth(candidate) <= width) {
      current = candidate
      continue
    }
    if (current !== "") lines.push(current)
    let rest = word
    while (Bun.stringWidth(rest) > width) {
      let cut = 0
      while (cut < rest.length && Bun.stringWidth(rest.slice(0, cut + 1)) <= width) cut++
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
class AskPulseBanner implements Component {
  readonly #questions: readonly string[]
  readonly #glyphs: BoxGlyphs
  #cachedWidth = -1
  #cachedBody: string[] = []

  constructor(questions: readonly string[], boxRound: BoxGlyphs) {
    this.#questions = questions
    this.#glyphs = boxRound
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
    // Degenerate terminals must not crash the render loop.
    if (width < MIN_WIDTH) return [paint(TITLE.trim(), pulsePhase())]

    const t = pulsePhase()
    const { topLeft, topRight, bottomLeft, bottomRight, horizontal, vertical } = this.#glyphs
    const innerWidth = width - 4 // "│ " + content + " │"

    // Top rule with the title inset and centered.
    const ruleWidth = width - 2
    const titleWidth = Math.min(Bun.stringWidth(TITLE), ruleWidth)
    const title = TITLE.slice(0, titleWidth)
    const leftRule = Math.max(0, Math.floor((ruleWidth - titleWidth) / 2))
    const rightRule = Math.max(0, ruleWidth - titleWidth - leftRule)
    const top = paint(
      `${topLeft}${horizontal.repeat(leftRule)}${title}${horizontal.repeat(rightRule)}${topRight}`,
      t,
    )

    const bar = paint(vertical, t)
    const lines: string[] = [top]
    for (const line of this.#body(innerWidth)) {
      const pad = Math.max(0, innerWidth - Bun.stringWidth(line))
      // Title text stays readable: floor its brightness at the midpoint of the pulse.
      lines.push(`${bar} ${paint(line, Math.max(0.5, t))}${" ".repeat(pad)} ${bar}`)
    }
    lines.push(paint(`${bottomLeft}${horizontal.repeat(ruleWidth)}${bottomRight}`, t))
    return lines
  }
}

export default function askPulse(pi: ExtensionAPI) {
  pi.setLabel("Ask Pulse")

  let activeToolCallId: string | undefined
  let timer: Timer | undefined
  let tuiRef: TUI | undefined

  const clear = (ctx: ExtensionContext): void => {
    if (activeToolCallId === undefined && timer === undefined) return // idempotent
    activeToolCallId = undefined
    tuiRef = undefined
    if (timer !== undefined) {
      ctx.clearTimer(timer)
      timer = undefined
    }
    try {
      ctx.ui.setWidget(WIDGET_KEY, undefined)
    } catch {
      // Widget surface unavailable (RPC/ACP or teardown) — nothing to clean up.
    }
  }

  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "ask" || !ctx.hasUI) return

    const questions = extractQuestionLines(event.args)
    if (questions.length === 0) questions.push("The agent is waiting for your answer.")

    try {
      ctx.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          tuiRef = tui
          // `theme` can be undefined under jiti / dual-module-graph installs (omp issue #5366,
          // the same hazard `dynamic-border.ts` guards). Degrade to glyphs, never crash the TUI.
          return new AskPulseBanner(questions, theme?.boxRound ?? FALLBACK_GLYPHS)
        },
        { placement: "aboveEditor" },
      )
    } catch {
      return // Component-factory widgets unsupported here; stay a silent no-op.
    }

    activeToolCallId = event.toolCallId
    // The tick only asks for a repaint; the pulse phase comes from the wall clock in render().
    timer = ctx.setInterval(() => tuiRef?.requestRender(), FRAME_MS)
  })

  // `ask` is concurrency-exclusive, so at most one is ever live — matching on either field is safe.
  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolCallId === activeToolCallId || event.toolName === "ask") clear(ctx)
  })

  // Safety nets: an aborted ask (Esc) does not necessarily emit `tool_execution_end`.
  pi.on("agent_end", (_event, ctx) => clear(ctx))
  pi.on("session_shutdown", (_event, ctx) => clear(ctx))
}
