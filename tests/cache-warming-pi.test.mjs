import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises"
import test from "node:test"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import extension from "../extensions/cache-guard.ts"
import { HANDOFF_ENTRY_TYPE, HANDOFF_PROMPT } from "../extensions/handoff.ts"

// Oracle: Native Pi 1.4 CacheWarmer harmonization policy.
// 1. Authoritative model declaration: valid model.promptCache[retention] > 0 is the authoritative
//    countdown lifetime over seed/learned estimates (including custom/unknown providers); fallback
//    learner/seed applies only when model.promptCache?.[retention] is absent.
// 2. Native idle warming coordination: auto-handoff pauses entirely whenever effective native
//    cacheWarming is "idle" (even when native economics declines, TTL is absent, refresh fails,
//    or the 30-minute idle safety limit stops warming). Native "off" or "streaming" retains
//    existing handoff scheduling.
// 3. Settings precedence: global settings file (agentDir/settings.json) is authoritative for
//    cacheWarming over project settings (.pi/settings.json); pi.getSettings() is the fallback
//    when no global settings file exists (in-memory SDK).
// 4. Read-only decision observer: cache_warming_decision handler returns undefined (never forces warm).
// 5. Independent native economics (cost: input 5, output 25, cacheRead 0.5, cacheWrite 6.25):
//    - 150,000 tokens: missCost = 0.15 * (6.25 - 0.5) = 0.8625; warmCost = 0.15 * 0.5 + 0.000025 = 0.075025;
//      idle expectedSavings = 0.15 * 0.8625 - 0.075025 = 0.05435 >= 0.05 -> action "warm".
//    - 81,600 tokens: missCost = 0.0816 * 5.75 = 0.4692; warmCost = 0.0816 * 0.5 + 0.000025 = 0.040825;
//      idle expectedSavings = 0.15 * 0.4692 - 0.040825 = 0.029555 < 0.05 -> action "stop".

const COST = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }

function tokenUsage(promptTokens, outputTokens = 2) {
  const cacheReadCost = (promptTokens / 1_000_000) * COST.cacheRead
  const outputCost = (outputTokens / 1_000_000) * COST.output
  const total = cacheReadCost + outputCost
  return {
    input: 0,
    output: outputTokens,
    cacheRead: promptTokens,
    cacheWrite: 0,
    totalTokens: promptTokens + outputTokens,
    cost: { input: 0, output: outputCost, cacheRead: cacheReadCost, cacheWrite: 0, total },
  }
}

async function flushAsync(turns = 6) {
  for (let i = 0; i < turns; i++) {
    await nextTurn()
  }
}

async function waitForRealSettle(events, describe) {
  for (let i = 0; i < 400; i++) {
    if (events.some((event) => event.type === "agent_settled")) return
    await delay(10)
  }
  assert.fail(`Pi did not settle: ${JSON.stringify(describe())}`)
}

async function createWarmingFixture(
  t,
  {
    provider = "github-copilot",
    api = "anthropic-messages",
    id = "claude-sonnet-5.5",
    promptCache = { short: 300, long: 3600 },
    retention = "short",
    tokens = 150_000,
    cacheWarming = "idle",
    settingsMode = "inMemory", // "inMemory" | "files"
    globalFileSettings,
    projectFileSettings,
    savedCacheGuard = { autoHandoff: true, handoffColdCostThresholdUsd: 0.5, placement: "footer", budgetUsd: 10 },
    failRefresh = false,
    handoffWriteTool = false,
    mockSetTimeout = true,
  } = {},
) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cache-warming-pi-"))
  const cwd = join(root, "workspace")
  const agentDir = join(root, "agent")
  mkdirSync(cwd)
  mkdirSync(agentDir)

  const envKeys = ["PI_CODING_AGENT_DIR", "PI_CACHE_RETENTION"]
  const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
  let session

  t.after(async () => {
    try {
      if (session) {
        try {
          await session.abort()
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })
        } finally {
          session.dispose()
        }
      }
    } finally {
      t.mock.timers.reset()
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CACHE_RETENTION = retention

  if (savedCacheGuard !== undefined) {
    mkdirSync(join(agentDir, "cache-guard"), { recursive: true })
    writeFileSync(join(agentDir, "cache-guard", "settings.json"), JSON.stringify(savedCacheGuard, null, 2) + "\n")
  }

  if (globalFileSettings !== undefined) {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(globalFileSettings, null, 2) + "\n")
  }
  if (projectFileSettings !== undefined) {
    mkdirSync(join(cwd, ".pi"), { recursive: true })
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(projectFileSettings, null, 2) + "\n")
  }

  const requests = []
  const errors = []
  const statuses = []
  const notes = []
  const events = []
  const decisions = []
  const menus = []
  const outputPath = join(root, "handoff.md")
  const handoffBody = "# Offline handoff\n\nContinue the original task.\n\n## Suggested skills\nNone.\n"

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "catalog.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  })

  modelRuntime.registerProvider(provider, {
    api,
    baseUrl: "http://127.0.0.1:1",
    models: [
      {
        id,
        name: id,
        reasoning: false,
        input: ["text"],
        contextWindow: 200_000,
        maxTokens: 1000,
        promptCache,
        cost: COST,
      },
    ],
    streamSimple: (model, context, options) => {
      const callIndex = requests.length
      const isWarmCall = options?.maxTokens === 1
      requests.push({
        callIndex,
        isWarmCall,
        maxTokens: options?.maxTokens,
        messages: structuredClone(context.messages),
      })

      const stream = new AssistantMessageEventStream()
      const useWriteTool = handoffWriteTool && !isWarmCall && callIndex === 1
      const outputTokens = isWarmCall ? 1 : 2
      const shouldFail = failRefresh && isWarmCall

      const message = {
        role: "assistant",
        provider,
        api: model.api,
        model: model.id,
        timestamp: Date.now(),
        content: useWriteTool
          ? [{ type: "toolCall", id: "offline-handoff-write", name: "write", arguments: { path: outputPath, content: handoffBody } }]
          : [{ type: "text", text: isWarmCall ? "w" : "Offline response" }],
        stopReason: shouldFail ? "error" : useWriteTool ? "toolUse" : "stop",
        ...(shouldFail ? { errorMessage: "simulated native warm failure" } : {}),
        usage: shouldFail
          ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
          : tokenUsage(tokens, outputTokens),
      }

      queueMicrotask(async () => {
        try {
          if (typeof options?.onPayload === "function") {
            const payload =
              api === "anthropic-messages"
                ? { model: model.id, max_tokens: options?.maxTokens ?? 1000, system: context.systemPrompt, messages: context.messages }
                : { model: model.id, messages: context.messages }
            await options.onPayload(payload, model)
          }
          if (!shouldFail && typeof options?.onProviderStreamEvent === "function") {
            const raw =
              api === "anthropic-messages"
                ? {
                    type: "message_start",
                    message: {
                      id: `msg-${callIndex}`,
                      type: "message",
                      role: "assistant",
                      model: model.id,
                      content: [],
                      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: tokens },
                    },
                  }
                : { choices: [{ usage: { prompt_tokens: tokens, completion_tokens: outputTokens, prompt_tokens_details: { cached_tokens: tokens } } }] }
            await options.onProviderStreamEvent(raw, model)
          }
          stream.push({ type: "start", partial: message })
          if (shouldFail) {
            stream.push({ type: "error", reason: "error", error: message })
          } else {
            stream.push({ type: "done", reason: message.stopReason, message })
          }
          stream.end()
        } catch (error) {
          errors.push(error)
          stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } })
          stream.end()
        }
      })
      return stream
    },
  })

  await modelRuntime.setRuntimeApiKey(provider, "offline-fixture-not-a-credential")
  const model = modelRuntime.getModel(provider, id)
  assert.ok(model)

  const manager = SessionManager.create(cwd, join(root, "sessions"))
  const settingsManager =
    settingsMode === "files"
      ? SettingsManager.create(cwd, agentDir)
      : SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
          cacheWarming,
        })

  let extensionDecisionResults = []
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    modelRuntime,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          const originalOn = pi.on.bind(pi)
          pi.on = (event, handler) => {
            if (event === "cache_warming_decision") {
              return originalOn(event, async (ev, ctx) => {
                const res = await handler(ev, ctx)
                extensionDecisionResults.push(res)
                return res
              })
            }
            return originalOn(event, handler)
          }
          return extension(pi, { handoff: { agentDir, tempDir: root } })
        },
        (pi) => {
          pi.on("cache_warming_decision", (event) => {
            decisions.push(structuredClone(event))
            return undefined
          })
        },
      ],
    },
  })

  ;({ session } = await createAgentSessionFromServices({
    services,
    sessionManager: manager,
    model,
    ...(handoffWriteTool ? {} : { noTools: true }),
  }))

  session.subscribe((event) => events.push(event))

  // Enable mocked timers before bindExtensions so the extension's 1s status/handoff setInterval
  // and native CacheWarmer's setTimeout (when mockSetTimeout is true) share the controlled clock.
  const timerApis = mockSetTimeout ? ["Date", "setInterval", "setTimeout"] : ["Date", "setInterval"]
  t.mock.timers.enable({ apis: timerApis, now: Date.now() })

  await session.bindExtensions({
    mode: "tui",
    onError: (error) => errors.push(error),
    uiContext: {
      select: async (title, choices) => {
        if (title === "Cache guard settings") { menus.push([...choices]); return undefined }
        throw new Error("Unexpected cold-send chooser during warming test")
      },
      notify: (text) => notes.push(text),
      setStatus: (_key, value) => {
        if (value) statuses.push(value)
      },
      setWidget: () => {},
      theme: { fg: (_color, text) => text },
    },
  })

  const handoffStates = () =>
    manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === HANDOFF_ENTRY_TYPE)
  const warmEntries = () =>
    manager.getEntries().filter((entry) => entry.type === "usage" && entry.kind === "cache_warm")
  const userMessages = () =>
    manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user")

  return {
    session,
    manager,
    settingsManager,
    requests,
    errors,
    statuses,
    notes,
    events,
    decisions,
    menus,
    records: () => readFileSync(join(agentDir, "cache-guard", "observations.jsonl"), "utf8").trim().split("\n").map(JSON.parse),
    extensionDecisionResults,
    outputPath,
    handoffBody,
    handoffStates,
    warmEntries,
    userMessages,
    tick: async (ms) => {
      t.mock.timers.tick(ms)
      await flushAsync()
    },
    prompt: async (text = "Initial user task") => {
      await session.prompt(text)
      await flushAsync()
      events.length = 0
      assert.deepEqual(errors, [])
    },
  }
}

test(
  "real Pi native idle warming at 150k tokens is not preempted by handoff at t=240s and refreshes at t=270s",
  { timeout: 10000 },
  async (t) => {
    const h = await createWarmingFixture(t, { tokens: 150_000, cacheWarming: "idle" })
    await h.prompt("Keep this 150k context alive")

    assert.equal(h.requests.length, 1)
    assert.equal(h.session.getContextUsage().tokens, 150_002)
    assert.equal(h.session.cacheWarmingStatus.state, "scheduled")
    assert.equal(h.session.cacheWarmingStatus.decision.action, "warm")
    // Independent arithmetic: 0.15 * (0.15 * 5.75) - (0.15 * 0.5 + 0.000025) = 0.05435
    assert.ok(Math.abs(h.session.cacheWarmingStatus.decision.expectedSavings - 0.05435) < 1e-9)

    // Advance to t=240s (60s before the 300s TTL expires, where auto-handoff would normally trigger).
    await h.tick(240_000)

    assert.equal(h.handoffStates().length, 0, "auto-handoff must not preempt native idle cache warming at t=240s")
    assert.equal(h.requests.length, 1, "no handoff or warm request yet at t=240s")
    assert.equal(h.userMessages().length, 1, "no synthetic handoff user message")
    assert.match(h.statuses.at(-1), /1:00/, "countdown reflects 1 minute remaining before native refresh")

    // Advance to t=270s (90% of 300s TTL, when native CacheWarmer fires its refresh).
    await h.tick(30_000)

    assert.equal(h.requests.length, 2, "native CacheWarmer dispatches one 1-token refresh at t=270s")
    assert.equal(h.requests[1].isWarmCall, true)
    assert.equal(h.requests[1].maxTokens, 1)
    assert.equal(h.decisions.length, 1)
    assert.equal(h.decisions[0].action, "warm")
    assert.ok(
      h.extensionDecisionResults.every((res) => res === undefined),
      "cache-guard decision observer must return undefined and never force an override",
    )

    // Verify usage entry appended, session totals updated, context tokens unchanged, no extra user message, and countdown re-anchored.
    const warms = h.warmEntries()
    assert.equal(warms.length, 1, "native refresh appends one cache_warm usage entry")
    assert.equal(warms[0].note, undefined, "no extension override note on native warm entry")
    assert.equal(warms[0].usage.cacheRead, 150_000)
    assert.equal(warms[0].usage.output, 1)

    const stats = h.session.getSessionStats()
    assert.equal(stats.userMessages, 1, "native warm does not add a user message")
    assert.equal(stats.assistantMessages, 1, "native warm does not add an assistant turn")
    assert.equal(stats.tokens.cacheRead, 300_000, "session stats aggregate initial turn + cache_warm usage")
    assert.equal(stats.tokens.output, 3)
    const expectedTotalCost = (150_000 * 0.5 + 2 * 25 + 150_000 * 0.5 + 1 * 25) / 1_000_000
    assert.ok(Math.abs(stats.cost - expectedTotalCost) < 1e-9)
    assert.equal(h.session.getContextUsage().tokens, 150_002, "context token estimate stays invariant across usage entry")
    assert.equal(h.handoffStates().length, 0, "still no handoff after native refresh")

    // 1 second after refresh (t=271s), countdown must be re-anchored near full 5:00 TTL (4:59), not 0:29.
    await h.tick(1_000)
    assert.match(h.statuses.at(-1), /4:59/, "cache_warm entry re-anchors live countdown to fresh 5m window")
    assert.equal(h.records().length, 1, "native refresh has no message_end and must not train the normal learner")
    await h.prompt("Resume normal work after native refresh")
    assert.equal(h.records().length, 2, "normal learning resumes on the next agent turn")
    assert.equal(h.records()[1].qualified, false, "refresh must break the old learning comparison anchor")
    await h.session.prompt("/cache-guard")
    assert.ok(h.menus.at(-1).some(row => /Automatic handoff.*on.*paused.*native idle/.test(row)),
      "saved handoff preference stays on, and the settings menu explains the native-warming pause")
  },
)

test(
  "real Pi native idle warming pauses auto-handoff even when native economics declines at 81,600 tokens",
  { timeout: 10000 },
  async (t) => {
    // 81,600 tokens has cold write cost $0.51 (> $0.50 handoff threshold),
    // but native idle expectedSavings = 0.15 * (0.0816 * 5.75) - (0.0816 * 0.5 + 0.000025) = 0.029555 < $0.05 -> "stop".
    const h = await createWarmingFixture(t, { tokens: 81_600, cacheWarming: "idle" })
    await h.prompt("81.6k context where native warmer declines")

    assert.equal(h.session.cacheWarmingStatus.decision.action, "stop")
    assert.ok(Math.abs(h.session.cacheWarmingStatus.decision.expectedSavings - 0.029555) < 1e-9)

    // At t=240s, auto-handoff must still pause because effective cacheWarming mode is "idle".
    await h.tick(240_000)
    assert.equal(h.handoffStates().length, 0, "auto-handoff pauses in idle mode even when native economics will decline")
    assert.equal(h.requests.length, 1)

    // At t=270s, native warmer evaluates economics, fires cache_warming_decision with action="stop", and stops without warming.
    await h.tick(30_000)
    assert.equal(h.decisions.length, 1)
    assert.equal(h.decisions[0].action, "stop")
    assert.ok(
      h.extensionDecisionResults.every((res) => res === undefined),
      "observer must not override native 'stop' decision to 'warm'",
    )
    assert.equal(h.session.cacheWarmingStatus.state, "inactive")
    assert.equal(h.session.cacheWarmingStatus.reason, "expected savings below threshold")
    assert.equal(h.warmEntries().length, 0, "no warm entry when native economics declines")
    assert.equal(h.requests.length, 1, "no provider request sent on declined refresh")

    // Even after t=270s (while still warm at t=280s or expired at t=310s), auto-handoff remains paused in idle mode.
    await h.tick(10_000)
    assert.equal(h.handoffStates().length, 0, "auto-handoff must not fire after native warmer stops on economics")
    await h.tick(30_000)
    assert.equal(h.handoffStates().length, 0)
  },
)

test(
  "real Pi native idle warming pauses auto-handoff when refresh fails",
  { timeout: 10000 },
  async (t) => {
    const failed = await createWarmingFixture(t, { tokens: 150_000, cacheWarming: "idle", failRefresh: true })
    await failed.prompt("Task with failing refresh")
    await failed.tick(240_000)
    assert.equal(failed.handoffStates().length, 0, "auto-handoff pauses at t=240s in idle mode")
    await failed.tick(30_000) // t=270s: refresh attempted and fails
    assert.equal(failed.requests.length, 2)
    assert.equal(failed.warmEntries().length, 0)
    await failed.tick(15_000) // t=285s: still within initial 300s window, handoff must remain paused
    assert.equal(failed.handoffStates().length, 0, "auto-handoff stays paused in idle mode even if refresh fails")
  },
)

test(
  "real Pi native idle warming pauses auto-handoff when model.promptCache is absent on a seeded route",
  { timeout: 10000 },
  async (t) => {
    const noDecl = await createWarmingFixture(t, {
      tokens: 150_000,
      cacheWarming: "idle",
      promptCache: {},
    })
    await noDecl.prompt("Task on seeded model without promptCache declaration")
    assert.equal(noDecl.session.cacheWarmingStatus.state, "inactive")
    assert.equal(noDecl.session.cacheWarmingStatus.reason, "cache lifetime unavailable")
    assert.match(noDecl.statuses.at(-1), /~5m/, "fallback seed still provides 5m countdown when declaration is absent")
    await noDecl.tick(240_000)
    assert.equal(noDecl.handoffStates().length, 0, "auto-handoff stays paused in idle mode even when native TTL is absent")
  },
)

test(
  "real Pi native idle warming pauses auto-handoff after the 30-minute idle safety limit stops warming",
  { timeout: 10000 },
  async (t) => {
    const safety = await createWarmingFixture(t, {
      tokens: 150_000,
      cacheWarming: "idle",
      promptCache: { short: 300, long: 3600 },
    })
    await safety.prompt("Task running up to 30m idle safety horizon")
    // 6 refreshes at 270s, 540s, 810s, 1080s, 1350s, 1620s (27m). Next warm would be 1890s > 1800s -> stops with 30m limit.
    for (let i = 0; i < 6; i++) {
      await safety.tick(269_000)
      assert.equal(safety.handoffStates().length, 0, "no handoff before native refresh")
      await safety.tick(1_000)
    }
    assert.equal(safety.warmEntries().length, 6)
    assert.equal(safety.session.cacheWarmingStatus.state, "inactive")
    assert.equal(safety.session.cacheWarmingStatus.reason, "30-minute idle safety limit reached")
    // At 1620s + 240s = 1860s (60s before the 6th warm's 300s TTL expires), auto-handoff must still pause in idle mode.
    await safety.tick(240_000)
    assert.equal(safety.handoffStates().length, 0, "auto-handoff stays paused in idle mode after 30-minute safety stop")
  },
)

test(
  "real Pi model.promptCache[retention] remains authoritative over learned 10m promotion from comparable hits",
  { timeout: 10000 },
  async (t) => {
    const h = await createWarmingFixture(t, {
      id: "claude-sonnet-5.5",
      retention: "short",
      promptCache: { short: 300, long: 3600 },
      cacheWarming: "off",
      savedCacheGuard: { autoHandoff: false, placement: "footer", budgetUsd: 10 },
    })
    await h.prompt("Turn 1")
    for (let n = 1; n <= 3; n++) {
      await h.tick(360_000) // 6m interval would promote learner to 10m bucket when declaration is absent
      await h.prompt(`Follow-up ${n}`)
    }
    assert.match(
      h.statuses.at(-1),
      /~5m/,
      "model.promptCache.short=300 must remain authoritative (~5m) even after three 6-minute hits",
    )
    assert.doesNotMatch(h.statuses.at(-1), /~10m/)
  },
)

for (const mode of ["off", "streaming"]) {
  test(`real Pi native cacheWarming "${mode}" retains automatic handoff at t=240s`, { timeout: 10000 }, async (t) => {
    const h = await createWarmingFixture(t, {
      tokens: 81_600,
      cacheWarming: mode,
      handoffWriteTool: true,
      mockSetTimeout: false,
    })
    await h.prompt("ORIGINAL TASK FOR HANDOFF")
    assert.equal(h.requests.length, 1)
    if (mode === "streaming") {
      assert.equal(h.session.cacheWarmingStatus.state, "inactive")
      assert.equal(h.session.cacheWarmingStatus.reason, "agent run settled")
    } else {
      assert.equal(h.session.cacheWarmingStatus.state, "inactive")
      assert.equal(h.session.cacheWarmingStatus.reason, "cache warming disabled")
    }

    await h.tick(239_000)
    assert.equal(h.handoffStates().length, 0)

    await h.tick(1_000)
    assert.equal(
      h.handoffStates().filter((entry) => entry.data.status === "dispatched").length,
      1,
      `cacheWarming="${mode}" must still dispatch automatic handoff at 60s remaining`,
    )
    await waitForRealSettle(h.events, () => ({ state: h.handoffStates().at(-1)?.data, errors: h.errors }))
    assert.equal(h.handoffStates().at(-1)?.data.status, "ready")
    assert.equal(readFileSync(h.outputPath, "utf8"), h.handoffBody)
    const users = h.userMessages()
    assert.equal(users.length, 2)
    assert.deepEqual(users[1].message.content, [{ type: "text", text: HANDOFF_PROMPT }])
  })
}

test(
  "real Pi global settings file cacheWarming='off' overrides project 'idle' and dispatches handoff",
  { timeout: 10000 },
  async (t) => {
    const globalOff = await createWarmingFixture(t, {
      tokens: 81_600,
      settingsMode: "files",
      globalFileSettings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" },
      projectFileSettings: { cacheWarming: "idle" },
      handoffWriteTool: true,
      mockSetTimeout: false,
    })
    assert.equal(globalOff.settingsManager.getCacheWarmingMode(), "off")
    assert.equal(globalOff.settingsManager.getSettings().cacheWarming, "idle", "merged settings has project override")
    await globalOff.prompt("Task with global off and project idle")
    await globalOff.tick(240_000)
    assert.equal(
      globalOff.handoffStates().filter((entry) => entry.data.status === "dispatched").length,
      1,
      "project cacheWarming='idle' must not suppress handoff when global settings file is 'off'",
    )
    await waitForRealSettle(globalOff.events, () => ({ state: globalOff.handoffStates().at(-1)?.data, errors: globalOff.errors }))
    assert.equal(globalOff.handoffStates().at(-1)?.data.status, "ready")
  },
)

test(
  "real Pi global settings file cacheWarming='idle' overrides project 'off' and pauses handoff",
  { timeout: 10000 },
  async (t) => {
    const globalIdle = await createWarmingFixture(t, {
      tokens: 150_000,
      settingsMode: "files",
      globalFileSettings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "idle" },
      projectFileSettings: { cacheWarming: "off" },
    })
    assert.equal(globalIdle.settingsManager.getCacheWarmingMode(), "idle")
    assert.equal(globalIdle.settingsManager.getSettings().cacheWarming, "off", "merged settings has project override")
    await globalIdle.prompt("Task with global idle and project off")
    await globalIdle.tick(240_000)
    assert.equal(
      globalIdle.handoffStates().length,
      0,
      "project cacheWarming='off' must not re-enable handoff when global settings file is 'idle'",
    )
  },
)

test(
  "real Pi model.promptCache.short=120 is authoritative over 5m seed",
  { timeout: 10000 },
  async (t) => {
    const shortOverride = await createWarmingFixture(t, {
      id: "claude-sonnet-5.5",
      retention: "short",
      promptCache: { short: 120, long: 600 },
      cacheWarming: "off",
      savedCacheGuard: { autoHandoff: false, placement: "footer" },
    })
    await shortOverride.prompt("Short override prompt")
    assert.match(shortOverride.statuses.at(-1), /~2m/, "promptCache.short=120 must display ~2m, not the 5m seed")
    assert.doesNotMatch(shortOverride.statuses.at(-1), /~5m/)
    assert.match(shortOverride.statuses.at(-1), /2:00/)
  },
)

test(
  "real Pi model.promptCache.long=600 is authoritative over 60m seed",
  { timeout: 10000 },
  async (t) => {
    const longOverride = await createWarmingFixture(t, {
      id: "claude-sonnet-5.5",
      retention: "long",
      promptCache: { short: 120, long: 600 },
      cacheWarming: "off",
      savedCacheGuard: { autoHandoff: false, placement: "footer" },
    })
    await longOverride.prompt("Long override prompt")
    assert.match(longOverride.statuses.at(-1), /~10m/, "promptCache.long=600 must display ~10m, not the 60m seed")
    assert.doesNotMatch(longOverride.statuses.at(-1), /~60m/)
    assert.match(longOverride.statuses.at(-1), /10:00/)
  },
)

test(
  "real Pi custom provider model with promptCache declaration displays countdown after usage",
  { timeout: 10000 },
  async (t) => {
    const customModel = await createWarmingFixture(t, {
      provider: "custom-enterprise-proxy",
      api: "openai-completions",
      id: "custom-model-v1",
      retention: "short",
      promptCache: { short: 420 },
      cacheWarming: "off",
      savedCacheGuard: { autoHandoff: false, placement: "footer" },
    })
    await customModel.prompt("Custom provider prompt")
    assert.match(customModel.statuses.at(-1), /~7m/, "custom model with promptCache.short=420 displays ~7m countdown")
    assert.match(customModel.statuses.at(-1), /7:00/)
    assert.doesNotMatch(customModel.statuses.at(-1), /cache duration unknown/)
  },
)
