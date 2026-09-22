// Obvi Plan — tint the whole terminal background while omp plan mode is active, and hand the
// terminal back to the user's own theme the moment plan mode ends.
//
// WHY the terminal background and not an omp theme: omp rejects `setTheme(ThemeObject)` from an
// extension, and a named theme swap would clobber the user's own theme choice and restore it by
// guesswork. OSC 11 instead changes the terminal's *default* background — every cell omp paints
// without an explicit background (most of the screen, scrollback included) turns the plan color at
// once, no repaint needed — and OSC 111 resets it to whatever the terminal profile configures. The
// user's theme is never read, stored, or rewritten, so "back to default" is exact by construction.
//
// Readability (`matchTheme`, on by default): omp's auto theme picks its `theme.dark` or
// `theme.light` slot from the luminance the terminal reports for OSC 11 (`docs/theme.md`), but only
// probes at startup, on Mode 2031 notifications, and on Ctrl+L. After every background change the
// extension asks the terminal to re-probe (`Terminal.refreshAppearance`), so a light tint like
// lilac flips omp to its light slot — dark text, readable — and the restore flips it back. omp
// applies that switch as ephemeral, so the user's saved theme settings are never touched. Users who
// pinned a single theme instead of auto keep it; the re-probe is then a no-op.
//
// Detection: omp has no plan-mode extension event. What it does do, on every transition (the `/plan`
// command, the mode-cycle keybinding, plan approval, session resume/switch), is append a
// `mode_change` entry to the session — `"plan"` on entry, `"none"` or `"plan_paused"` on exit —
// which is also what omp itself replays to restore the mode on resume. A cheap tick polls the
// session leaf id; only when it moves is the branch walked back to the nearest `mode_change`
// (see `ModeTracker`), so the steady-state cost is one O(1) call every `POLL_MS`.
//
// Degradation contract:
//  - Only runs with a UI and a TTY stdout: in RPC/ACP/print modes stdout is a protocol channel and
//    an escape sequence there would corrupt it.
//  - Terminals that ignore OSC 11/111 simply show no tint; nothing breaks.
//  - The reset is only ever written after this extension set a color, so a user's own OSC 11
//    customization is never clobbered while the extension is idle.
//  - `session_shutdown` and a process `exit` hook both reset, so quitting from inside plan mode
//    (or a crash that still unwinds) never leaves the shell lilac.
//
// Package imports are type-only (same rule as ask-pulse): the module resolves nothing from a
// package tree at runtime, so it works from `~/.omp/agent/extensions/` as well as a plugin cache.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent"
import type { TUI } from "@oh-my-pi/pi-tui"

const CONFIG_BASENAME = "obvi-plan.json"
/**
 * Zero-row widget whose only job is to hand the extension a live `TUI`, for `terminal.write` (so
 * the escape sequences share omp's own output path) and `terminal.refreshAppearance`.
 */
const PROBE_KEY = "obvi-plan-tui"
/** Shared empty-render result for the probe widget; reference identity signals "unchanged" to pi-tui. */
const EMPTY_ROWS: readonly string[] = []
/** Mode-poll tick. Steady state is one `getLeafId()` call, so a quarter second costs nothing. */
const POLL_MS = 250
const PREVIEW_MS = 3000

export type RGB = readonly [number, number, number]

/** Lilac (#c8a2c8): the built-in plan-mode background. */
export const DEFAULT_COLOR: RGB = [0xc8, 0xa2, 0xc8]

/** Named colors, so `/obvi-plan color plum` beats memorising a hex triplet. */
export const PRESETS: Readonly<Record<string, RGB>> = {
  lilac: DEFAULT_COLOR,
  lavender: [0xe6, 0xe6, 0xfa],
  mauve: [0xe0, 0xb0, 0xff],
  // Dark tints keep a dark omp theme's light text readable.
  plum: [0x3d, 0x2b, 0x4f],
  midnight: [0x1e, 0x1b, 0x3a],
}

/** Accepts `#rgb`, `#rrggbb`, either without the hash, or a {@link PRESETS} name. */
export function parseColor(raw: unknown): RGB | undefined {
  if (typeof raw !== "string") return undefined
  const value = raw.trim().toLowerCase()
  if (value === "") return undefined
  const preset = PRESETS[value]
  if (preset !== undefined) return preset

  const hex = value.startsWith("#") ? value.slice(1) : value
  if (/^[0-9a-f]{3}$/.test(hex)) {
    const [r, g, b] = [...hex].map((c) => Number.parseInt(c + c, 16))
    return [r as number, g as number, b as number]
  }
  if (/^[0-9a-f]{6}$/.test(hex)) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ]
  }
  return undefined
}

export function toHex(color: RGB): string {
  return `#${color.map((c) => c.toString(16).padStart(2, "0")).join("")}`
}

/**
 * OSC 11: set the terminal's default background. The X11 `rgb:rr/gg/bb` spelling is the one every
 * OSC 11 implementation parses (xterm, kitty, WezTerm, Ghostty, iTerm2, foot, VTE, tmux, Windows
 * Terminal); BEL-terminated for the same reason.
 */
export function setBackgroundSequence(color: RGB): string {
  const [r, g, b] = color.map((c) => c.toString(16).padStart(2, "0"))
  return `\x1b]11;rgb:${r}/${g}/${b}\x07`
}

/** OSC 111: reset the default background to the terminal profile's configured color. */
export const RESET_BACKGROUND = "\x1b]111\x07"

/** The active profile's agent directory — `PI_CODING_AGENT_DIR` wins, matching omp's own resolution. */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent")
const USER_CONFIG_PATH = join(AGENT_DIR, CONFIG_BASENAME)

function readConfigFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {} // A hand-edited config with a typo must never break the session.
  }
}

export interface ObviPlanConfig {
  color: RGB
  enabled: boolean
  /** Re-probe the terminal after each change so omp's auto theme follows the tint's luminance. */
  matchTheme: boolean
}

/** JSON booleans, or "0"/"false"/"off"/"no" (anything else non-empty is true) from the environment. */
function readFlag(raw: unknown): boolean | undefined {
  if (typeof raw === "boolean") return raw
  if (typeof raw === "string" && raw !== "") return !/^(0|false|off|no)$/i.test(raw)
  return undefined
}

/**
 * Precedence, lowest to highest: built-in default, user config, project config, environment.
 * Re-read on every plan-mode transition, so an edit lands the next time plan mode toggles.
 */
export function loadConfig(cwd: string): ObviPlanConfig {
  const sources = [
    readConfigFile(USER_CONFIG_PATH),
    readConfigFile(join(cwd, ".omp", CONFIG_BASENAME)),
    {
      color: process.env.OBVI_PLAN_COLOR,
      enabled: process.env.OBVI_PLAN_ENABLED,
      matchTheme: process.env.OBVI_PLAN_MATCH_THEME,
    },
  ]
  let color = DEFAULT_COLOR
  let enabled = true
  let matchTheme = true
  for (const source of sources) {
    const parsed = parseColor(source.color)
    if (parsed !== undefined) color = parsed
    enabled = readFlag(source.enabled) ?? enabled
    matchTheme = readFlag(source.matchTheme) ?? matchTheme
  }
  return { color, enabled, matchTheme }
}

/** Persist a partial config to the user file, preserving unrelated keys. */
function writeUserConfig(patch: Record<string, unknown>): string {
  const merged = { ...readConfigFile(USER_CONFIG_PATH), ...patch }
  mkdirSync(AGENT_DIR, { recursive: true })
  writeFileSync(USER_CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`)
  return USER_CONFIG_PATH
}

/** The slice of omp's `ReadonlySessionManager` the tracker walks. */
export interface SessionTree {
  getLeafId(): string | null
  getEntry(id: string): { type: string; parentId: string | null; mode?: unknown } | undefined
}

/**
 * Resolves the session's current mode the way omp does on resume — the last `mode_change` on the
 * branch from root to leaf — but incrementally: the leaf id and its mode are cached, so an unchanged
 * leaf costs nothing, and a new leaf walks back only until it meets a `mode_change` or the cached
 * leaf (every entry appended since is a descendant, so the cached answer still holds past it). A
 * branch switch misses the cache and walks to the root once.
 */
export class ModeTracker {
  #leafId: string | null | undefined // undefined = nothing resolved yet
  #mode = "none"

  /** Returns the resolved mode and whether it differs from the previous call's. */
  resolve(tree: SessionTree): { mode: string; changed: boolean } {
    const leafId = tree.getLeafId()
    if (leafId === this.#leafId) return { mode: this.#mode, changed: false }

    let mode = "none"
    let id = leafId
    while (id !== null) {
      if (id === this.#leafId) {
        mode = this.#mode
        break
      }
      const entry = tree.getEntry(id)
      if (entry === undefined) break
      if (entry.type === "mode_change" && typeof entry.mode === "string") {
        mode = entry.mode
        break
      }
      id = entry.parentId
    }
    const changed = mode !== this.#mode
    this.#leafId = leafId
    this.#mode = mode
    return { mode, changed }
  }

  /** Forget the cache, e.g. after a session switch. */
  reset(): void {
    this.#leafId = undefined
    this.#mode = "none"
  }
}

/**
 * Owns the terminal background. Writes only on a real change, and resets only a color it set
 * itself, so repeated `apply` calls are free and an idle extension never touches the terminal.
 */
export class Backdrop {
  readonly #write: (data: string) => void
  #applied: RGB | undefined

  constructor(write: (data: string) => void) {
    this.#write = write
  }

  get applied(): RGB | undefined {
    return this.#applied
  }

  /** `undefined` restores the terminal's own default background. Returns whether anything was written. */
  apply(color: RGB | undefined): boolean {
    const current = this.#applied
    if (color === undefined) {
      if (current === undefined) return false
      this.#applied = undefined
      this.#write(RESET_BACKGROUND)
      return true
    }
    if (current !== undefined && current[0] === color[0] && current[1] === color[1] && current[2] === color[2]) {
      return false
    }
    this.#applied = color
    this.#write(setBackgroundSequence(color))
    return true
  }
}

const USAGE = [
  "/obvi-plan show — print the active color and where it came from",
  `/obvi-plan color <hex|preset> — set the plan-mode background (presets: ${Object.keys(PRESETS).join(" ")})`,
  "/obvi-plan on|off — enable or disable the tint without uninstalling",
  "/obvi-plan theme on|off — let omp's auto theme follow the tint (light tint → light theme)",
  "/obvi-plan preview — show the color for a few seconds",
  "/obvi-plan reset — delete the user config (back to lilac)",
].join("\n")

export default function obviPlan(pi: ExtensionAPI) {
  pi.setLabel("Obvi Plan")

  const tracker = new ModeTracker()
  let tuiRef: TUI | undefined
  // Through omp's terminal while the TUI is up, so the write is ordered with the OSC 11 re-probe
  // that follows it; straight to stdout once the TUI is gone (session teardown, process exit).
  const backdrop = new Backdrop((data) => {
    try {
      if (tuiRef !== undefined) tuiRef.terminal.write(data)
      else process.stdout.write(data)
    } catch {
      // stdout closed during teardown — nothing left to tint.
    }
  })
  let latestCtx: ExtensionContext | undefined
  let poller: Timer | undefined
  let previewTimer: Timer | undefined
  let inPlanMode = false
  let config: ObviPlanConfig | undefined
  /**
   * Whether omp's auto theme was last re-probed against a tint. Once true, the restore re-probes
   * even if matching was switched off meanwhile — otherwise omp would keep the light slot over the
   * user's dark background.
   */
  let themeShifted = false

  // Last-resort reset: a process exit that skips `session_shutdown` must not leave the shell tinted.
  // Synchronous on a TTY, which is the only case `usable` lets through.
  process.once("exit", () => {
    tuiRef = undefined
    backdrop.apply(undefined)
  })

  const usable = (ctx: ExtensionContext): boolean => ctx.hasUI && process.stdout.isTTY === true

  /** Mount the zero-row probe widget once to capture the live `TUI`. Its factory runs synchronously. */
  const ensureTui = (ctx: ExtensionContext): void => {
    if (tuiRef !== undefined) return
    try {
      ctx.ui.setWidget(
        PROBE_KEY,
        (tui: TUI) => {
          tuiRef = tui
          return { render: () => EMPTY_ROWS, invalidate() {} }
        },
        { placement: "aboveEditor" },
      )
    } catch {
      // Widget surface unavailable — fall back to stdout writes and skip theme matching.
    }
  }

  /** Set or clear the tint, then let omp's auto theme re-read the new background's luminance. */
  const paint = (color: RGB | undefined, matchTheme: boolean): void => {
    if (!backdrop.apply(color)) return
    const follow = matchTheme || themeShifted
    themeShifted = follow && color !== undefined
    if (follow) reprobe()
  }

  /** Ask the terminal for its background again; omp's auto theme re-evaluates on the reply. */
  const reprobe = (): void => {
    try {
      tuiRef?.terminal.refreshAppearance?.()
    } catch {
      // Older pi-tui or a torn-down terminal — the tint still applies, only the theme stays put.
    }
  }

  /** Paint the background the current state calls for; a no-op when nothing changed. */
  const render = (ctx: ExtensionContext): void => {
    if (previewTimer !== undefined) return // a preview owns the background until it ends
    config ??= loadConfig(ctx.cwd)
    paint(inPlanMode && config.enabled ? config.color : undefined, config.matchTheme)
  }

  const poll = (): void => {
    const ctx = latestCtx
    if (ctx === undefined || !usable(ctx)) return
    try {
      const { mode, changed } = tracker.resolve(ctx.sessionManager)
      if (!changed) return
      inPlanMode = mode === "plan"
      config = loadConfig(ctx.cwd) // re-read per transition so a hand edit lands on the next toggle
      render(ctx)
    } catch {
      // omp internals moved — silent no-op rather than an error every tick.
    }
  }

  /** Adopt the freshest context and make sure the poll tick is running. */
  const attach = (ctx: ExtensionContext): void => {
    latestCtx = ctx
    if (!usable(ctx)) return
    ensureTui(ctx)
    if (poller === undefined) poller = ctx.setInterval(poll, POLL_MS)
    poll()
  }

  pi.on("session_start", (_event, ctx) => attach(ctx))
  pi.on("session_switch", (_event, ctx) => {
    tracker.reset()
    attach(ctx)
  })
  pi.on("session_branch", (_event, ctx) => attach(ctx))
  pi.on("session_tree", (_event, ctx) => attach(ctx))
  // Belt and braces: any turn boundary re-checks immediately instead of waiting for the tick.
  pi.on("agent_start", (_event, ctx) => attach(ctx))
  pi.on("agent_end", (_event, ctx) => attach(ctx))

  pi.on("session_shutdown", (_event, ctx) => {
    if (poller !== undefined) ctx.clearTimer(poller)
    if (previewTimer !== undefined) ctx.clearTimer(previewTimer)
    poller = undefined
    previewTimer = undefined
    latestCtx = undefined
    tracker.reset()
    inPlanMode = false
    themeShifted = false
    tuiRef = undefined // the TUI is being torn down: write the reset straight to stdout, no re-probe
    backdrop.apply(undefined)
  })

  pi.registerCommand("obvi-plan", {
    description: "Configure the plan-mode background color",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const [subcommand = "show", ...rest] = args.trim().split(/\s+/).filter(Boolean)
      const value = rest.join(" ")
      attach(ctx)

      switch (subcommand) {
        case "show": {
          const current = loadConfig(ctx.cwd)
          const projectPath = join(ctx.cwd, ".omp", CONFIG_BASENAME)
          const origins = [
            existsSync(USER_CONFIG_PATH) ? `user: ${USER_CONFIG_PATH}` : undefined,
            existsSync(projectPath) ? `project: ${projectPath}` : undefined,
            process.env.OBVI_PLAN_COLOR !== undefined ? "env: OBVI_PLAN_COLOR" : undefined,
            process.env.OBVI_PLAN_ENABLED !== undefined ? "env: OBVI_PLAN_ENABLED" : undefined,
            process.env.OBVI_PLAN_MATCH_THEME !== undefined ? "env: OBVI_PLAN_MATCH_THEME" : undefined,
          ].filter(Boolean)
          ctx.ui.notify(
            `obvi-plan ${toHex(current.color)}, ${current.enabled ? "on" : "off"}, theme matching ${current.matchTheme ? "on" : "off"}, plan mode ${inPlanMode ? "active" : "inactive"}` +
              (origins.length > 0 ? ` (${origins.join(", ")})` : " (defaults)"),
          )
          return
        }
        case "color": {
          const color = parseColor(value)
          if (color === undefined) {
            ctx.ui.notify(
              `Unrecognized color "${value}". Use a hex value or: ${Object.keys(PRESETS).join(", ")}`,
              "error",
            )
            return
          }
          const path = writeUserConfig({ color: toHex(color) })
          config = loadConfig(ctx.cwd)
          render(ctx)
          ctx.ui.notify(`obvi-plan color → ${toHex(color)} (${path})`)
          return
        }
        case "on":
        case "off": {
          writeUserConfig({ enabled: subcommand === "on" })
          config = loadConfig(ctx.cwd)
          render(ctx)
          ctx.ui.notify(`obvi-plan → ${subcommand}`)
          return
        }
        case "theme": {
          if (!/^(on|off)$/i.test(value)) {
            ctx.ui.notify(`Usage: /obvi-plan theme <on|off> (got "${value}")`, "error")
            return
          }
          const matchTheme = value.toLowerCase() === "on"
          writeUserConfig({ matchTheme })
          config = loadConfig(ctx.cwd)
          // Switching on mid-plan re-probes now instead of waiting for a toggle. Switching off cannot
          // un-shift a theme while the tint is still up (a re-probe would read the tint again); the
          // restore at plan exit re-probes regardless, via `themeShifted`.
          if (matchTheme && backdrop.applied !== undefined) {
            themeShifted = true
            reprobe()
          }
          ctx.ui.notify(`obvi-plan theme matching → ${matchTheme ? "on" : "off"}`)
          return
        }
        case "preview": {
          if (!usable(ctx)) return
          if (previewTimer !== undefined) ctx.clearTimer(previewTimer)
          const { color, matchTheme } = loadConfig(ctx.cwd)
          paint(color, matchTheme)
          previewTimer = ctx.setTimeout(() => {
            previewTimer = undefined
            render(ctx)
          }, PREVIEW_MS)
          ctx.ui.notify(`obvi-plan preview — ${toHex(color)}`)
          return
        }
        case "reset": {
          if (existsSync(USER_CONFIG_PATH)) rmSync(USER_CONFIG_PATH)
          config = loadConfig(ctx.cwd)
          render(ctx)
          ctx.ui.notify(`obvi-plan reset to lilac ${toHex(DEFAULT_COLOR)}`)
          return
        }
        default:
          ctx.ui.notify(`Unknown subcommand "${subcommand}".\n${USAGE}`, "warning")
      }
    },
  })
}
