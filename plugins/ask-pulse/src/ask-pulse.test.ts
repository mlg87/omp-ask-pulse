// Palette resolution and banner geometry. `AGENT_DIR` is resolved once at module init, so
// `PI_CODING_AGENT_DIR` must be set before the module under test is imported — hence the
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
const { parseColor, deriveDim, parseDuration, loadConfig, AskPulseBanner, mixColors } = await import("./ask-pulse.ts")

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
    expect(palette.periodMs).toBe(2000) // v1.6 slowed the default cycle for a smoother fade
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

  // v1.6 mixes in OKLab, so intermediate colors are no longer predictable by an RGB-linear formula.
  // The contract worth pinning is instead the phase→endpoint mapping, which is exact.
  describe("exact phase colors", () => {
    // A whole number of 1200ms periods: `pulsePhase` reads the absolute wall clock, so only
    // `now % periodMs` matters and every sample below is a known point on the sine.
    const BASE = 1_200_000
    let clock: Mock<() => number>

    beforeEach(() => {
      clock = spyOn(Date, "now")
    })
    afterEach(() => {
      clock.mockRestore()
    })

    const tripletsAt = (now: number) => {
      clock.mockReturnValue(now)
      return [...(banner.render(40) as string[]).join("").matchAll(TRUECOLOR)].map((m) => m.slice(1).map(Number))
    }

    test("sits exactly on colorB at the trough", () => {
      // 900/1200 of a period: sin(3π/2) = -1 → t = 0. Only the border is asserted: body text keeps
      // the 0.5 readability floor, so it never reaches the colorB endpoint.
      const [border] = tripletsAt(BASE + 900)
      expect(border).toEqual([...palette.colorB])
    })

    test("sits exactly on colorA at the peak", () => {
      // 300/1200: sin(π/2) = +1 → t = 1, above the body's floor, so every run is the endpoint.
      const triplets = tripletsAt(BASE + 300)
      expect(triplets.length).toBeGreaterThan(0)
      for (const triplet of triplets) expect(triplet).toEqual([...palette.colorA])
    })

    test("uses the OKLab midpoint at the zero crossing", () => {
      // sin(0) = 0 → t = 0.5, which is also exactly the body's readability floor.
      const triplets = tripletsAt(BASE)
      const mid = [...mixColors(palette.colorB, palette.colorA, 0.5)]
      expect(triplets.length).toBeGreaterThan(0)
      for (const triplet of triplets) expect(triplet).toEqual(mid)
    })
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

  test("collapses to one full-width caret rule when there are no questions", () => {
    const idle = new AskPulseBanner([], glyphs, palette)
    const lines = idle.render(40) as string[]
    expect(lines).toHaveLength(1)
    const only = plain(lines[0] as string)
    expect(Bun.stringWidth(only)).toBe(40)
    expect(only).toContain("WAITING FOR YOUR INPUT")
    // v1.6: carets, not a box and not the theme's horizontal rule glyph.
    expect(only).not.toContain(glyphs.topLeft)
    expect(only).not.toContain(glyphs.topRight)
    expect(only).not.toContain(glyphs.horizontal)
    expect(only).toMatch(/^[<>]+ WAITING FOR YOUR INPUT [<>]+$/)
  })

  // Width 40 with a 24-column title gives 8 carets per side, so every `q` below is exact.
  describe("idle caret wave", () => {
    const BASE = 1_200_000
    let clock: Mock<() => number>

    beforeEach(() => {
      clock = spyOn(Date, "now")
    })
    afterEach(() => {
      clock.mockRestore()
    })

    const idleAt = (now: number, holdAfterMs = 0) => {
      clock.mockReturnValue(BASE)
      const idle = new AskPulseBanner([], glyphs, { ...palette, holdAfterMs })
      clock.mockReturnValue(now)
      const line = (idle.render(40) as string[])[0] as string
      return { text: plain(line), triplets: [...line.matchAll(TRUECOLOR)].map((m) => m.slice(1).map(Number)) }
    }

    test("sweeps every caret and flips it at the inward turnaround", () => {
      // Half a period: the front has cleared the innermost caret, so the whole line is swept.
      const { text, triplets } = idleAt(BASE + 600)
      expect(text).toBe(`${"<".repeat(8)} WAITING FOR YOUR INPUT ${">".repeat(8)}`)
      expect(triplets.length).toBeGreaterThan(0)
      for (const triplet of triplets) expect(triplet).toEqual([...palette.colorA])
    })

    test("rests unswept and inward-pointing at the outward turnaround", () => {
      const { text, triplets } = idleAt(BASE)
      expect(text).toBe(`${">".repeat(8)} WAITING FOR YOUR INPUT ${"<".repeat(8)}`)
      expect(triplets.length).toBeGreaterThan(0)
      for (const triplet of triplets) expect(triplet).toEqual([...palette.colorB])
    })

    test("emits one SGR run per color, not one per glyph", () => {
      // At rest the line is uniformly colorB; 40 separate SGR pairs would be a 40x waste per frame.
      expect(idleAt(BASE).triplets).toHaveLength(1)
    })

    test("locks fully swept but unflipped once the hold window elapses", () => {
      const { text, triplets } = idleAt(BASE + 60_000, 60_000)
      expect(text).toMatch(/^>+ WAITING FOR YOUR INPUT <+$/)
      expect(triplets.length).toBeGreaterThan(0)
      for (const triplet of triplets) expect(triplet).toEqual([...palette.colorA])
    })
  })

  // The banner derives its phase from `Date.now()`, so the clock is the only input worth
  // controlling here — no sleeps, and the assertions are exact rather than "roughly bright".
  describe("hold window", () => {
    // A whole number of 1200ms periods, so `now % periodMs` — which is what drives the phase,
    // absolute wall clock rather than time-since-mount — is a known quantity in every sample.
    const MOUNTED_AT = 1_000_800
    let clock: Mock<() => number>

    // A question, so this block exercises the uniform-phase box path: idle mode is per-column after
    // v1.6 and its own lock behavior is covered in "idle caret wave".
    const mountAt = (holdAfterMs: number) => {
      clock.mockReturnValue(MOUNTED_AT)
      return new AskPulseBanner(["q"], glyphs, { ...palette, holdAfterMs })
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

// WHY this is a test and not a release checklist item: omp's startup auto-update compares the
// `version` field of the *catalog* entry, not package.json. A release that bumps the package but
// forgets a catalog never reaches anyone's next session — silently. Fail the build instead.
describe("release version sync", () => {
  const pluginRoot = join(import.meta.dir, "..")
  const repoRoot = join(pluginRoot, "..", "..")
  const catalogs = [
    join(repoRoot, ".omp-plugin", "marketplace.json"), // read by omp
    join(repoRoot, ".claude-plugin", "marketplace.json"), // read by Claude Code
  ]

  // Skipped when the plugin directory is vendored without the marketplace repo around it.
  test.skipIf(!catalogs.every((path) => existsSync(path)))("catalogs declare the package version", () => {
    const version = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")).version
    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    for (const path of catalogs) {
      const catalog = JSON.parse(readFileSync(path, "utf8"))
      expect(catalog.plugins[0].version).toBe(version)
      expect(catalog.metadata.version).toBe(version)
    }
  })
})
