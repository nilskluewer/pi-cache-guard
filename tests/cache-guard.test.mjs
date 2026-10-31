import assert from "node:assert/strict"
import test from "node:test"

import {
  scopedModelOptions,
  coldCost,
  findLastCacheHit,
  formatAgo,
  formatDuration,
  formatUsd,
  getCacheStatus,
  getRetention,
  resolveTtlMs,
  warmCost,
} from "../extensions/cache-guard-logic.ts"

const opus = {
  provider: "github-copilot", id: "claude-opus-5.5", api: "anthropic-messages", name: "Claude Opus 5.5", contextWindow: 1_000_000,
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, promptCache: { short: 300, long: 3600 },
}
const sonnet = { ...opus, id: "claude-sonnet-5", name: "Claude Sonnet 5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }
const sonnetOld = { ...sonnet, id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }
const haiku = { ...opus, id: "claude-haiku-5.5", name: "Claude Haiku 5.5", contextWindow: 200_000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } }
const otherProvider = { ...haiku, provider: "openai", id: "gpt-mini" }

const usage = (input, cacheRead, cacheWrite) => ({ input, output: 10, cacheRead, cacheWrite })
const assistant = (timestamp, u, model = opus) => ({
  type: "message", timestamp: new Date(timestamp + 5000).toISOString(),
  message: { role: "assistant", provider: model.provider, model: model.id, timestamp, usage: u },
})

test("finds the last request that touched the cache", () => {
  const entries = [
    assistant(1_000, usage(10, 0, 100)),
    { type: "usage", kind: "cache_warm", provider: opus.provider, model: opus.id, timestamp: new Date(2_000).toISOString(), usage: usage(0, 110, 0) },
    assistant(3_000, usage(0, 0, 0)), // failed request: no usage
  ]
  assert.deepEqual(findLastCacheHit(entries), { at: 2_000, provider: opus.provider, model: opus.id, promptTokens: 110, cached: true })
  assert.deepEqual(findLastCacheHit(entries.slice(0, 1)), { at: 1_000, provider: opus.provider, model: opus.id, promptTokens: 110, cached: true })
  assert.equal(findLastCacheHit([assistant(1_000, usage(500, 0, 0))]).cached, false)
  assert.equal(findLastCacheHit([...entries, { type: "compaction" }]), undefined)
  assert.equal(findLastCacheHit([]), undefined)
})

test("derives estimated windows and explicit unknown from exact supported routes", () => {
  const hit = { at: 0, provider: opus.provider, model: opus.id, promptTokens: 1, cached: true }
  assert.deepEqual(getCacheStatus(opus, hit, "short", 60_000), { state: "warm", remainingMs: 240_000, ttlMs: 300_000 })
  assert.deepEqual(getCacheStatus(opus, hit, "short", 400_000), { state: "cold", expiredForMs: 100_000 })
  assert.deepEqual(getCacheStatus(opus, hit, "long", 400_000), { state: "warm", remainingMs: 3_200_000, ttlMs: 3_600_000 })
  assert.deepEqual(getCacheStatus(haiku, hit, "short", 1), { state: "cold" })
  assert.deepEqual(getCacheStatus({ ...opus, promptCache: undefined }, { ...hit, cached: false }, "short", 1), { state: "unknown" })
  assert.deepEqual(getCacheStatus(opus, undefined, "short", 1), { state: "unknown" })
  const gemini = { provider: "github-copilot", id: "gemini-4-argon", api: "openai-completions" }
  const coldGeminiTurn = { at: 0, provider: gemini.provider, model: gemini.id, promptTokens: 500, cached: false }
  assert.deepEqual(getCacheStatus(gemini, coldGeminiTurn, "short", 60_000, 900_000), { state: "warm", remainingMs: 840_000, ttlMs: 900_000 })
})

test("uses declarations before model-specific fallback estimates, never a protocol fallback", () => {
  const copilotClaude = { ...opus, promptCache: undefined }
  const copilotGpt = { ...copilotClaude, id: "gpt-6.1-sol", api: "openai-responses" }
  const copilotGemini = { ...copilotClaude, id: "gemini-3.8-flash", api: "openai-completions" }
  const cached = { cached: true }
  assert.equal(resolveTtlMs(copilotClaude, "short", cached), 300_000)
  assert.equal(resolveTtlMs(copilotClaude, "long", cached), 3_600_000)
  assert.equal(resolveTtlMs(copilotGpt, "long", cached), 1_800_000)
  assert.equal(resolveTtlMs(copilotGemini, "short", cached), undefined)
  assert.equal(resolveTtlMs(copilotClaude, "short", { cached: false }), undefined)
  assert.equal(resolveTtlMs({ ...copilotClaude, id: "claude-opus-4.8", promptCache: { short: 300 } }, "short", cached), 300_000)
  assert.equal(resolveTtlMs({ ...copilotClaude, provider: "anthropic" }, "short", cached), undefined)
  assert.equal(resolveTtlMs({ ...copilotClaude, promptCache: { short: 60, long: 120 } }, "short", cached), 60_000)
  const hit = { at: 0, provider: "github-copilot", model: "claude-opus-5.5", promptTokens: 1, cached: true }
  assert.deepEqual(getCacheStatus(copilotClaude, hit, "long", 600_000), { state: "warm", remainingMs: 3_000_000, ttlMs: 3_600_000 })
})

test("prices cold and warm sends from the catalog", () => {
  assert.equal(coldCost(opus, 1_000_000, "short").toFixed(2), "6.25")
  assert.equal(coldCost(opus, 1_000_000, "long").toFixed(2), "10.00") // 1h write = 2x input
  assert.equal(warmCost(opus, 1_000_000).toFixed(2), "0.50")
  const implicit = { ...opus, cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 } }
  assert.equal(coldCost(implicit, 1_000_000, "short").toFixed(2), "2.00")
  const responses = { ...opus, api: "openai-responses", cost: { input: 2, output: 10, cacheRead: .1, cacheWrite: 2.5 } }
  assert.equal(coldCost(responses, 1_000_000, "long").toFixed(2), "2.50", "OpenAI writes are not Anthropic 1-hour writes")
  assert.equal(coldCost({ ...opus, compat: { supportsLongCacheRetention: false } }, 1_000_000, "long").toFixed(2), "6.25")
  const tiered = { ...opus, cost: { ...opus.cost, tiers: [{ inputTokensAbove: 200_000, input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }] } }
  assert.equal(coldCost(tiered, 1_000_000, "short").toFixed(2), "12.50")
})

test("lists all supplied scoped models in scope order, with context-fit reasons", () => {
  // Oracle: all scoped entries remain visible, regardless of price or context fit.
  const equal = { ...opus, id: "equal" }
  const higher = { ...opus, id: "higher", cost: { ...opus.cost, cacheWrite: 12.5 } }
  const all = [opus, sonnetOld, sonnet, haiku, otherProvider, equal, higher]
  const entries = scopedModelOptions(all, 300_000, "short")
  assert.deepEqual(entries.map((x) => x.model), all)
  assert.equal(entries[0].cost, 1.875)
  assert.equal(entries[5].cost, 1.875)
  assert.equal(entries[6].cost, 3.75)
  assert.match(entries[3].unavailable, /context too large for model: ~300k tokens, limit 200k/)
  assert.match(entries[4].unavailable, /context too large for model/)
  assert.equal(entries[0].unavailable, undefined)
  assert.equal(scopedModelOptions([haiku], 200_000, "short")[0].unavailable, undefined)
  assert.deepEqual(scopedModelOptions([], 100_000, "short"), [])
})

test("formats values and reads retention", () => {
  assert.equal(formatUsd(0.004), "<$0.01")
  assert.equal(formatUsd(0.938), "$0.94")
  assert.equal(formatDuration(272_000), "4:32")
  assert.equal(formatDuration(3_599_000), "59:59")
  assert.equal(formatDuration(3_600_000), "1:00:00")
  assert.equal(formatAgo(12 * 60_000), "12 min ago")
  assert.equal(formatAgo(3 * 3_600_000), "3 h ago")
  assert.equal(getRetention({ PI_CACHE_RETENTION: "long" }), "long")
  assert.equal(getRetention({}), "short")
})
