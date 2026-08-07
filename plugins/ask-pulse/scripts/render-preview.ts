// Dev-only frame renderer for the README GIFs. Not listed in `omp.extensions` — it never ships as
// part of the extension surface, it only produces `docs/*.gif`.
//
// WHY this replaces the old `scripts/frame.html`: that file re-implemented the color and glyph math
// by hand, so every change to `src/ask-pulse.ts` (v1.6 moved mixing to OKLab and rewrote idle mode
// entirely) silently drifted the published preview away from what users actually see. This imports
// the real `AskPulseBanner` and only translates its ANSI output to HTML, so the preview cannot lie.
//
// Usage: `bun scripts/render-preview.ts <idle|ask>` → `scripts/preview-<mode>-NNN.html`, one file
// per frame, 50 frames × 40 ms = one full 2000 ms period.

import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AskPulseBanner } from "../src/ask-pulse.ts"

const FRAMES = 50
const FRAME_STEP_MS = 40 // 50 × 40 ms = 2000 ms = one default period
const WIDTH = 72
const GLYPHS = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
} as const
const PALETTE = {
  colorB: [0x0a, 0xf0, 0xff],
  colorA: [0xff, 0x10, 0xf0],
  periodMs: 2000,
  holdAfterMs: 0,
} as const
const SAMPLE_QUESTIONS = ["Apply the migration to production?"]

const ESC = String.fromCharCode(0x1b)
// `paint()`/`paintCells()` only ever emit these two sequences, so a two-token parser is sufficient.
const SGR = new RegExp(`${ESC}\\[38;2;(\\d+);(\\d+);(\\d+)m|${ESC}\\[39m`, "g")

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll(" ", "&nbsp;")

/** Translate one ANSI line into spans, preserving the run boundaries the banner chose. */
function toHtml(line: string): string {
  let out = ""
  let cursor = 0
  let color: string | undefined
  for (const match of line.matchAll(SGR)) {
    const text = line.slice(cursor, match.index)
    if (text !== "")
      out += color === undefined ? escapeHtml(text) : `<span style="color:${color}">${escapeHtml(text)}</span>`
    cursor = match.index + match[0].length
    color = match[1] === undefined ? undefined : `rgb(${match[1]},${match[2]},${match[3]})`
  }
  const tail = line.slice(cursor)
  return out + (color === undefined ? escapeHtml(tail) : `<span style="color:${color}">${escapeHtml(tail)}</span>`)
}

const mode = process.argv[2]
if (mode !== "idle" && mode !== "ask") {
  console.error("usage: bun scripts/render-preview.ts <idle|ask>")
  process.exit(1)
}

const scriptsDir = import.meta.dir
// A stale frame from a previous run at a different frame count would silently end up in the GIF.
for (let frame = 0; frame < 1000; frame++) {
  rmSync(join(scriptsDir, `preview-${mode}-${String(frame).padStart(3, "0")}.html`), { force: true })
}

const realNow = Date.now
// A whole number of periods, so frame 0 is the exact start of a cycle and the GIF loops seamlessly.
const base = 2_000_000
const banner = new AskPulseBanner(mode === "idle" ? [] : SAMPLE_QUESTIONS, GLYPHS, PALETTE)

for (let frame = 0; frame < FRAMES; frame++) {
  const now = base + frame * FRAME_STEP_MS
  Date.now = () => now
  const lines = banner.render(WIDTH)
  Date.now = realNow
  const body = lines.map(toHtml).join("\n")
  const html = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #101014; }
  pre {
    margin: 0; padding: 24px; background: #101014; color: #8a8a99;
    font: 16px/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    display: inline-block; white-space: pre;
  }
</style>
<pre>${body}</pre>
`
  writeFileSync(join(scriptsDir, `preview-${mode}-${String(frame).padStart(3, "0")}.html`), html)
}

const last = String(FRAMES - 1).padStart(3, "0")
console.log(`wrote ${FRAMES} frames: scripts/preview-${mode}-000.html … preview-${mode}-${last}.html`)
