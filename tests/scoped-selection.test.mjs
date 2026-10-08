import assert from "node:assert/strict"
import test from "node:test"
import extension from "../extensions/cache-guard.ts"

test("dialog reads live scope, never the catalog, and applies scoped thinking", async () => {
  const handlers = new Map()
  const current = { provider: "github-copilot", id: "current", api: "anthropic-messages", name: "Current",
    contextWindow: 200000, promptCache: { short: 300 }, cost: { input: 5, output: 25, cacheRead: .5, cacheWrite: 6.25 } }
  const cheap = { ...current, provider: "other-provider", id: "scoped-cheap", name: "Cheap",
    cost: { input: 1, output: 5, cacheRead: .1, cacheWrite: 1.25 } }
  let chosen, thinking, options
  extension({
    on: (name, fn) => handlers.set(name, fn),
    getCommands: () => [],
    setModel: async (m) => { chosen = m; return true },
    setThinkingLevel: (level) => { thinking = level },
  })
  const ctx = {
    hasUI: true, model: current, scopedModels: [{ model: cheap, thinkingLevel: "low" }],
    modelRegistry: { getAvailable: () => { throw new Error("Must not read full catalog") } },
    sessionManager: { getBranch: () => [{ type: "message", message: { role: "assistant", provider: current.provider,
      model: current.id, timestamp: 0, usage: { input: 0, cacheRead: 100000, cacheWrite: 0 } } }] },
    getContextUsage: () => ({ tokens: 100000 }),
    ui: {
      select: async (_title, choices) => { options = choices; return choices.find((s) => s.startsWith("Switch")) },
      setEditorText: () => {},
    },
  }
  const input = { source: "interactive", text: "Follow up" }
  assert.deepEqual(await handlers.get("input")(input, ctx), { action: "continue" })
  assert.equal(chosen, cheap)
  assert.equal(thinking, "low")
  assert.equal(options.length, 3)
  assert.match(options[1], /other-provider\/scoped-cheap/)

  // A changed scope is read on the next input, with no catalog fallback.
  ctx.scopedModels = []
  chosen = undefined
  assert.deepEqual(await handlers.get("input")(input, ctx), { action: "handled" })
  assert.equal(options.length, 2)
  assert.equal(chosen, undefined)
})
