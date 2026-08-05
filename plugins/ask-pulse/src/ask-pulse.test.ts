// Palette resolution and banner geometry. `AGENT_DIR` is resolved once at module init, so
// `PI_CODING_AGENT_DIR` must be set before the module under test is imported — hence the
// dynamic import below, which is also why this suite owns the env instead of a fixture.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const workspace = mkdtempSync(join(tmpdir(), "ask-pulse-"))
const agentDir = join(workspace, "agent")
const projectDir = join(workspace, "project")
mkdirSync(join(projectDir, ".omp"), { recursive: true })
mkdirSync(agentDir, { recursive: true })
process.env.PI_CODING_AGENT_DIR = agentDir
delete process.env.ASK_PULSE_COLOR
delete process.env.ASK_PULSE_PERIOD_MS

// Dynamic: the module reads PI_CODING_AGENT_DIR at init, which the lines above must win.
const { parseColor, deriveDim, loadConfig, AskPulseBanner } = await import("./ask-pulse.ts")

const hex = (color: readonly number[]) => `#${color.map((c) => c.toString(16).padStart(2, "0")).join("")}`
const userConfig = join(agentDir, "ask-pulse.json")
const projectConfig = join(projectDir, ".omp", "ask-pulse.json")

afterAll(() => rmSync(workspace, { recursive: true, force: true }))

describe("parseColor", () => {
  test("accepts hex with and without the hash", () => {
    expect(parseColor("#ff10f0")).toEqual([0xff, 0x10, 0xf0])
    expect(parseColor("ff10f0")).toEqual([0xff, 0x10, 0xf0])
  })

  test("expands three-digit shorthand", () => {
    expect(parseColor("#f1f")).toEqual([0xff, 0x11, 0xff])
  })

  test("resolves preset names case-insensitively", () => {
    expect(parseColor("GREEN")).toEqual([0x39, 0xff, 0x14])
  })

  test("rejects unknown names, malformed hex, and non-strings", () => {
    expect(parseColor("mauve")).toBeUndefined()
    expect(parseColor("#ff10f")).toBeUndefined()
    expect(parseColor(42)).toBeUndefined()
    expect(parseColor(undefined)).toBeUndefined()
  })
})

test("deriveDim scales every channel to 24%", () => {
  // 0xf0 * 0.24 = 57.6, which must round up to 0x3a rather than truncate.
  expect(hex(deriveDim([0xff, 0x10, 0xf0]))).toBe("#3d043a")
})

describe("loadConfig precedence", () => {
  beforeAll(() => {
    rmSync(userConfig, { force: true })
    rmSync(projectConfig, { force: true })
  })

  test("falls back to the built-in dayglo pink", () => {
    const palette = loadConfig(projectDir).palette
    expect(hex(palette.bright)).toBe("#ff10f0")
    expect(palette.periodMs).toBe(1200)
  })

  test("user config beats the default", () => {
    writeFileSync(userConfig, JSON.stringify({ color: "green", periodMs: 800 }))
    const palette = loadConfig(projectDir).palette
    expect(hex(palette.bright)).toBe("#39ff14")
    expect(palette.periodMs).toBe(800)
  })

  test("project config beats user config, per field", () => {
    writeFileSync(projectConfig, JSON.stringify({ color: "cyan" }))
    const palette = loadConfig(projectDir).palette
    expect(hex(palette.bright)).toBe("#0af0ff")
    expect(palette.periodMs).toBe(800) // untouched by the project file
  })

  test("environment beats every file", () => {
    process.env.ASK_PULSE_COLOR = "#123456"
    expect(hex(loadConfig(projectDir).palette.bright)).toBe("#123456")
    delete process.env.ASK_PULSE_COLOR
  })

  test("malformed JSON is ignored rather than fatal", () => {
    writeFileSync(projectConfig, "{ not json")
    expect(hex(loadConfig(projectDir).palette.bright)).toBe("#39ff14") // user config still applies
  })

  test("unparseable colors and sub-100ms periods are ignored", () => {
    writeFileSync(projectConfig, JSON.stringify({ color: "nonsense", periodMs: 5 }))
    const palette = loadConfig(projectDir).palette
    expect(hex(palette.bright)).toBe("#39ff14")
    expect(palette.periodMs).toBe(800)
  })
})

describe("loadConfig idle toggle", () => {
  beforeAll(() => {
    rmSync(userConfig, { force: true })
    rmSync(projectConfig, { force: true })
    delete process.env.ASK_PULSE_IDLE
  })

  test("defaults to on, because the whole point is not missing a yielded turn", () => {
    expect(loadConfig(projectDir).idle).toBe(true)
  })

  test("a JSON boolean turns it off", () => {
    writeFileSync(userConfig, JSON.stringify({ idle: false }))
    expect(loadConfig(projectDir).idle).toBe(false)
  })

  test("the environment accepts the usual falsey spellings and overrides the file", () => {
    for (const off of ["0", "false", "off", "no", "OFF"]) {
      process.env.ASK_PULSE_IDLE = off
      expect(loadConfig(projectDir).idle).toBe(false)
    }
    process.env.ASK_PULSE_IDLE = "1"
    expect(loadConfig(projectDir).idle).toBe(true) // beats the `idle: false` user config
    delete process.env.ASK_PULSE_IDLE
    rmSync(userConfig, { force: true })
  })
})

describe("AskPulseBanner.render", () => {
  const glyphs = {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
  }
  const palette = { dim: [0x3d, 0x04, 0x3a], bright: [0xff, 0x10, 0xf0], periodMs: 1200 } as const
  const banner = new AskPulseBanner(["Apply the migration?"], glyphs, palette)
  // ESC is assembled at runtime: a literal escape in a regex trips lint/suspicious/noControlCharactersInRegex.
  const ESC = String.fromCharCode(0x1b)
  const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, "g")
  const TRUECOLOR = new RegExp(`${ESC}\\[38;2;(\\d+);(\\d+);(\\d+)m`, "g")
  const plain = (line: string) => line.replaceAll(SGR, "")

  test("draws a closed box at exactly the requested width", () => {
    const lines = banner.render(40) as string[]
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(Bun.stringWidth(plain(line))).toBe(40)
    expect(plain(lines[0] as string)).toContain("WAITING FOR YOUR INPUT")
  })

  test("emits only colors on the dim→bright segment", () => {
    const lines = (banner.render(40) as string[]).join("")
    const triplets = [...lines.matchAll(TRUECOLOR)].map((m) => m.slice(1).map(Number))
    expect(triplets.length).toBeGreaterThan(0)
    for (const [r, g, b] of triplets as number[][]) {
      const t = ((r as number) - palette.dim[0]) / (palette.bright[0] - palette.dim[0])
      expect(t).toBeGreaterThanOrEqual(-0.01)
      expect(t).toBeLessThanOrEqual(1.01)
      expect(g).toBeCloseTo(palette.dim[1] + (palette.bright[1] - palette.dim[1]) * t, 0)
      expect(b).toBeCloseTo(palette.dim[2] + (palette.bright[2] - palette.dim[2]) * t, 0)
    }
  })

  test("degrades to a single line instead of throwing on a hostile width", () => {
    expect(banner.render(4)).toHaveLength(1)
  })

  test("wraps and truncates a question that overruns the cap", () => {
    const long = new AskPulseBanner([`${"word ".repeat(60)}end`], glyphs, palette)
    const lines = long.render(40) as string[]
    expect(lines).toHaveLength(5) // top rule + 3 body lines (the cap) + bottom rule
    expect(plain(lines[3] as string)).toContain("…")
  })

  test("collapses to one full-width titled rule when there are no questions", () => {
    const idle = new AskPulseBanner([], glyphs, palette)
    const lines = idle.render(40) as string[]
    expect(lines).toHaveLength(1)
    const only = plain(lines[0] as string)
    expect(Bun.stringWidth(only)).toBe(40)
    expect(only).toContain("WAITING FOR YOUR INPUT")
    // A rule, not a box: no corner glyphs anywhere on the line.
    expect(only).not.toContain(glyphs.topLeft)
    expect(only).not.toContain(glyphs.topRight)
    expect(only.startsWith(glyphs.horizontal)).toBe(true)
  })
})
