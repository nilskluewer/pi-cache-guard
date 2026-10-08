import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "cache-guard-"))
delete process.env.PI_CACHE_GUARD_MIN_USD
const { default: extension, parseUsd } = await import("../extensions/cache-guard.ts")

test("parses budget amounts", () => {
  assert.equal(parseUsd("0.5"), 0.5)
  assert.equal(parseUsd("$0.50"), 0.5)
  assert.equal(parseUsd("€1"), 1)
  assert.equal(parseUsd("0,25"), 0.25)
  assert.equal(parseUsd(" 2 "), 2)
  assert.equal(parseUsd("0"), 0)
  assert.equal(parseUsd(".5"), 0.5)
  for (const bad of ["", "abc", "-1", "1e3", "1.2.3", "$"]) assert.equal(parseUsd(bad), undefined, bad)
})

test("/cache-guard budget decides when the dialog appears and is saved", async () => {
  const handlers = new Map()
  let command
  const model = { provider: "p", id: "m", api: "anthropic-messages", name: "M", contextWindow: 200000,
    promptCache: { short: 300 }, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }
  extension({
    on: (name, fn) => handlers.set(name, fn),
    registerCommand: (_name, options) => { command = options },
    getCommands: () => [],
  })
  let asked = 0
  const notes = []
  const ctx = {
    hasUI: true, model, scopedModels: [],
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", provider: "p", model: "m",
      timestamp: 0, usage: { input: 0, cacheRead: 100000, cacheWrite: 0 } } }] },
    getContextUsage: () => ({ tokens: 100000 }),
    ui: { select: async () => { asked++; return undefined }, setEditorText: () => {}, notify: (m, level) => notes.push([m, level]) },
  }
  const send = () => handlers.get("input")({ source: "interactive", text: "Hi" }, ctx)
  // Cold send of 100k tokens costs about $0.63.

  await command.handler("budget 1", ctx)
  assert.deepEqual(await send(), { action: "continue" })
  assert.equal(asked, 0)

  await command.handler("budget $0.50", ctx)
  assert.deepEqual(await send(), { action: "handled" })
  assert.equal(asked, 1)

  await command.handler("budget 0", ctx)
  await send()
  assert.equal(asked, 2)

  await command.handler("budget nope", ctx)
  assert.equal(notes.at(-1)[1], "error")
  await command.handler("budget 0.75", ctx)

  const saved = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, "cache-guard.json"), "utf8"))
  assert.equal(saved.budgetUsd, 0.75)
  assert.deepEqual(command.getArgumentCompletions("bud")?.map((i) => i.value), ["budget"])
  assert.ok(command.getArgumentCompletions("budget ")?.some((i) => i.value === "budget 0.5"))
})
