#!/usr/bin/env node
// Paid, opt-in experiment. Uses local Pi auth; never logs credentials or model output.
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"
import { ModelRuntime } from "@earendil-works/pi-coding-agent"

if (!process.argv.includes("--paid")) throw Error("Paid test: explicitly pass --paid")
const idleMs = Number(process.env.PROBE_IDLE_MS ?? 360000)
const trials = Number(process.env.PROBE_TRIALS ?? 3)
assert(Number.isInteger(trials) && trials >= 1 && trials <= 3)
assert(Number.isFinite(idleMs) && idleMs >= 360000 && idleMs <= 3900000)
const runtime = await ModelRuntime.create({ allowModelNetwork: false })
const provider = process.env.PI_PROVIDER ?? "github-copilot"
const model = runtime.getModel(provider, process.env.PI_MODEL ?? "gpt-6.1-sol")
assert(model && provider === "github-copilot" && model.api === "openai-responses")
const runId = randomUUID()
const dir = resolve(".scratch/cache-probe", runId)
mkdirSync(dir, { recursive: true, mode: 0o700 })
const logPath = resolve(dir, "requests.jsonl")
const records = [], invalidTrials = []
let totalCost = 0, requests = 0
const budgetUsd = 2, maxRequests = trials * 2 * 3
const write = (value) => {
  appendFileSync(logPath, JSON.stringify(value) + "\n", { mode: 0o600 })
  console.log(JSON.stringify(value))
}
const cost = (u) => {
  const p = model.cost
  return (u.input * p.input + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6
}
write({ type: "start", runId, dir, model: model.id, provider, api: model.api,
  baseUrl: model.baseUrl, compat: model.compat, catalogPricesPerMillion: model.cost,
  idleMs, trials, budgetUsd, maxRequests, startedAt: new Date().toISOString() })

async function request(arm, phase) {
  // UTF-8 byte count is a conservative input token upper bound for this ASCII fixture.
  // Reserve the maximum input/cache-write rate and the entire output allowance.
  const reserve = Buffer.byteLength(JSON.stringify(arm.context)) * Math.max(model.cost.input, model.cost.cacheWrite)
    / 1e6 + 256 * model.cost.output / 1e6 + 0.01
  assert(totalCost + reserve < budgetUsd, "Estimated cost cap reached")
  assert(++requests <= maxRequests, "Request cap reached")
  let payloadHash, sentCacheSettings, rawUsage, status, responseId, responseModel
  const started = performance.now(), startedAt = new Date().toISOString()
  const message = await runtime.complete(model, arm.context, {
    cacheRetention: arm.retention, reasoningEffort: "medium", maxTokens: 256,
    sessionId: arm.sessionId, maxRetries: 0, timeoutMs: 60000,
    onPayload(payload) {
      const encoded = JSON.stringify(payload)
      payloadHash = createHash("sha256").update(encoded).digest("hex")
      sentCacheSettings = {
        prompt_cache_retention: payload.prompt_cache_retention ?? null,
        prompt_cache_options: payload.prompt_cache_options ?? null,
        prompt_cache_key: payload.prompt_cache_key ?? null,
      }
    },
    onResponse(response) { status = response.status },
    onProviderStreamEvent(event) {
      if (event.response?.usage) {
        rawUsage = structuredClone(event.response.usage)
        responseId = event.response.id
        responseModel = event.response.model
      }
    },
  })
  const completed = performance.now()
  const record = { type: "request", arm: arm.id, retention: arm.retention, phase,
    startedAt, completedAt: new Date().toISOString(), durationMs: completed - started,
    idleSinceLastCompletionMs: arm.completed === undefined ? null : started - arm.completed,
    payloadHash, sentCacheSettings, status, responseId, responseModel,
    stopReason: message.stopReason, errorMessage: message.errorMessage,
    rawUsage: rawUsage ?? null, usage: message.usage,
    inputCostUsd: cost(message.usage), totalCostUsd: message.usage.cost.total }
  arm.completed = completed
  const charge = Number(message.usage.cost.total)
  assert(Number.isFinite(charge) && charge >= 0, "Invalid calculated cost")
  totalCost += charge
  records.push(record)
  write(record)
  assert(message.stopReason !== "error" && message.stopReason !== "aborted", message.errorMessage ?? "Provider failed")
  assert(rawUsage, "No raw usage received; experiment is inconclusive")
  assert(Object.hasOwn(rawUsage.input_tokens_details ?? {}, "cached_tokens"), "Missing raw cache counter")
  assert(payloadHash, "Outgoing payload was not captured")
  assert.equal(message.usage.cacheRead, rawUsage.input_tokens_details.cached_tokens, "Pi/raw cache counts differ")
  assert(totalCost < budgetUsd, "Estimated cost cap exceeded")
  return record
}

const arms = []
for (let trial = 1; trial <= trials; trial++) {
  for (const retention of ["short", "long"]) {
    const sessionId = randomUUID()
    // Unique prefix per arm prevents our own trials from warming one another.
    const systemPrompt = `Independent cache experiment ${sessionId}. Read the reference and reply with only OK. Do not analyze or summarize it.`
    const content = Array.from({ length: 220 }, (_, i) =>
      `Reference row ${i}: orchard meadow river stone copper amber cedar north south east west. Value ${(i * 7919) % 100003}.`).join("\n")
    arms.push({ id: `${retention}-${trial}`, retention, sessionId,
      context: { systemPrompt, messages: [{ role: "user", content, timestamp: 0 }] } })
  }
}

try {
  // Sequential priming prevents bursts from confusing the control result.
  // Every valid arm gets its own completion-relative idle deadline.
  for (const arm of arms) {
    arm.prime = await request(arm, "prime")
    await delay(1500)
    arm.control = await request(arm, "immediate")
    assert.equal(arm.prime.payloadHash, arm.control.payloadHash, "Payload changed during priming")
    const u = arm.control.usage
    const fraction = u.cacheRead / (u.input + u.cacheRead + u.cacheWrite)
    if (fraction < 0.8) {
      invalidTrials.push(arm.id)
      write({ type: "invalid-control", arm: arm.id, cachedFraction: fraction })
      continue
    }
    arm.deadline = arm.completed + idleMs
  }
  const valid = arms.filter((a) => a.deadline !== undefined)
  assert(valid.length > 0, "No valid warm controls; do not run timed probes")
  for (const arm of valid.sort((a, b) => a.deadline - b.deadline)) {
    const waitMs = Math.max(0, arm.deadline - performance.now())
    write({ type: "waiting", arm: arm.id, waitMs })
    await delay(waitMs)
    arm.timed = await request(arm, "after-idle")
    assert.equal(arm.control.payloadHash, arm.timed.payloadHash, "Payload changed across idle interval")
    assert(arm.timed.idleSinceLastCompletionMs >= idleMs - 10, "Idle interval too short")
  }
  const summary = { type: "summary", runId, model: model.id, provider, totalCostUsd: totalCost,
    requests, invalidTrials, results: valid.map((arm) => {
      const c = arm.control, t = arm.timed
      const tokens = t.usage.input + t.usage.cacheRead + t.usage.cacheWrite
      const noReuseAtInputRateUsd = tokens * model.cost.input / 1e6
      return { arm: arm.id, retention: arm.retention, idleMs: t.idleSinceLastCompletionMs,
        sentCacheSettings: t.sentCacheSettings,
        controlCachedTokens: c.usage.cacheRead, timedCachedTokens: t.usage.cacheRead,
        retainedFractionOfControl: t.usage.cacheRead / c.usage.cacheRead,
        timedCachedFraction: t.usage.cacheRead / tokens,
        primeInputCostUsd: arm.prime.inputCostUsd, controlInputCostUsd: c.inputCostUsd,
        timedInputCostUsd: t.inputCostUsd, noReuseAtInputRateUsd,
        savingVsInputRateUsd: noReuseAtInputRateUsd - t.inputCostUsd,
        payloadUnchanged: c.payloadHash === t.payloadHash }
    }) }
  writeFileSync(resolve(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 })
  write(summary)
} catch (error) {
  write({ type: "failed", message: error.message, totalCostUsd: totalCost, requests })
  process.exitCode = 1
}
