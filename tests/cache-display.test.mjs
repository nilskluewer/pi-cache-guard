import assert from "node:assert/strict"
import test from "node:test"
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { cacheDisplayText, layoutCacheDisplay, renderCacheBox } from "../extensions/cache-display.ts"

// Oracle: user chose shorter labels plus adaptive wrapping. Width invariants are
// terminal cells (Pi TUI contract), not snapshots copied from the implementation.
// Reject: constant-width rendering, clipped/split prices at usable widths,
// optional evidence crowding essential information, ANSI/Unicode width errors.
const ended = {
  primary: "◷ cache est. ended", compactPrimary: "◷ past estimate",
  secondary: "On a miss: ~$0.18", inlineSecondary: "miss ~$0.18", compactSecondary: "miss ~$0.18",
}
const warm = {
  primary: "◷ cache ~25min (estimate)", compactPrimary: "◷ ~25m est.",
  secondary: "▰▰▰▰▰▰▱▱▱▱ 14:32", compactSecondary: "14:32", separator: " ",
  optional: "last hit after 23min",
}

test("short ended label stays one line when it fits, and wraps without losing the miss price", () => {
  assert.deepEqual(layoutCacheDisplay(ended, 40), ["◷ cache est. ended · miss ~$0.18"])
  assert.deepEqual(layoutCacheDisplay(ended, 24), ["◷ cache est. ended", "On a miss: ~$0.18"])
  assert.deepEqual(layoutCacheDisplay(ended, 17), ["◷ past estimate", "On a miss: ~$0.18"])
  assert.deepEqual(layoutCacheDisplay(ended, 15), ["◷ past estimate", "miss ~$0.18"])
})

test("exact single-line fit is preserved, one column less wraps", () => {
  const width = visibleWidth(cacheDisplayText(ended))
  assert.equal(layoutCacheDisplay(ended, width).length, 1)
  assert.equal(layoutCacheDisplay(ended, width - 1).length, 2)
})

test("optional hit history is dropped before wrapping essential duration and countdown", () => {
  assert.match(layoutCacheDisplay(warm, 100)[0], /last hit after 23min/)
  const essential = cacheDisplayText(warm, false)
  assert.deepEqual(layoutCacheDisplay(warm, visibleWidth(essential)), [essential])
  assert.deepEqual(layoutCacheDisplay(warm, 26), [warm.primary, warm.secondary])
  assert.deepEqual(layoutCacheDisplay(warm, 14), [warm.compactPrimary, "14:32"])
})

test("ANSI and wide Unicode use terminal cells, with aligned borders at every usable width", () => {
  const styled = { ...ended, primary: "\x1b[31m◷ cache 表 est. ended\x1b[39m",
    secondary: "\x1b[33mOn a miss: ~$0.18\x1b[39m" }
  for (const content of [ended, warm, styled, { primary: "cache duration unknown", compactPrimary: "cache unknown" }]) {
    for (let width = 0; width <= 120; width++) {
      const rows = renderCacheBox(content, width)
      assert.ok(rows.every(row => visibleWidth(row) <= width), `must fit ${width} columns`)
      if (width >= 5) {
        assert.ok(rows.every(row => visibleWidth(row) === width), "border and padding must align")
        for (const row of rows.slice(1, -1)) assert.ok(stripTerminalSequences(row).endsWith("▐"))
      }
    }
  }
  const rows = renderCacheBox(styled, 32)
  assert.ok(rows.some(row => row.includes("\x1b[33m")), "wrapped cost retains its ANSI style")
  assert.match(rows.map(stripTerminalSequences).join("\n"), /~\$0\.18/)
})

for (const price of ["~<$0.01", "~$0.18", "~$123.45", "~$123456.78"]) {
  test(`price ${price} stays intact when the viewport can fit it`, () => {
    const content = { ...ended, secondary: `On a miss: ${price}`, inlineSecondary: `miss ${price}`, compactSecondary: `miss ${price}` }
    const width = visibleWidth(`miss ${price}`)
    const rows = layoutCacheDisplay(content, width)
    assert.ok(rows.some(row => row.includes(price)), "never silently cut off price digits")
    assert.ok(rows.every(row => visibleWidth(row) <= width))
  })
}
