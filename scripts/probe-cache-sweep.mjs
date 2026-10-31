#!/usr/bin/env node
// Paid Copilot experiment. No background agent/tool turns; each synthetic prefix is isolated.
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import { classifyReuse, computeCost, createUsageCollector, inspectCacheSettings, rawCounters } from "./cache-probe-support.mjs"

if (!process.argv.includes("--paid")) throw Error("Requires explicit --paid; uses local Copilot authentication")
const budgetUsd = 20, requestLimit = 1000, maxWallMs = 48 * 3600000
const minutes = [2, 6, 12, 35, 65, 125, 245, 485, 1445]
const prefixRows = [220, 660, 1320]
const milestoneMinutes = process.env.PROBE_MILESTONES ? [...new Set(process.env.PROBE_MILESTONES.split(",").map(Number))].sort((a, b) => a - b) : []
assert(milestoneMinutes.every(m => Number.isFinite(m) && m > 0 && m <= 1445), "Invalid milestone intervals")
const retentions = process.env.PROBE_RETENTIONS?.split(",") ?? ["short", "long"]
assert(retentions.length > 0 && retentions.every(r => ["short", "long"].includes(r)), "Invalid retention list")
const extraPriorCostUsd = Number(process.env.PROBE_EXTRA_PRIOR_COST_USD ?? 0)
assert(Number.isFinite(extraPriorCostUsd) && extraPriorCostUsd >= 0 && extraPriorCostUsd < budgetUsd)
const selectedModelIds = process.env.PROBE_MODELS?.split(",").map(id => id.trim()) ?? null
assert(!selectedModelIds || (selectedModelIds.length > 0 && selectedModelIds.every(Boolean)), "Invalid model allowlist")
const runtime = await ModelRuntime.create({ allowModelNetwork: false })
const models = (await runtime.getAvailable("github-copilot")).filter(m => selectedModelIds
  ? selectedModelIds.includes(m.id)
  : /claude|gemini/i.test(m.id + " " + m.name) || m.id === process.env.PROBE_INCLUDE_MODEL)
assert(models.length > 0 && models.length <= 24, "Unexpected subscription model list")
assert(!selectedModelIds || selectedModelIds.every(id => models.some(m => m.id === id)), "Requested model is unavailable")
assert(models.every(m => ["anthropic-messages", "openai-completions", "openai-responses"].includes(m.api)), "Unsupported protocol")
const runId = randomUUID(), root = resolve(".scratch/cache-probe"), dir = resolve(root, `sweep-${runId}`)
mkdirSync(dir, { recursive: true, mode: 0o700 })
const started = performance.now(), startedWall = Date.now(), startedAt = new Date(startedWall).toISOString()
const previousDir = process.env.PROBE_PREVIOUS_DIR ? resolve(process.env.PROBE_PREVIOUS_DIR) : null
const previous = previousDir ? JSON.parse(readFileSync(resolve(previousDir, "summary.json"), "utf8")) : null
assert(!previous || previous.finished, "Previous runner must be stopped before importing its evidence")
const priorRequests = previousDir ? readFileSync(resolve(previousDir, "requests.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []
const pending = [], timed = [], results = [...(previous?.results ?? [])], configs = []
let requestCount = previous?.requestCount ?? 0, calculatedCost = (previous?.calculatedCostUsd ?? 0) + extraPriorCostUsd
let conservativeSpend = (previous?.conservativeSpendUsd ?? 0) + extraPriorCostUsd, stopped = null, finished = false
let maxRequestDurationMs = 5000
// Historical failures without usage retain an upper-bound allowance too.
for (const r of priorRequests.filter(r => r.chargeUncertain === undefined && (!r.rawUsage || ["error", "aborted"].includes(r.stopReason)))) {
  const model = models.find(m => m.id === r.model)
  if (model) {
    const rows = previous.configurations.find(c => c.id === r.configuration)?.rows ?? 1320
    const rates = [model.cost, ...(model.cost.tiers ?? [])]
    conservativeSpend += (rows * 120 + 2048) * Math.max(...rates.flatMap(p => [p.input * 2, p.cacheWrite])) / 1e6
      + 512 * Math.max(...rates.map(p => p.output)) / 1e6
  }
}
const save = (path, value) => writeFileSync(resolve(dir, path), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
writeFileSync(resolve(root, "latest-sweep.json"), JSON.stringify({ runId, dir, pid: process.pid, startedAt }) + "\n", { mode: 0o600 })
const event = (value) => {
  appendFileSync(resolve(dir, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...value }) + "\n", { mode: 0o600 })
  console.log(JSON.stringify(value))
}
function status() {
  const snapshot = { runId, dir, previousDir, pid: process.pid, startedAt, updatedAt: new Date().toISOString(),
    finished, stopped, budgetUsd, requestLimit, requestCount, selectedModelIds, milestoneMinutes, extraPriorCostUsd, calculatedCostUsd: calculatedCost,
    conservativeSpendUsd: conservativeSpend, scheduledTimedRequests: timed.length,
    pendingGroups: pending.length, results,
    configurations: configs.map(c => ({ id: c.id, model: c.model.id, api: c.model.api, retention: c.retention,
      rows: prefixRows[c.size], state: c.state, lowerMinutes: c.lower, upperMinutes: c.upper,
      milestonesDone: c.milestonesDone, milestonesTotal: milestoneMinutes.length,
      progress: c.progress, settings: c.settings })) }
  save("summary.json", snapshot)
  const table = configs.map(c => `| ${c.model.id} | ${c.retention} | ${c.state} | ${c.lower?.toFixed(2) ?? "—"} | ${c.upper?.toFixed(2) ?? "—"} | ${(c.progress ?? "").replaceAll("|", "/")} |`).join("\n")
  const body = `# Copilot cache-retention experiment\n\nStarted: ${startedAt}. Updated: ${snapshot.updatedAt}.\n\nStatus: **${finished ? "finished" : "running"}**${stopped ? ` (${stopped})` : ""}. Requests: ${requestCount}/${requestLimit}. Pi-calculated cost: $${calculatedCost.toFixed(6)}. Conservative budget accounting: $${conservativeSpend.toFixed(6)} / $${budgetUsd}.\n\n| Model | Requested retention | Status | Longest reproduced hit (min) | Shortest reproduced miss (min) | Latest observation |\n|---|---|---|---:|---:|---|\n${table}\n\nIntervals use separate synthetic prefixes. Each cell has two independent trials, an immediate positive control, and a delayed repeat. A repeated miss triggers immediate recovery controls. Mixed results get a third trial and are reported as variable. Missing raw cache counters are unknown, not zero. Boundaries are observational, not guaranteed provider TTLs.\n\nThe report stores requested intervals; exact measured idle durations, raw numeric usage, retention fields, payload hashes, and independently checked costs are in requests.jsonl. Costs use Pi catalog prices, not independently verified GitHub charges. Missing Anthropic one-hour write splits make those write costs uncertain; conservative accounting reserves the larger rate.\n\nTo stop without deleting evidence, create a file named STOP in this report directory. The runner stops before the next paid request. If the computer sleeps, the actual idle interval can exceed the target; those trials are marked timing-deviated and cannot define a boundary.\n`
  writeFileSync(resolve(dir, "report.md"), body, { mode: 0o600 })
}
function checkStop() {
  if (existsSync(resolve(dir, "STOP"))) throw Error("User stop file detected")
  if (Date.now() - startedWall > maxWallMs || performance.now() - started > maxWallMs) throw Error("48-hour wall limit reached")
  if (requestCount >= requestLimit) throw Error("Request limit reached")
}
async function sleep(ms) { await delay(ms) }
function makeArm(c, interval, repeat) {
  const sessionId = randomUUID()
  return { c, interval, repeat, sessionId, completed: null, completedWall: null,
    context: { systemPrompt: `Independent cache experiment ${sessionId}. Read the reference. Reply with only OK. Do not summarize it.`,
      messages: [{ role: "user", timestamp: 0, content: Array.from({ length: prefixRows[c.size] }, (_, i) =>
        `Reference row ${i}: orchard meadow river stone copper amber cedar north south east west. Value ${(i * 7919) % 100003}.`).join("\n") }] } }
}
async function request(arm, phase) {
  checkStop()
  const { c } = arm, model = c.model
  const maxOutput = 512
  const rates = [model.cost, ...(model.cost.tiers ?? [])]
  const rate = Math.max(...rates.flatMap(p => [p.input * 2, p.cacheWrite]))
  const reserve = (Buffer.byteLength(JSON.stringify(arm.context)) + 1024) * rate / 1e6 + maxOutput * Math.max(...rates.map(p => p.output)) / 1e6
  if (conservativeSpend + reserve > budgetUsd) throw Error("Conservative cost cap reached")
  // Hold the reservation before contacting the provider. If anything throws, keep it.
  conservativeSpend += reserve
  requestCount++
  const collector = createUsageCollector(model.api)
  let payloadHash = null, cacheSettings = null, responseStatus = null
  const start = performance.now(), startWall = Date.now(), sentAt = new Date(startWall).toISOString()
  const response = await runtime.complete(model, arm.context, {
    cacheRetention: c.retention, sessionId: arm.sessionId, maxTokens: maxOutput,
    maxRetries: 0, timeoutMs: 90000, thinkingEnabled: true, effort: "low",
    onPayload(payload) {
      payloadHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex")
      cacheSettings = inspectCacheSettings(payload)
    },
    onResponse(r) { responseStatus = r.status },
    onProviderStreamEvent: collector.observe,
  })
  const completion = performance.now(), completionWall = Date.now(), observed = collector.snapshot()
  maxRequestDurationMs = Math.max(maxRequestDurationMs, completion - start)
  const counters = rawCounters(model.api, observed.rawUsage)
  const costs = computeCost(model, response.usage)
  const splitUnknown = model.api === "anthropic-messages" && c.retention === "long"
    && response.usage.cacheWrite > 0 && counters.cacheWrite1h === null
  const upperCosts = splitUnknown ? computeCost(model, { ...response.usage, cacheWrite1h: response.usage.cacheWrite }) : costs
  calculatedCost += costs.total
  const failed = ["error", "aborted"].includes(response.stopReason)
  const chargeUncertain = !observed.rawUsage || failed
  if (!chargeUncertain) conservativeSpend += Math.max(costs.total, upperCosts.total) - reserve
  const record = { model: model.id, api: model.api, configuration: c.id, retention: c.retention,
    intervalMinutes: arm.interval, repeat: arm.repeat, phase, sentAt, completedAt: new Date(completionWall).toISOString(),
    idleMs: arm.completedWall === null ? null : startWall - arm.completedWall,
    monotonicIdleMs: arm.completed === null ? null : start - arm.completed,
    clockDriftMs: arm.completed === null ? null : (startWall - arm.completedWall) - (start - arm.completed),
    durationMs: completion - start, wallDurationMs: completionWall - startWall, chargeUncertain,
    payloadHash, cacheSettings, status: responseStatus, responseModel: observed.responseModel,
    rawUsage: observed.rawUsage, rawEvents: observed.rawEvents, rawCounters: counters,
    usage: response.usage, independentlyCalculatedCosts: costs, longWriteSplitUnknown: splitUnknown,
    stopReason: response.stopReason, error: response.errorMessage?.slice(0, 600) }
  appendFileSync(resolve(dir, "requests.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 })
  arm.completed = completion
  arm.completedWall = completionWall
  event({ type: "request", model: model.id, retention: c.retention, interval: arm.interval, repeat: arm.repeat,
    phase, reportedCacheRead: counters.cacheRead, cacheWrite: response.usage.cacheWrite,
    promptCost: costs.promptTotal, stopReason: response.stopReason })
  status()
  assert(Math.abs(costs.total - response.usage.cost.total) < 1e-9, "Independent price calculation differs from Pi")
  if (["error", "aborted"].includes(response.stopReason)) throw Error(response.errorMessage?.slice(0, 300) ?? "Provider request failed")
  assert(payloadHash, "Payload not captured")
  if (counters.cacheReadReported) assert.equal(counters.cacheRead, response.usage.cacheRead, "Raw/Pi read mismatch")
  if (counters.cacheWriteReported) assert.equal(counters.cacheWrite, response.usage.cacheWrite, "Raw/Pi write mismatch")
  if (counters.input !== null) assert.equal(counters.input, response.usage.input, "Raw/Pi input mismatch")
  if (counters.output !== null) assert.equal(counters.output, response.usage.output, "Raw/Pi output mismatch")
  if (conservativeSpend > budgetUsd) throw Error("Conservative cost cap exceeded")
  assert(Math.abs(record.wallDurationMs - record.durationMs) < 2000, "Clock or sleep discontinuity during request")
  if (record.clockDriftMs !== null) assert(Math.abs(record.clockDriftMs) < 2000, "Clock or sleep discontinuity during idle window")
  c.settings = cacheSettings
  return record
}
function fraction(record) {
  const u = record.usage
  return u.cacheRead / (u.input + u.cacheRead + u.cacheWrite)
}
function queueGroup(c, interval, refinement = false, milestone = false) {
  c.state = refinement ? "refining observed boundary" : "testing"
  c.progress = `Preparing ${interval}-minute interval`
  const group = { c, interval, refinement, milestone, outcomes: [], failed: false, arms: [] }
  pending.push({ group, repeat: 1 }, { group, repeat: 2 })
}
function failGroup(group, state, reason) {
  group.failed = true
  group.c.disabled = true
  group.c.state = state
  group.c.progress = reason
  event({ type: state, configuration: group.c.id, interval: group.interval, reason })
}
async function prepare({ group, repeat }) {
  if (group.failed || group.c.disabled) return
  const c = group.c, arm = makeArm(c, group.interval, repeat)
  try {
    arm.prime = await request(arm, "prime")
    await sleep(2000)
    arm.control = await request(arm, "immediate")
    assert.equal(arm.prime.payloadHash, arm.control.payloadHash, "Payload changed during warm control")
    assert(arm.prime.responseModel && arm.control.responseModel, "Returned model identity missing")
    assert.equal(arm.prime.responseModel, arm.control.responseModel, "Returned model changed")
    if (!arm.control.rawCounters.cacheReadReported) {
      failGroup(group, "telemetry unavailable", "No raw cache-read counter; cannot measure duration")
      return
    }
    // Allow cache propagation, but never assume an explicit zero means unsupported caching.
    if (fraction(arm.control) < 0.8) {
      await sleep(5000)
      arm.control = await request(arm, "immediate-recheck")
      assert.equal(arm.prime.payloadHash, arm.control.payloadHash)
      assert(arm.control.responseModel, "Recheck model identity missing")
      assert.equal(arm.prime.responseModel, arm.control.responseModel, "Returned model changed during recheck")
      if (!arm.control.rawCounters.cacheReadReported) {
        failGroup(group, "telemetry unavailable", "Recheck omitted raw cache-read counters")
        return
      }
      if (fraction(arm.control) < 0.8) {
        if (!milestoneMinutes.length && c.lower === null && c.upper === null && c.size < prefixRows.length - 1 && group.outcomes.length === 0 && group.arms.length === 0 && repeat === 1) {
          group.failed = true
          c.size++
          event({ type: "increase-prefix", configuration: c.id, rows: prefixRows[c.size] })
          queueGroup(c, group.interval, group.refinement)
        } else failGroup(group, "no reliable warm control", "Immediate repeats did not reuse most of the controlled prefix")
        return
      }
    }
    arm.group = group
    arm.deadline = arm.completed + group.interval * 60000
    group.arms.push(arm)
    timed.push(arm)
    c.progress = `Waiting for ${group.interval}-minute repeats (${group.arms.length} primed)`
  } catch (error) {
    if (/cap|limit|stop file/i.test(error.message)) throw error
    failGroup(group, "request failed", error.message)
  }
}
async function measure(arm) {
  const { group, c } = arm
  if (group.failed || c.disabled) return
  try {
    // Never pay for a trial already invalidated by scheduling or computer sleep.
    const preflightIdle = Date.now() - arm.completedWall
    if (Math.abs(preflightIdle - (performance.now() - arm.completed)) > 2000) {
      failGroup(group, "clock discontinuity", "Computer sleep or wall-clock change; no duration inferred")
      return
    }
    if (preflightIdle > arm.interval * 60000 + 30000) {
      failGroup(group, "timing-deviated", "Deadline missed by more than 30 seconds; no paid delayed request sent")
      return
    }
    const result = await request(arm, "after-idle")
    assert.equal(arm.control.payloadHash, result.payloadHash, "Payload changed across idle window")
    assert(result.responseModel, "Timed response model identity missing")
    assert.equal(arm.control.responseModel, result.responseModel, "Returned model changed")
    if (!result.rawCounters.cacheReadReported) {
      failGroup(group, "telemetry unavailable", "Timed request omitted raw cache-read counters")
      return
    }
    const target = arm.interval * 60000
    if (result.idleMs < target - 10 || result.idleMs > target + 30000) {
      failGroup(group, "timing-deviated", `Target ${arm.interval} minutes; observed ${(result.idleMs / 60000).toFixed(3)} minutes. No boundary inferred.`)
      return
    }
    const outcome = classifyReuse(arm.control.usage, result.usage)
    let recovery = null
    if (outcome !== "retained") {
      await sleep(2000)
      const recovered = await request(arm, "recovery")
      assert.equal(result.payloadHash, recovered.payloadHash)
      assert(recovered.responseModel, "Recovery model identity missing")
      assert.equal(result.responseModel, recovered.responseModel, "Returned model changed during recovery")
      recovery = recovered.rawCounters.cacheReadReported ? classifyReuse(arm.control.usage, recovered.usage) : "unknown"
    }
    const resultRow = { model: c.model.id, retention: c.retention, intervalMinutes: arm.interval,
      repeat: arm.repeat, actualIdleMinutes: result.idleMs / 60000,
      cacheAgeUpperMinutes: (result.idleMs + arm.control.wallDurationMs + result.wallDurationMs) / 60000,
      outcome, recovery,
      cachedTokens: result.usage.cacheRead, controlCachedTokens: arm.control.usage.cacheRead,
      primePromptCost: arm.prime.independentlyCalculatedCosts.promptTotal,
      controlPromptCost: arm.control.independentlyCalculatedCosts.promptTotal,
      timedPromptCost: result.independentlyCalculatedCosts.promptTotal,
      fractionRetained: result.usage.cacheRead / arm.control.usage.cacheRead }
    results.push(resultRow)
    group.outcomes.push(resultRow)
    event({ type: "observation", ...resultRow })
    c.progress = `${arm.interval} min: ${group.outcomes.map(o => o.outcome).join(", ")}`
    if (group.outcomes.length < 2) return
    const outcomes = group.outcomes.map(o => o.outcome)
    const allRetained = outcomes.every(o => o === "retained")
    const allMissed = outcomes.every(o => o === "miss") && group.outcomes.every(o => o.recovery === "retained")
    if (!allRetained && !allMissed && group.outcomes.length === 2) {
      pending.push({ group, repeat: 3 })
      return
    }
    if (!allRetained && !allMissed) {
      c.variable = true
      c.state = "variable / inconclusive"
      c.progress = `${arm.interval} min: ${outcomes.join(", ")}; no fixed TTL inferred`
      finishGroup(group)
      return
    }
    if (allRetained) c.lower = Math.max(c.lower ?? 0, Math.min(...group.outcomes.map(o => o.actualIdleMinutes)))
    else c.upper = Math.min(c.upper ?? Infinity, Math.max(...group.outcomes.map(o => o.cacheAgeUpperMinutes)))
    finishGroup(group)
  } catch (error) {
    if (/cap|limit|stop file/i.test(error.message)) throw error
    failGroup(group, "request failed", error.message)
  }
}
function finishGroup(group) {
  const c = group.c
  if (group.milestone) {
    c.milestonesDone++
    if (c.milestonesDone < milestoneMinutes.length) {
      c.state = c.variable ? "variable / collecting remaining intervals" : "waiting for remaining intervals"
      c.progress = `${c.milestonesDone}/${milestoneMinutes.length} independent milestone groups completed`
      return
    }
  }
  if (c.variable || (c.lower !== null && c.upper !== null && c.lower >= c.upper)) {
    c.state = "variable / inconclusive"
    c.progress = "Trials do not support one monotonic expiry boundary; inspect raw observations"
    return
  }
  advance(c, group.milestone ? Math.max(...milestoneMinutes) : group.interval)
}
function advance(c, interval) {
    if (c.upper !== null && c.lower !== null) {
      if (c.upper - c.lower <= 1) {
        c.state = "observed boundary bracketed"
        c.progress = `Reproduced hits ≥${c.lower.toFixed(2)} min, misses ≤${c.upper.toFixed(2)} min; not a guarantee`
      } else queueGroup(c, Math.round((c.lower + c.upper) * 2) / 4, true)
    } else if (c.upper !== null) {
      if (interval <= 0.5) { c.state = "very short / unstable"; c.progress = "Misses even at 30 seconds" }
      else queueGroup(c, interval / 2, true)
    } else {
      const next = minutes.find(m => m > interval)
      if (next) queueGroup(c, next)
      else { c.state = "survived test horizon"; c.progress = `Reproduced reuse after ${interval} minutes; exact expiry unknown` }
    }
}

for (const model of models) {
  for (const retention of retentions) {
    const c = { id: `${model.id}/${retention}`, model, retention, size: 0, lower: null, upper: null, state: "queued", progress: "", settings: null,
      milestonesDone: 0, disabled: false, variable: false }
    configs.push(c)
    const old = previous?.configurations.find(o => o.id === c.id)
    if (old) {
      c.size = Math.max(0, prefixRows.indexOf(old.rows))
      c.settings = old.settings
      if (old.state === "request failed") {
        c.state = "request failed"
        c.progress = old.progress
        continue
      }
      if (old.state.startsWith("variable")) {
        c.variable = true
        c.state = "variable / no fixed expiry demonstrated"
        c.progress = "Prior independent trials had inconsistent partial/full reuse. No fixed minute-level TTL can be inferred."
        continue
      }
      const observations = (previous.results ?? []).filter(o => o.model === model.id && o.retention === retention)
      for (const interval of new Set(observations.map(o => o.intervalMinutes))) {
        const group = observations.filter(o => o.intervalMinutes === interval)
        if (group.length < 2) continue
        if (group.every(o => o.outcome === "retained")) c.lower = Math.max(c.lower ?? 0, Math.min(...group.map(o => o.actualIdleMinutes)))
        else if (group.every(o => o.outcome === "miss" && o.recovery === "retained")) {
          const upper = Math.max(...group.map(o => {
            if (Number.isFinite(o.cacheAgeUpperMinutes)) return o.cacheAgeUpperMinutes
            const records = priorRequests.filter(r => r.model === model.id && r.retention === retention && r.intervalMinutes === interval && r.repeat === o.repeat)
            const control = records.findLast(r => r.phase === "immediate" || r.phase === "immediate-recheck")
            const result = records.find(r => r.phase === "after-idle")
            return o.actualIdleMinutes + ((control?.durationMs ?? 90000) + (result?.durationMs ?? 90000)) / 60000
          }))
          c.upper = Math.min(c.upper ?? Infinity, upper)
        }
      }
      if (!milestoneMinutes.length && (c.lower !== null || c.upper !== null)) { advance(c, Math.max(...observations.map(o => o.intervalMinutes))); continue }
    }
    if (milestoneMinutes.length) {
      for (const interval of milestoneMinutes) queueGroup(c, interval, false, true)
    } else queueGroup(c, minutes[0])
  }
}
event({ type: "start", runId, dir, models: models.map(m => ({ id: m.id, api: m.api, cost: m.cost, compat: m.compat })),
  budgetUsd, requestLimit, intervalsMinutes: minutes, milestoneMinutes, retentions, independentTrials: 2 })
status()
try {
  while (pending.length || timed.length) {
    checkStop()
    timed.sort((a, b) => a.deadline - b.deadline)
    if (timed.length && timed[0].deadline <= performance.now()) await measure(timed.shift())
    else if (pending.length && (!timed.length || timed[0].deadline - performance.now() > Math.max(15000, maxRequestDurationMs * 3 + 7000))) await prepare(pending.shift())
    else { status(); await sleep(Math.min(30000, Math.max(1, timed[0].deadline - performance.now()))) }
    status()
  }
  finished = true
  event({ type: "finished", requestCount, calculatedCostUsd: calculatedCost })
} catch (error) {
  stopped = error.message
  finished = true
  event({ type: "stopped", reason: stopped, requestCount, calculatedCostUsd: calculatedCost })
  process.exitCode = 1
} finally { status() }
