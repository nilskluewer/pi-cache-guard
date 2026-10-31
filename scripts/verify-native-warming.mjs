#!/usr/bin/env node
// Opt-in live Pi SDK verification. Synthetic prompts only; isolated settings/sessions.
// A test-only decision override exercises one refresh without buying a 140k-token prompt.
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createAgentSessionServices, createAgentSessionFromServices, getAgentDir,
  ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import extension from "../extensions/cache-guard.ts"
import { HANDOFF_ENTRY_TYPE } from "../extensions/handoff.ts"

if (!process.argv.includes("--paid")) throw new Error("Live provider requests: explicitly pass --paid")
const originalAgentDir = getAgentDir()
const root = mkdtempSync(join(realpathSync(tmpdir()), "pi-native-warming-live-"))
const provider = process.env.PI_PROVIDER ?? "github-copilot"
const id = process.env.PI_MODEL ?? "gpt-6.1-sol"
const originalRetention = process.env.PI_CACHE_RETENTION
process.env.PI_CACHE_RETENTION = "short"
const results = []
const report = resolve(".scratch/native-warming-live.json")
mkdirSync(resolve(".scratch"), { recursive: true })
let totalCost = 0, requests = 0
const budgetUsd = 0.25, maxRequests = 4

async function run(forceOneWarm) {
  const dir = join(root, forceOneWarm ? "refresh-path" : "native-stop")
  const cwd = join(dir, "workspace"), agentDir = join(dir, "agent")
  mkdirSync(cwd, { recursive: true }); mkdirSync(join(agentDir, "cache-guard"), { recursive: true })
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "idle", compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0, timeoutMs: 20000 } } }))
  writeFileSync(join(agentDir, "cache-guard", "settings.json"), JSON.stringify({ autoHandoff: true,
    handoffColdCostThresholdUsd: 0, budgetUsd: 10, placement: "footer" }))
  // 30 seconds is conservative for the tested provider route. This accelerates
  // the scheduler check; it does not claim a measured provider cache expiry.
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { [provider]: {
    modelOverrides: { [id]: { promptCache: { short: 30 }, maxTokens: 16 } },
  } } }))
  const modelRuntime = await ModelRuntime.create({ authPath: join(originalAgentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"), modelsStorePath: join(agentDir, "catalog.json"),
    allowModelNetwork: false, refreshOnCreate: false })
  const model = modelRuntime.getModel(provider, id)
  assert.ok(model, "Configured live model must exist")
  assert.ok(["anthropic-messages", "openai-responses"].includes(model.api), "Probe supports Anthropic and Responses routes")
  assert.equal(model.promptCache.short, 30)
  assert.equal(model.maxTokens, 16)
  const manager = SessionManager.create(cwd, join(dir, "sessions"))
  const settings = SettingsManager.create(cwd, agentDir)
  const decisions = [], errors = [], statuses = [], requestCaps = [], rawReadTokens = []
  let reserveTotal = 0
  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: settings,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => extension(pi, { handoff: { agentDir, tempDir: dir } }), pi => {
        pi.on("before_provider_request", event => {
          const cap = event.payload.max_tokens ?? event.payload.max_output_tokens
          assert.ok(cap <= 16, "Probe output cap must remain bounded")
          assert.ok(++requests <= maxRequests, "Probe request cap reached")
          const reserve = Buffer.byteLength(JSON.stringify(event.payload)) * Math.max(model.cost.input, model.cost.cacheWrite)
            / 1e6 + cap * model.cost.output / 1e6
          reserveTotal += reserve
          assert.ok(totalCost + reserveTotal < budgetUsd, "Conservative ASCII input/output reserve exceeds probe budget")
          requestCaps.push(cap)
        })
        pi.on("provider_stream_event", event => {
          const u = event.data?.message?.usage ?? event.data?.usage
          const read = u?.cache_read_input_tokens ?? event.data?.response?.usage?.input_tokens_details?.cached_tokens
          if (typeof read === "number") rawReadTokens.push(read)
        })
        pi.on("cache_warming_decision", event => {
          decisions.push(structuredClone(event))
          // Probe only. Production Cache Guard always returns undefined.
          if (forceOneWarm && decisions.length === 1) return { action: "warm" }
        })
      }] } })
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model,
    thinkingLevel: "off", noTools: true })
  const warms = () => manager.getEntries().filter(e => e.type === "usage" && e.kind === "cache_warm")
  const handoffs = () => manager.getEntries().filter(e => e.type === "custom" && e.customType === HANDOFF_ENTRY_TYPE)
  try {
    await session.bindExtensions({ mode: "tui", onError: e => errors.push(String(e.message ?? e)), uiContext: {
      setStatus: (_key, value) => { if (value) statuses.push(value) }, setWidget() {}, notify() {},
      theme: { fg: (_color, text) => text },
      select: async () => { throw new Error("Live probe must not open a send dialog") },
    } })
    const reference = Array.from({ length: 180 }, (_, n) => `Reference ${n}: orchard meadow river stone copper amber cedar. Value ${n * 17}.`).join("\n")
    await session.prompt(`Synthetic cache verification. Do not call tools. Reply only OK.\n${reference}`)
    assert.deepEqual(errors, [])
    const response = session.messages.filter(m => m.role === "assistant").at(-1)
    assert.equal(response.stopReason, "stop", response.errorMessage ?? "Live request must complete")
    const contextBefore = structuredClone(session.messages)
    const statsBefore = session.getSessionStats()
    assert.ok(statsBefore.contextUsage.tokens > 0)
    assert.match(statuses.at(-1), /~1m.*declared est\./)
    const deadline = Date.now() + 35000
    while (Date.now() < deadline) {
      assert.deepEqual(errors, [])
      assert.equal(handoffs().length, 0, "Native idle warming must not be preempted by handoff")
      if (forceOneWarm ? warms().length === 1 : decisions.length === 1 && session.cacheWarmingStatus.state === "inactive") break
      await delay(50)
    }
    assert.equal(decisions.length, 1, "One native cache-warming decision must be observed")
    assert.equal(decisions[0].action, "stop", "Small real prompt must stay below Pi's native savings threshold")
    assert.deepEqual(session.messages, contextBefore, "Refresh must not enter model context")
    assert.equal(handoffs().length, 0)
    const statsAfter = session.getSessionStats()
    const warm = warms()[0]
    if (forceOneWarm) {
      assert.ok(warm, "Native warmer must persist the actual live refresh usage")
      assert.equal(warm.note, "extension override", "The probe-only override must be explicit")
      assert.equal(requestCaps.length, 2)
      // Pi's native warmer requests maxTokens: 1. The real Responses adapter
      // clamps that to 16 (OPENAI_RESPONSES_MIN_OUTPUT_TOKENS, pi-ai openai-responses.js).
      const nativeWireCap = model.api === "openai-responses" ? 16 : 1
      assert.equal(requestCaps[1], nativeWireCap, "Native refresh must use the adapter's minimum output cap")
      assert.ok(Math.abs(statsAfter.cost - statsBefore.cost - warm.usage.cost.total) < 1e-9)
      assert.equal(statsAfter.tokens.cacheRead, statsBefore.tokens.cacheRead + warm.usage.cacheRead)
      assert.equal(statsAfter.contextUsage.tokens, statsBefore.contextUsage.tokens)
      await delay(1100)
      assert.match(statuses.at(-1), /declared est\./)
      assert.equal(handoffs().length, 0)
      assert.ok(warm.usage.cacheRead > 0, "Live provider must report a cache read; otherwise reuse is unverified")
    } else {
      assert.equal(warms().length, 0)
      assert.equal(requestCaps.length, 1, "Native cost stop must not dispatch another request")
      assert.equal(session.cacheWarmingStatus.reason, "expected savings below threshold")
    }
    totalCost += statsAfter.cost
    assert.ok(totalCost < budgetUsd)
    const result = { case: forceOneWarm ? "probe-forced-refresh" : "native-cost-stop", provider, model: id,
      sessionFile: session.sessionFile, declaredLifetimeSeconds: 30, decisions, requestCaps, rawReadTokens,
      warmingStatus: session.cacheWarmingStatus, warmUsage: warm?.usage, contextUnchanged: true,
      automaticHandoffs: handoffs().length, costUsd: statsAfter.cost, lastDisplay: statuses.at(-1) }
    results.push(result)
    console.log(JSON.stringify(result))
  } finally {
    await session.abort()
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })
    session.dispose()
  }
}

try {
  await run(false)
  await run(true)
  console.log(`PASS: live Pi sessions verified; ${requests} requests, catalog cost $${totalCost.toFixed(5)}`)
} catch (error) {
  console.error(error)
  results.push({ failed: String(error.message ?? error) })
  process.exitCode = 1
} finally {
  if (originalRetention === undefined) delete process.env.PI_CACHE_RETENTION
  else process.env.PI_CACHE_RETENTION = originalRetention
  writeFileSync(report, JSON.stringify({ root, budgetUsd, maxRequests, requests, totalCostUsd: totalCost, results }, null, 2) + "\n", { mode: 0o600 })
  console.log(`Report: ${report}`)
}
