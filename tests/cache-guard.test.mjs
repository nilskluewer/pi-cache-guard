import assert from "node:assert/strict"
import test from "node:test"

import {
  cheaperModels,
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
  provider: "anthropic-vertex", id: "claude-opus-4-8", api: "anthropic-messages", name: "Claude Opus 4.8", contextWindow: 1_000_000,
  cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, promptCache: { short: 300, long: 3600 },
}
const sonnet = { ...opus, id: "claude-sonnet-5", name: "Claude Sonnet 5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }
const sonnetOld = { ...sonnet, id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }
const haiku = { ...opus, id: "claude-haiku-4-5", name: "Claude Haiku 4.5", contextWindow: 200_000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } }
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

test("derives warm, cold, and none from the model TTL", () => {
  const hit = { at: 0, provider: opus.provider, model: opus.id, promptTokens: 1, cached: true }
  assert.deepEqual(getCacheStatus(opus, hit, "short", 60_000), { state: "warm", remainingMs: 240_000 })
  assert.deepEqual(getCacheStatus(opus, hit, "short", 400_000), { state: "cold", expiredForMs: 100_000 })
  assert.deepEqual(getCacheStatus(opus, hit, "long", 400_000), { state: "warm", remainingMs: 3_200_000 })
  assert.deepEqual(getCacheStatus(haiku, hit, "short", 1), { state: "cold" })
  assert.deepEqual(getCacheStatus({ ...opus, promptCache: undefined }, { ...hit, cached: false }, "short", 1), { state: "none" })
  assert.deepEqual(getCacheStatus(opus, undefined, "short", 1), { state: "none" })
})

test("falls back to protocol lifetimes when the catalog has none (GitHub Copilot)", () => {
  const copilotClaude = { ...opus, provider: "github-copilot", id: "claude-opus-4.8", promptCache: undefined }
  const copilotGpt = { ...copilotClaude, id: "gpt-6-sol", api: "openai-responses" }
  const copilotGemini = { ...copilotClaude, id: "gemini-3.8-flash", api: "openai-completions" }
  const cached = { cached: true }
  assert.equal(resolveTtlMs(copilotClaude, "short", cached), 300_000)
  assert.equal(resolveTtlMs(copilotClaude, "long", cached), 3_600_000)
  assert.equal(resolveTtlMs(copilotGpt, "long", cached), 300_000)
  assert.equal(resolveTtlMs(copilotGemini, "short", cached), undefined)
  // No cache use observed on this route: do not guess.
  assert.equal(resolveTtlMs(copilotClaude, "short", { cached: false }), undefined)
  // The catalog always wins.
  assert.equal(resolveTtlMs({ ...copilotClaude, promptCache: { short: 60, long: 120 } }, "short", cached), 60_000)
  const hit = { at: 0, provider: "github-copilot", model: "claude-opus-4.8", promptTokens: 1, cached: true }
  assert.deepEqual(getCacheStatus(copilotClaude, hit, "long", 600_000), { state: "warm", remainingMs: 3_000_000 })
})

test("prices cold and warm sends from the catalog", () => {
  assert.equal(coldCost(opus, 1_000_000, "short").toFixed(2), "6.25")
  assert.equal(coldCost(opus, 1_000_000, "long").toFixed(2), "10.00") // 1h write = 2x input
  assert.equal(warmCost(opus, 1_000_000).toFixed(2), "0.50")
  const implicit = { ...opus, cost: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 } }
  assert.equal(coldCost(implicit, 1_000_000, "short").toFixed(2), "2.00")
  const tiered = { ...opus, cost: { ...opus.cost, tiers: [{ inputTokensAbove: 200_000, input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }] } }
  assert.equal(coldCost(tiered, 1_000_000, "short").toFixed(2), "12.50")
})

test("offers only supplied scoped models, including equal-price and cross-provider models", () => {
  const all = [opus, sonnetOld, sonnet, haiku, otherProvider]
  assert.deepEqual(cheaperModels(opus, all, 100_000, "short").map((x) => x.model.id), ["claude-sonnet-4-5", "claude-sonnet-5", "claude-haiku-4-5", "gpt-mini"])
  assert.deepEqual(cheaperModels(opus, all, 300_000, "short").map((x) => x.model.id), ["claude-sonnet-4-5", "claude-sonnet-5"])
  assert.deepEqual(cheaperModels(haiku, all, 100_000, "short"), [])
  const levels = [5, 4, 3, 2, 1].map((p) => ({ ...opus, id: `m${p}`, cost: { ...opus.cost, cacheWrite: p } }))
  assert.deepEqual(cheaperModels(opus, levels, 1_000, "short").map((x) => x.model.id), ["m5", "m4", "m3", "m2", "m1"])
  assert.deepEqual(cheaperModels(opus, [], 100_000, "short"), [])
  assert.deepEqual(cheaperModels(opus, [haiku], 100_000, "short").map((x) => x.model.id), [haiku.id])
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
