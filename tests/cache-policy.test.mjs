import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { cacheLifetime, handoffPauseReason, nativeWarmingMode } from "../extensions/cache-policy.ts"
import { findLastCacheHit, getCacheStatus, getTtlMs } from "../extensions/cache-guard-logic.ts"

// Oracle: Pi models/settings documentation: active-tier declarations are seconds;
// warming is global-only. User-approved policy: idle mode owns background work,
// including a declined refresh; invalid settings cannot authorize paid handoff.
test("declarations override longer and shorter local estimates without changing evidence", () => {
  const model = { promptCache: { short: 120, long: 600 } }
  for (const ttlMs of [60_000, 900_000]) {
    const observed = { source: "learned", ttlMs, maxHitAfterMs: 180_000, earlyMisses: 1 }
    const saved = structuredClone(observed)
    for (const [retention, expected] of [["short", 120_000], ["long", 600_000]]) {
      const policy = cacheLifetime(model, retention, observed)
      assert.equal(policy.ttlMs, expected)
      assert.equal(policy.source, "declared")
      assert.equal(policy.observedTtlMs, ttlMs)
      assert.equal(policy.maxHitAfterMs, 180_000)
      assert.equal(policy.earlyMisses, 1)
    }
    assert.deepEqual(observed, saved, "declared policy must not overwrite stored learning")
  }
})

test("only the active tier supplies a declaration; invalid lifetimes cannot make a countdown", () => {
  const observed = { source: "learned", ttlMs: 900_000 }
  assert.equal(cacheLifetime({ promptCache: { long: 600 } }, "short", observed).source, "learned")
  assert.equal(cacheLifetime({ promptCache: { long: 600 } }, "short", observed).ttlMs, 900_000)
  for (const value of [undefined, null, 0, -1, "300", NaN, Infinity, Number.MAX_VALUE]) {
    assert.equal(getTtlMs({ promptCache: { short: value } }, "short"), undefined)
    assert.equal(cacheLifetime({ promptCache: { short: value } }, "short", observed).ttlMs, 900_000)
  }
})

test("getCacheStatus cannot bypass a declaration with an explicitly supplied learned TTL", () => {
  const model = { provider: "proxy", id: "custom", api: "anthropic-messages", promptCache: { short: 120 } }
  const hit = { at: 0, provider: model.provider, model: model.id, cached: true, promptTokens: 100 }
  assert.deepEqual(getCacheStatus(model, hit, "short", 120_000, 900_000), { state: "cold", expiredForMs: 0 })
  assert.deepEqual(getCacheStatus(model, undefined, "short", 0, 900_000), { state: "unknown" })
})

test("cache-warm usage with uncached input alone does not invent a cache read/write", () => {
  const hit = findLastCacheHit([{ type: "usage", kind: "cache_warm", timestamp: new Date(1000).toISOString(),
    provider: "proxy", model: "custom", usage: { input: 100, cacheRead: 0, cacheWrite: 0 } }])
  assert.equal(hit.cached, false)
  assert.equal(hit.promptTokens, 100)
  assert.deepEqual(getCacheStatus({ provider: "proxy", id: "custom", api: "anthropic-messages", promptCache: { short: 300 } },
    hit, "short", 1001), { state: "unknown" })
})

test("global warming settings win over merged project settings; SDK settings work without a file", t => {
  const dir = mkdtempSync(join(tmpdir(), "cache-policy-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(nativeWarmingMode(dir, {}), "streaming")
  assert.equal(nativeWarmingMode(dir, { cacheWarming: "idle" }), "idle")
  const path = join(dir, "settings.json")
  writeFileSync(path, JSON.stringify({ cacheWarming: "idle" }))
  assert.equal(nativeWarmingMode(dir, { cacheWarming: "off" }), "idle")
  writeFileSync(path, JSON.stringify({ cacheWarming: "off" }))
  assert.equal(nativeWarmingMode(dir, { cacheWarming: "idle" }), "off")
  writeFileSync(path, "{}")
  assert.equal(nativeWarmingMode(dir, { cacheWarming: "idle" }), "streaming", "unset global mode uses Pi's default")
  for (const text of ["{", "[]", "null", '{"cacheWarming":"bad"}', '{"cacheWarming":{"enabled":true}}']) {
    writeFileSync(path, text)
    assert.equal(nativeWarmingMode(dir, { cacheWarming: "off" }), "unknown")
    assert.match(handoffPauseReason(nativeWarmingMode(dir, {})), /paused/)
  }
  assert.match(handoffPauseReason("idle"), /native idle cache warming/)
  assert.equal(handoffPauseReason("streaming"), undefined)
  assert.equal(handoffPauseReason("off"), undefined)
})
