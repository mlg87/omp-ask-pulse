// Color parsing, config precedence, mode resolution, and the escape sequences written to the
// terminal. `AGENT_DIR` is resolved once at module init, so `PI_CODING_AGENT_DIR` must be set
// before the module under test is imported — hence the dynamic import below.
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const workspace = mkdtempSync(join(tmpdir(), "obvi-plan-"))
const agentDir = join(workspace, "agent")
const projectDir = join(workspace, "project")
mkdirSync(join(projectDir, ".omp"), { recursive: true })
mkdirSync(agentDir, { recursive: true })
process.env.PI_CODING_AGENT_DIR = agentDir
delete process.env.OBVI_PLAN_COLOR
delete process.env.OBVI_PLAN_ENABLED
delete process.env.OBVI_PLAN_MATCH_THEME

const {
  default: obviPlan,
  parseColor,
  toHex,
  loadConfig,
  setBackgroundSequence,
  RESET_BACKGROUND,
  DEFAULT_COLOR,
  ModeTracker,
  Backdrop,
} = await import("./obvi-plan.ts")

const userConfig = join(agentDir, "obvi-plan.json")
const projectConfig = join(projectDir, ".omp", "obvi-plan.json")

afterAll(() => rmSync(workspace, { recursive: true, force: true }))

describe("parseColor", () => {
  test("accepts hex with and without the hash, and shorthand", () => {
    expect(parseColor("#c8a2c8")).toEqual([0xc8, 0xa2, 0xc8])
    expect(parseColor("C8A2C8")).toEqual([0xc8, 0xa2, 0xc8])
    expect(parseColor("#f1f")).toEqual([0xff, 0x11, 0xff])
  })

  test("resolves presets case-insensitively", () => {
    expect(parseColor("Lilac")).toEqual([0xc8, 0xa2, 0xc8])
    expect(parseColor("MIDNIGHT")).toEqual(DEFAULT_COLOR)
    expect(parseColor(" plum ")).toEqual([0x3d, 0x2b, 0x4f])
  })

  test("rejects junk and non-strings", () => {
    expect(parseColor("chartreuse")).toBeUndefined()
    expect(parseColor("#c8a2c")).toBeUndefined()
    expect(parseColor("")).toBeUndefined()
    expect(parseColor(42)).toBeUndefined()
  })
})

test("the default is midnight", () => {
  expect(toHex(DEFAULT_COLOR)).toBe("#1e1b3a")
})

describe("loadConfig", () => {
  afterEach(() => {
    rmSync(userConfig, { force: true })
    rmSync(projectConfig, { force: true })
    delete process.env.OBVI_PLAN_COLOR
    delete process.env.OBVI_PLAN_ENABLED
    delete process.env.OBVI_PLAN_MATCH_THEME
  })

  test("defaults to midnight, enabled, matching the theme", () => {
    expect(loadConfig(projectDir)).toEqual({ color: DEFAULT_COLOR, enabled: true, matchTheme: true })
  })

  test("user < project < environment", () => {
    writeFileSync(userConfig, JSON.stringify({ color: "#111111", enabled: false }))
    expect(loadConfig(projectDir)).toEqual({ color: [0x11, 0x11, 0x11], enabled: false, matchTheme: true })

    writeFileSync(projectConfig, JSON.stringify({ color: "plum", matchTheme: false }))
    expect(loadConfig(projectDir).color).toEqual([0x3d, 0x2b, 0x4f])
    expect(loadConfig(projectDir).enabled).toBe(false) // untouched keys fall through

    process.env.OBVI_PLAN_COLOR = "#abcdef"
    process.env.OBVI_PLAN_ENABLED = "1"
    process.env.OBVI_PLAN_MATCH_THEME = "on"
    expect(loadConfig(projectDir)).toEqual({ color: [0xab, 0xcd, 0xef], enabled: true, matchTheme: true })
  })

  test("reads off-ish environment strings as disabled", () => {
    for (const value of ["0", "false", "OFF", "no"]) {
      process.env.OBVI_PLAN_ENABLED = value
      process.env.OBVI_PLAN_MATCH_THEME = value
      expect(loadConfig(projectDir)).toMatchObject({ enabled: false, matchTheme: false })
    }
  })

  test("ignores a malformed file and an invalid color", () => {
    writeFileSync(userConfig, "{ not json")
    writeFileSync(projectConfig, JSON.stringify({ color: "nope", enabled: "maybe?" }))
    expect(loadConfig(projectDir).color).toEqual(DEFAULT_COLOR)
  })
})

test("escape sequences are OSC 11 set / OSC 111 reset", () => {
  expect(setBackgroundSequence([0xc8, 0xa2, 0x08])).toBe("\x1b]11;rgb:c8/a2/08\x07")
  expect(RESET_BACKGROUND).toBe("\x1b]111\x07")
})

/** Minimal session tree: an append-only chain with an optional branch switch. */
class FakeTree {
  readonly entries = new Map<string, { type: string; parentId: string | null; mode?: string }>()
  leaf: string | null = null
  lookups = 0
  #next = 0

  append(type: string, mode?: string): string {
    const id = `e${this.#next++}`
    this.entries.set(id, { type, parentId: this.leaf, mode })
    this.leaf = id
    return id
  }

  getLeafId(): string | null {
    return this.leaf
  }

  getEntry(id: string) {
    this.lookups++
    return this.entries.get(id)
  }
}

describe("ModeTracker", () => {
  test("an empty session is not in plan mode", () => {
    expect(new ModeTracker().resolve(new FakeTree())).toBe("none")
  })

  test("follows plan entry, pause, and exit", () => {
    const tree = new FakeTree()
    const tracker = new ModeTracker()
    tree.append("message")
    expect(tracker.resolve(tree)).toBe("none")

    tree.append("mode_change", "plan")
    expect(tracker.resolve(tree)).toBe("plan")

    tree.append("message")
    tree.append("message")
    expect(tracker.resolve(tree)).toBe("plan")

    tree.append("mode_change", "plan_paused")
    expect(tracker.resolve(tree)).toBe("plan_paused")

    tree.append("mode_change", "plan")
    tree.append("mode_change", "none")
    expect(tracker.resolve(tree)).toBe("none")
  })

  test("an unchanged leaf does no lookups, and appends walk only the new entries", () => {
    const tree = new FakeTree()
    const tracker = new ModeTracker()
    tree.append("mode_change", "plan")
    for (let i = 0; i < 100; i++) tree.append("message")
    tracker.resolve(tree)

    tree.lookups = 0
    tracker.resolve(tree)
    expect(tree.lookups).toBe(0)

    tree.append("message")
    tree.append("message")
    expect(tracker.resolve(tree)).toBe("plan")
    expect(tree.lookups).toBe(2)
  })

  test("a branch switch resolves the other branch's mode", () => {
    const tree = new FakeTree()
    const tracker = new ModeTracker()
    const fork = tree.append("message")
    tree.append("mode_change", "plan")
    tree.append("message")
    expect(tracker.resolve(tree)).toBe("plan")

    tree.leaf = fork // navigate back to before plan mode was entered
    expect(tracker.resolve(tree)).toBe("none")
  })

  test("reset forgets the cached mode", () => {
    const tree = new FakeTree()
    const tracker = new ModeTracker()
    tree.append("mode_change", "plan")
    tracker.resolve(tree)
    tracker.reset()
    expect(tracker.resolve(tree)).toBe("plan")
  })
})

describe("Backdrop", () => {
  const tint = DEFAULT_COLOR
  const make = () => {
    const writes: string[] = []
    return { writes, backdrop: new Backdrop((data) => writes.push(data)) }
  }

  test("never resets a background it did not set", () => {
    const { writes, backdrop } = make()
    expect(backdrop.apply(undefined)).toBe(false)
    expect(writes).toEqual([])
  })

  test("sets once, then resets once", () => {
    const { writes, backdrop } = make()
    expect(backdrop.apply(tint)).toBe(true)
    expect(backdrop.apply([...tint])).toBe(false)
    expect(writes).toEqual([setBackgroundSequence(tint)])
    expect(backdrop.applied).toEqual(tint)

    backdrop.apply(undefined)
    backdrop.apply(undefined)
    expect(writes).toEqual([setBackgroundSequence(tint), RESET_BACKGROUND])
    expect(backdrop.applied).toBeUndefined()
  })

  test("a color change rewrites without an intermediate reset", () => {
    const { writes, backdrop } = make()
    backdrop.apply(tint)
    backdrop.apply([0x3d, 0x2b, 0x4f])
    expect(writes).toEqual([setBackgroundSequence(tint), setBackgroundSequence([0x3d, 0x2b, 0x4f])])
  })
})

describe("extension wiring", () => {
  type Handler = (event: unknown, ctx: unknown) => void

  /**
   * Boot the extension against a fake `pi`, a fake session tree, and a fake TUI whose terminal
   * records every write and re-probe in one ordered log. stdout is only claimed to be a TTY.
   */
  const boot = () => {
    const handlers = new Map<string, Handler>()
    const pi = {
      setLabel() {},
      on(event: string, handler: Handler) {
        handlers.set(event, handler)
      },
      registerCommand() {},
    }
    const tree = new FakeTree()
    const log: string[] = []
    const tui = {
      terminal: {
        write: (data: string) => log.push(data),
        refreshAppearance: () => log.push("reprobe"),
      },
    }
    let tick: (() => void) | undefined
    const ctx = {
      hasUI: true,
      cwd: projectDir,
      sessionManager: tree,
      ui: {
        setWidget(_key: string, factory: (tui: unknown) => unknown) {
          factory(tui)
        },
      },
      setInterval(callback: () => void) {
        tick = callback
        return 1 as unknown as Timer
      },
      setTimeout: () => 2 as unknown as Timer,
      clearTimer() {},
    }
    const stdout: string[] = []
    const wasTTY = process.stdout.isTTY
    process.stdout.isTTY = true
    const spy = spyOn(process.stdout, "write").mockImplementation((data: string | Uint8Array) => {
      stdout.push(String(data))
      return true
    })
    const restore = () => {
      spy.mockRestore()
      process.stdout.isTTY = wasTTY
    }
    obviPlan(pi as never)
    const emit = (event: string) => handlers.get(event)?.({}, ctx)
    return { tree, log, stdout, emit, tick: () => tick?.(), restore }
  }

  const tint = setBackgroundSequence(DEFAULT_COLOR)

  test("tints on plan entry and restores on exit, re-probing the theme after each", () => {
    const { tree, log, emit, tick, restore } = boot()
    try {
      emit("session_start")
      expect(log).toEqual([]) // not in plan mode: the terminal is never touched

      tree.append("mode_change", "plan")
      tick()
      expect(log).toEqual([tint, "reprobe"]) // the set must reach the terminal before the probe

      tree.append("message")
      tick()
      expect(log).toHaveLength(2)

      tree.append("mode_change", "plan_paused")
      tick()
      expect(log).toEqual([tint, "reprobe", RESET_BACKGROUND, "reprobe"])
    } finally {
      emit("session_shutdown")
      restore()
    }
  })

  test("shutdown inside plan mode resets straight to stdout", () => {
    const { tree, log, stdout, emit, restore } = boot()
    try {
      tree.append("mode_change", "plan")
      emit("session_start")
      emit("session_shutdown")
      expect(log).toEqual([tint, "reprobe"])
      expect(stdout).toEqual([RESET_BACKGROUND])
    } finally {
      restore()
    }
  })

  test("uses the configured color, honors enabled: false, and skips re-probes with matchTheme: false", () => {
    const { tree, log, emit, tick, restore } = boot()
    try {
      writeFileSync(projectConfig, JSON.stringify({ color: "#102030", matchTheme: false }))
      tree.append("mode_change", "plan")
      emit("session_start")
      expect(log).toEqual([setBackgroundSequence([0x10, 0x20, 0x30])])

      writeFileSync(projectConfig, JSON.stringify({ enabled: false, matchTheme: false }))
      tree.append("mode_change", "none")
      tick()
      tree.append("mode_change", "plan") // config is re-read per transition
      tick()
      expect(log).toEqual([setBackgroundSequence([0x10, 0x20, 0x30]), RESET_BACKGROUND])
    } finally {
      emit("session_shutdown")
      rmSync(projectConfig, { force: true })
      restore()
    }
  })

  // Issue #8: "Approve and execute" exits plan mode and starts a fresh session (omp's
  // `newSession`, which emits `session_switch`) before the next tick. The switch must restore.
  test("a session switch out of plan mode restores the background", () => {
    const { tree, log, emit, tick, restore } = boot()
    try {
      tree.append("mode_change", "plan")
      emit("session_start")
      expect(log).toEqual([tint, "reprobe"])

      tree.append("mode_change", "none") // plan exit, no tick in between…
      tree.leaf = null // …then the new, empty session
      emit("session_switch")
      expect(log).toEqual([tint, "reprobe", RESET_BACKGROUND, "reprobe"])

      tick()
      expect(log).toHaveLength(4)
    } finally {
      emit("session_shutdown")
      restore()
    }
  })

  test("/new from inside plan mode restores the background", () => {
    const { tree, log, emit, restore } = boot()
    try {
      tree.append("mode_change", "plan")
      emit("session_start")
      tree.leaf = null // new session, never in plan mode, no mode_change at all
      emit("session_switch")
      expect(log).toEqual([tint, "reprobe", RESET_BACKGROUND, "reprobe"])
    } finally {
      emit("session_shutdown")
      restore()
    }
  })

  test("switching into a session that is in plan mode tints it", () => {
    const { tree, log, emit, restore } = boot()
    try {
      emit("session_start")
      tree.leaf = null
      tree.append("mode_change", "plan") // the resumed session's branch
      emit("session_switch")
      expect(log).toEqual([tint, "reprobe"])
    } finally {
      emit("session_shutdown")
      restore()
    }
  })

  test("a theme shifted by the tint is shifted back even if matching was turned off meanwhile", () => {
    const { tree, log, emit, tick, restore } = boot()
    try {
      tree.append("mode_change", "plan")
      emit("session_start")
      writeFileSync(projectConfig, JSON.stringify({ matchTheme: false }))
      tree.append("mode_change", "none")
      tick()
      expect(log).toEqual([tint, "reprobe", RESET_BACKGROUND, "reprobe"])
    } finally {
      emit("session_shutdown")
      rmSync(projectConfig, { force: true })
      restore()
    }
  })
})
