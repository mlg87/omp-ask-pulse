// Palette resolution and banner geometry. `AGENT_DIR` is resolved once at module init, so
// `PI_CODING_AGENT_DIR` must be set before the module under test is imported — hence the
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test"
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
delete process.env.ASK_PULSE_COLOR2
delete process.env.ASK_PULSE_PERIOD_MS

// Dynamic: the module reads PI_CODING_AGENT_DIR at init, which the lines above must win.
const { parseColor, deriveDim, parseDuration, loadConfig, AskPulseBanner } = await import("./ask-pulse.ts")

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

describe("parseDuration", () => {
  test("reads bare milliseconds and unit suffixes", () => {
    expect(parseDuration("1800000")).toBe(1_800_000)
    expect(parseDuration("30m")).toBe(1_800_000)
    expect(parseDuration("90s")).toBe(90_000)
    expect(parseDuration("2h")).toBe(7_200_000)
    expect(parseDuration(" 250ms ")).toBe(250)
    expect(parseDuration("1.5m")).toBe(90_000)
  })

  test("keeps 0 and negatives, which mean 'never lock'", () => {
    expect(parseDuration("0")).toBe(0)
    expect(parseDuration("-1")).toBe(-1)
  })

  test("rejects junk rather than silently meaning zero", () => {
    for (const junk of ["", "soon", "30x", "m30", "3 0m"]) expect(parseDuration(junk)).toBeUndefined()
  })
})

describe("loadConfig holdAfterMs", () => {
  beforeAll(() => {
    rmSync(userConfig, { force: true })
    rmSync(projectConfig, { force: true })
    delete process.env.ASK_PULSE_HOLD_AFTER_MS
  })

  test("defaults to 30 minutes", () => {
    expect(loadConfig(projectDir).palette.holdAfterMs).toBe(1_800_000)
  })

  test("an empty environment variable does not mean 'lock instantly'", () => {
    process.env.ASK_PULSE_HOLD_AFTER_MS = ""
    expect(loadConfig(projectDir).palette.holdAfterMs).toBe(1_800_000)
    delete process.env.ASK_PULSE_HOLD_AFTER_MS
  })

  test("takes 0 from a config file to disable the lock", () => {
    writeFileSync(userConfig, JSON.stringify({ holdAfterMs: 0 }))
    expect(loadConfig(projectDir).palette.holdAfterMs).toBe(0)
    rmSync(userConfig, { force: true })
  })
})
describe("loadConfig precedence", () => {
  beforeAll(() => {
    rmSync(userConfig, { force: true })
    rmSync(projectConfig, { force: true })
  })

  test("falls back to the built-in pink ⇄ cyan pair", () => {
    const palette = loadConfig(projectDir).palette
    expect(hex(palette.colorA)).toBe("#ff10f0")
    expect(hex(palette.colorB)).toBe("#0af0ff")
    expect(palette.periodMs).toBe(1200)
  })

  test("user config beats the default, and a lone color pulses against its own dim", () => {
    writeFileSync(userConfig, JSON.stringify({ color: "green", periodMs: 800 }))
    const palette = loadConfig(projectDir).palette
    expect(hex(palette.colorA)).toBe("#39ff14")
    // Backward-compat contract: pre-v1.5 single-color configs keep their derived-dim trough.
    expect(hex(palette.colorB)).toBe(hex(deriveDim([0x39, 0xff, 0x14])))
    expect(palette.periodMs).toBe(800)
  })

  test("project config beats user config, per field", () => {
    writeFileSync(projectConfig, JSON.stringify({ color: "cyan" }))
    const palette = loadConfig(projectDir).palette
    expect(hex(palette.colorA)).toBe("#0af0ff")
    expect(palette.periodMs).toBe(800) // untouched by the project file
  })

  test("environment beats every file", () => {
    process.env.ASK_PULSE_COLOR = "#123456"
    expect(hex(loadConfig(projectDir).palette.colorA)).toBe("#123456")
    delete process.env.ASK_PULSE_COLOR
  })

  test("malformed JSON is ignored rather than fatal", () => {
    writeFileSync(projectConfig, "{ not json")
    expect(hex(loadConfig(projectDir).palette.colorA)).toBe("#39ff14") // user config still applies
  })

  test("unparseable colors and sub-100ms periods are ignored", () => {
    writeFileSync(projectConfig, JSON.stringify({ color: "nonsense", periodMs: 5 }))
    const palette = loadConfig(projectDir).palette
    expect(hex(palette.colorA)).toBe("#39ff14")
    expect(palette.periodMs).toBe(800)
  })

  test("color2 in a config file sets an explicit pair instead of the derived dim", () => {
    rmSync(projectConfig, { force: true })
    writeFileSync(userConfig, JSON.stringify({ color: "pink", color2: "cyan" }))
    const palette = loadConfig(projectDir).palette
    expect(hex(palette.colorA)).toBe("#ff10f0")
    expect(hex(palette.colorB)).toBe("#0af0ff")
  })

  test("ASK_PULSE_COLOR2 beats a file color2", () => {
    writeFileSync(userConfig, JSON.stringify({ color: "pink", color2: "cyan" }))
    process.env.ASK_PULSE_COLOR2 = "#123456"
    expect(hex(loadConfig(projectDir).palette.colorB)).toBe("#123456")
    delete process.env.ASK_PULSE_COLOR2
  })

  test("an unparseable color2 falls through to the derived dim", () => {
    writeFileSync(userConfig, JSON.stringify({ color: "green", color2: "mauve" }))
    const palette = loadConfig(projectDir).palette
    expect(hex(palette.colorB)).toBe(hex(deriveDim([0x39, 0xff, 0x14])))
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
  const palette = { colorB: [0x3d, 0x04, 0x3a], colorA: [0xff, 0x10, 0xf0], periodMs: 1200, holdAfterMs: 0 } as const
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

  test("emits only colors on the colorB→colorA segment", () => {
    const lines = (banner.render(40) as string[]).join("")
    const triplets = [...lines.matchAll(TRUECOLOR)].map((m) => m.slice(1).map(Number))
    expect(triplets.length).toBeGreaterThan(0)
    for (const [r, g, b] of triplets as number[][]) {
      const t = ((r as number) - palette.colorB[0]) / (palette.colorA[0] - palette.colorB[0])
      expect(t).toBeGreaterThanOrEqual(-0.01)
      expect(t).toBeLessThanOrEqual(1.01)
      // ±1, not ±0.5: `t` is recovered from an already-rounded red channel, so its own ±0.5
      // rounding error propagates into the predicted green/blue on top of their own rounding.
      expect(
        Math.abs((g as number) - (palette.colorB[1] + (palette.colorA[1] - palette.colorB[1]) * t)),
      ).toBeLessThanOrEqual(1)
      expect(
        Math.abs((b as number) - (palette.colorB[2] + (palette.colorA[2] - palette.colorB[2]) * t)),
      ).toBeLessThanOrEqual(1)
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

  // The banner derives its phase from `Date.now()`, so the clock is the only input worth
  // controlling here — no sleeps, and the assertions are exact rather than "roughly bright".
  describe("hold window", () => {
    // A whole number of 1200ms periods, so `now % periodMs` — which is what drives the phase,
    // absolute wall clock rather than time-since-mount — is a known quantity in every sample.
    const MOUNTED_AT = 1_000_800
    let clock: Mock<() => number>

    const mountAt = (holdAfterMs: number) => {
      clock.mockReturnValue(MOUNTED_AT)
      return new AskPulseBanner([], glyphs, { ...palette, holdAfterMs })
    }
    const tripletsAt = (banner: InstanceType<typeof AskPulseBanner>, now: number) => {
      clock.mockReturnValue(now)
      return [...(banner.render(40) as string[]).join("").matchAll(TRUECOLOR)].map((m) => m.slice(1).map(Number))
    }

    beforeEach(() => {
      clock = spyOn(Date, "now")
    })
    afterEach(() => {
      clock.mockRestore()
    })

    test("pins every channel to colorA once the window elapses", () => {
      const banner = mountAt(60_000)
      const triplets = tripletsAt(banner, MOUNTED_AT + 60_000)
      expect(triplets.length).toBeGreaterThan(0)
      for (const triplet of triplets) expect(triplet).toEqual([...palette.colorA])
    })

    test("still interpolates one tick before the deadline", () => {
      const banner = mountAt(60_000)
      // 900ms into a 1200ms period: sin(3π/2) = -1, so the pulse sits at the colorB endpoint.
      const [first] = tripletsAt(banner, MOUNTED_AT + 900)
      expect(first).toEqual([...palette.colorB])
    })

    test("never locks when holdAfterMs is zero or negative", () => {
      for (const holdAfterMs of [0, -1]) {
        const banner = mountAt(holdAfterMs)
        // An hour later it must still track the wall clock rather than sit bright.
        const [first] = tripletsAt(banner, MOUNTED_AT + 3_600_000 + 900)
        expect(first).toEqual([...palette.colorB])
      }
    })
  })
})
