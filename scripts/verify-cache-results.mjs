#!/usr/bin/env node
// Offline audit of retained API telemetry. Never authenticates or calls a model.
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(".scratch/cache-probe")
const metadata = JSON.parse(readFileSync(resolve(root, "latest-sweep.json"), "utf8"))
const sources = [], visited = new Set()
let dir = metadata.dir
while (dir) {
  const path = resolve(dir)
  assert(path.startsWith(root + "/"), "Evidence path escaped local probe directory")
  assert(!visited.has(path), "Cyclic evidence chain")
  visited.add(path)
  const summary = JSON.parse(readFileSync(resolve(path, "summary.json"), "utf8"))
  const lines = (name) => readFileSync(resolve(path, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
  const start = lines("events.jsonl").find(e => e.type === "start")
  assert(start?.models, "Missing per-run model price snapshot")
  sources.push({ dir: path, summary, prices: new Map(start.models.map(m => [m.id, m.cost])), requests: lines("requests.jsonl") })
  dir = summary.previousDir
}
const problems = [], observations = [], seenPrimeHashes = new Set()
const stats = { records: 0, successful: 0, providerFailures: 0, rawCounterChecks: 0, costChecks: 0,
  unchangedPayloadChecks: 0, wallTimingChecks: 0, delayedRequests: 0, maxClockDifferenceMs: 0 }
let computedTotal = 0, carriedExtra = 0
for (const source of sources.toReversed()) {
  const arms = new Map()
  carriedExtra += source.summary.extraPriorCostUsd ?? 0
  for (const [index, r] of source.requests.entries()) {
    stats.records++
    const where = `${source.dir.split("/").at(-1)}:${index + 1}`
    try {
      const u = r.usage, raw = r.rawUsage
      const base = source.prices.get(r.model)
      assert(base, "Model has no recorded price snapshot")
      const prompt = u.input + u.cacheRead + u.cacheWrite
      const tier = [...(base.tiers ?? [])].sort((a, b) => b.inputTokensAbove - a.inputTokensAbove).find(t => prompt > t.inputTokensAbove)
      const rates = tier ?? base
      const long = u.cacheWrite1h ?? 0
      assert(long >= 0 && long <= u.cacheWrite, "Invalid one-hour write subset")
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) assert(Number.isFinite(u[key]) && u[key] >= 0, "Invalid normalized counter")
      const expected = (u.input * rates.input + u.output * rates.output + u.cacheRead * rates.cacheRead
        + (u.cacheWrite - long) * rates.cacheWrite + long * rates.input * 2) / 1e6
      assert(Math.abs(expected - u.cost.total) < 1e-9, "Recalculated total differs from Pi cost")
      if (r.independentlyCalculatedCosts) assert(Math.abs(expected - r.independentlyCalculatedCosts.total) < 1e-9, "Stored probe cost differs")
      computedTotal += expected
      stats.costChecks++
      if (["error", "aborted"].includes(r.stopReason)) { stats.providerFailures++; continue }
      stats.successful++
      assert(raw, "Successful request omitted raw usage")
      const anthropic = r.api === "anthropic-messages"
      const details = r.api === "openai-responses" ? raw.input_tokens_details : raw.prompt_tokens_details
      const read = anthropic ? raw.cache_read_input_tokens : details?.cached_tokens ?? raw.prompt_cache_hit_tokens ?? raw.cached_tokens
      const write = anthropic ? raw.cache_creation_input_tokens : details?.cache_write_tokens
      const input = anthropic ? raw.input_tokens : r.api === "openai-responses" ? raw.input_tokens : raw.prompt_tokens
      const output = anthropic || r.api === "openai-responses" ? raw.output_tokens : raw.completion_tokens
      for (const [value, normalized, name] of [[read, u.cacheRead, "cacheRead"], [write, u.cacheWrite, "cacheWrite"], [output, u.output, "output"]]) {
        if (typeof value === "number") { assert.equal(value, normalized, `Raw/Pi ${name} mismatch`); stats.rawCounterChecks++ }
      }
      if (typeof input === "number" && (anthropic || typeof read === "number")) {
        assert.equal(anthropic ? input : input - read - (write ?? 0), u.input, "Raw/Pi uncached input mismatch")
        stats.rawCounterChecks++
      }
      if (typeof raw.cache_creation?.ephemeral_1h_input_tokens === "number") {
        assert.equal(raw.cache_creation.ephemeral_1h_input_tokens, long, "Raw/Pi one-hour write mismatch")
        stats.rawCounterChecks++
      }
      assert(r.responseModel, "Response model identity absent")
      const key = `${r.configuration}/${r.intervalMinutes}/${r.repeat}`
      if (r.phase === "prime") {
        assert(r.payloadHash && !seenPrimeHashes.has(r.payloadHash), "Prime reused another test entry's payload")
        seenPrimeHashes.add(r.payloadHash)
        arms.set(key, { prime: r, previous: r, control: null })
        continue
      }
      const arm = arms.get(key)
      assert(arm, "No prime for this trial")
      assert.equal(r.payloadHash, arm.prime.payloadHash, "Outgoing payload changed within trial")
      assert.equal(r.responseModel, arm.prime.responseModel, "Response model changed within trial")
      stats.unchangedPayloadChecks++
      const wallIdle = Date.parse(r.sentAt) - Date.parse(arm.previous.completedAt)
      const drift = Math.abs(wallIdle - r.idleMs)
      stats.maxClockDifferenceMs = Math.max(stats.maxClockDifferenceMs, drift)
      assert(drift < 2000, "Recorded idle time disagrees with wall timestamps")
      if (r.clockDriftMs !== undefined && r.clockDriftMs !== null) assert(Math.abs(r.clockDriftMs) < 2000, "Clock/sleep discontinuity")
      stats.wallTimingChecks++
      if (r.phase === "immediate" || r.phase === "immediate-recheck") arm.control = r
      if (r.phase === "after-idle") {
        assert(arm.control && typeof read === "number", "Delayed probe lacks warm control or explicit raw read counter")
        const cu = arm.control.usage
        assert(cu.cacheRead / (cu.input + cu.cacheRead + cu.cacheWrite) >= 0.8, "Warm control insufficient")
        const controlRead = cu.cacheRead
        const classification = read === 0 ? "miss" : read >= controlRead * 0.95 ? "retained" : "partial"
        observations.push({ model: r.model, retention: r.retention, targetMinutes: r.intervalMinutes,
          actualIdleMinutes: wallIdle / 60000, repeat: r.repeat, classification,
          cachedTokens: read, controlCachedTokens: controlRead, unchangedPayload: true })
        stats.delayedRequests++
      }
      arm.previous = r
    } catch (error) { problems.push({ where, message: error.message }) }
  }
}
const snapshot = sources[0].summary
const report = { capturedAt: new Date().toISOString(), liveRun: !snapshot.finished,
  sourceRuns: sources.map(s => s.dir.split("/").at(-1)), stats,
  recalculatedRecordedCostUsd: computedTotal, separatelyCarriedEarlierExperimentUsd: carriedExtra,
  ledgerTotalUsd: snapshot.calculatedCostUsd,
  ledgerDifferenceUsd: snapshot.calculatedCostUsd - computedTotal - carriedExtra,
  problems, observations }
writeFileSync(resolve(metadata.dir, "verification.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
console.log(JSON.stringify({ ...report, observations: undefined }, null, 2))
if (problems.length) process.exitCode = 1
