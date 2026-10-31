import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises"
import test from "node:test"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import extension from "../extensions/cache-guard.ts"
import { HANDOFF_ENTRY_TYPE, HANDOFF_PROMPT } from "../extensions/handoff.ts"

// Oracle: CURRENT ACCEPTANCE AMENDMENTS in docs/specs/automatic-session-handoff.md.
// Independent arithmetic: 78,400 / 1e6 * 6.25 = .49; 80,000 => .50;
// 81,600 => .51; compacted 1,600 => .01. Recorded costs are not this estimate.
// Falsifiers: old disabled default, >= comparison, lifetime-cost eligibility,
// accidental override of saved off, changed prompt, fake tool success, paid loops.
// This is the real Pi session_start/timer -> sendUserMessage -> provider -> built-in
// write -> agent_settled route. Only provider responses and the idle clock are controlled.
async function fixture(t, { tokens = 81600, saved, expensiveHistory = false, compacted = false, recordedCost = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "handoff-scheduling-pi-"))
  const cwd = join(root, "workspace"), agentDir = join(root, "agent")
  mkdirSync(cwd); mkdirSync(agentDir)
  const previous = new Map(["PI_CODING_AGENT_DIR", "PI_CACHE_RETENTION"].map((key) => [key, process.env[key]]))
  let session
  // One ordered cleanup keeps the clock/env/files valid until Pi's shutdown finishes.
  t.after(async () => {
    try {
      if (session) {
        try { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }) }
        finally { session.dispose() }
      }
    } finally {
      t.mock.timers.reset()
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CACHE_RETENTION = "short"
  if (saved !== undefined) writeFileSync(join(agentDir, "cache-guard.json"), JSON.stringify(saved))
  // Do not fake setTimeout: Pi/tool I/O and dispatch confirmation must retain real timers.
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() })
  const anchor = Date.now(), requests = [], errors = [], notes = [], events = []
  const provider = "github-copilot", api = "anthropic-messages"
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false })
  const outputPath = join(root, "handoff.md"), body = "# Offline handoff\n\nContinue the original task.\n\n## Suggested skills\nNone.\n"
  modelRuntime.registerProvider(provider, { api, baseUrl: "http://127.0.0.1:1",
    models: [{ id: "claude-sonnet-5.5", name: "Offline scheduler fixture", reasoning: false, input: ["text"], contextWindow: 200000,
      maxTokens: 1000, promptCache: { short: 300, long: 300 }, cost: { input: 5, output: 25, cacheRead: .5, cacheWrite: 6.25 } }],
    streamSimple: (model, context) => {
      requests.push(structuredClone(context.messages))
      const tool = requests.length === 1
      const message = { role: "assistant", provider, api: model.api, model: model.id, timestamp: Date.now(),
        content: tool ? [{ type: "toolCall", id: "offline-handoff-write", name: "write", arguments: { path: outputPath, content: body } }]
          : [{ type: "text", text: "Saved the offline handoff." }], stopReason: tool ? "toolUse" : "stop",
        usage: usage(tokens) }
      const stream = new AssistantMessageEventStream()
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: message.stopReason, message }); stream.end() })
      return stream
    } })
  // Dummy runtime key only; the controlled stream override never makes HTTP requests.
  await modelRuntime.setRuntimeApiKey(provider, "offline-fixture-not-a-credential")
  const model = modelRuntime.getModel(provider, "claude-sonnet-5.5")
  assert.ok(model)
  const manager = SessionManager.create(cwd, join(root, "sessions"))
  manager.appendMessage({ role: "user", content: "ORIGINAL TASK MUST STAY IN THE OLD SESSION", timestamp: anchor })
  const userLeaf = manager.getLeafId()
  const assistant = (size, cost = 0) => ({ role: "assistant", provider, api, model: model.id, timestamp: anchor,
    content: [{ type: "text", text: "Original work" }], stopReason: "stop", usage: usage(size, cost) })
  if (expensiveHistory) {
    manager.appendMessage(assistant(100000, 30))
    manager.appendUsage("other", provider, model.id, usage(100000, 40))
  }
  if (compacted) manager.appendCompaction("Small retained task summary", userLeaf, 100000, undefined, false, usage(100000, 50))
  manager.appendMessage(assistant(tokens, recordedCost)) // post-compaction usage establishes the actual small current context
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" })
  const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: settings, modelRuntime,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => extension(pi, { handoff: { agentDir, tempDir: root } })] } })
  ;({ session } = await createAgentSessionFromServices({ services, sessionManager: manager, model }))
  session.subscribe((event) => events.push(event))
  await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error),
    uiContext: { select: async () => { throw new Error("Warm automatic scheduling must not open the cold-send chooser") },
      notify: (text) => notes.push(text), setStatus: () => {}, setWidget: () => {},
      theme: { fg: (_color, text) => text } } })
  assert.equal(session.getContextUsage().tokens, tokens, "real Pi context usage must match the hand-calculated fixture")
  const states = () => manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === HANDOFF_ENTRY_TYPE)
  return { session, manager, requests, errors, notes, events, outputPath, body, states,
    tick: (ms) => t.mock.timers.tick(ms), state: () => states().at(-1)?.data }
}

function usage(tokens, cost = 0) {
  return { input: 0, output: 0, cacheRead: tokens, cacheWrite: 0, totalTokens: tokens,
    cost: { input: 0, output: 0, cacheRead: cost, cacheWrite: 0, total: cost } }
}

async function assertNoDispatch(h) {
  await nextTurn()
  assert.equal(h.states().length, 0, "no dispatch guard or failure state should exist when ineligible")
  assert.equal(h.requests.length, 0, "no offline provider request")
  assert.deepEqual(h.errors, [])
}

async function waitForSettle(h) {
  // Bounded real-time polling cannot hang a failing test on an unresolved event promise.
  for (let i = 0; i < 400; i++) {
    if (h.events.some((event) => event.type === "agent_settled")) return
    await delay(10)
  }
  assert.fail(`Pi did not settle: ${JSON.stringify({ state: h.state(), errors: h.errors, requests: h.requests.length })}`)
}

for (const [tokens, cost] of [[78400, "0.49"], [80000, "0.50"]]) {
  test(`real Pi new-install scheduler rejects current-context $${cost}`, { timeout: 10000 }, async (t) => {
    const h = await fixture(t, { tokens })
    h.tick(240000)
    await assertNoDispatch(h)
    h.tick(61000)
    await assertNoDispatch(h)
  })
}

async function assertReadyOnce(h) {
  await waitForSettle(h)
  assert.equal(h.state().status, "ready", "the real built-in write result must publish a ready handoff")
  assert.equal(h.state().artifact.source.sessionId, h.manager.getSessionId(), "generation keeps the original session")
  assert.equal(h.manager.getEntries().some((entry) => entry.type === "compaction"), false, "handoff does not compact the old history")
  assert.equal(h.notes.filter((note) => note.startsWith("A handoff was created")).length, 1, "one final completion notification")
  assert.equal(readFileSync(h.outputPath, "utf8"), h.body)
  assert.ok(readFileSync(h.state().artifact.path, "utf8").endsWith(h.body))
  assert.equal(h.requests.length, 2, "one dispatch with one write call and one tool follow-up")
  assert.ok(h.events.some((event) => event.type === "tool_execution_end" && event.toolName === "write" && !event.isError))
  const users = h.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "user")
  assert.equal(users.length, 2, "retain the original task plus exactly one automatic handoff turn")
  assert.equal(users[0].message.content, "ORIGINAL TASK MUST STAY IN THE OLD SESSION")
  assert.deepEqual(users[1].message.content, [{ type: "text", text: HANDOFF_PROMPT }], "automatic prompt stays byte-for-byte unchanged")
  assert.equal(h.requests[0].at(-1).content[0].text, HANDOFF_PROMPT)
  assert.equal(JSON.stringify(h.requests).includes(HANDOFF_ENTRY_TYPE), false, "custom handoff metadata is excluded from model context")
  h.tick(240000) // generation warmed the same expensive context: it must not create a paid loop
  await nextTurn()
  assert.equal(h.requests.length, 2)
  assert.equal(h.states().filter((entry) => entry.data.status === "dispatched").length, 1)
  assert.deepEqual(h.errors, [])
}

test("real Pi new-install default dispatches $0.51 context with zero recorded spending, writes and settles once", { timeout: 10000 }, async (t) => {
  const h = await fixture(t)
  assert.equal(h.manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant")
    .reduce((sum, entry) => sum + entry.message.usage.cost.total, 0), 0)
  h.tick(239000)
  await assertNoDispatch(h)
  h.tick(1000)
  assert.equal(h.states().filter((entry) => entry.data.status === "dispatched").length, 1,
    "default-on must dispatch $0.51 at 60 seconds remaining even when recorded spending is zero")
  await assertReadyOnce(h)
})

test("real Pi explicit zero threshold exercises the offline built-in write scheduling route", { timeout: 10000 }, async (t) => {
  // Both saved keys are zero only to keep this tool-route control usable on the old
  // scheduler too. The default/cheap-context cases above and below reject that policy.
  const h = await fixture(t, { recordedCost: 1,
    saved: { autoHandoff: true, handoffColdCostThresholdUsd: 0, handoffThresholdUsd: 0 } })
  h.tick(240000)
  assert.equal(h.states().filter((entry) => entry.data.status === "dispatched").length, 1)
  await assertReadyOnce(h)
})

for (const compacted of [false, true]) {
  test(`real Pi $0.01 current context ignores expensive ${compacted ? "compaction and history" : "recorded history"}`, { timeout: 10000 }, async (t) => {
    const h = await fixture(t, { tokens: 1600, expensiveHistory: true, compacted,
      saved: { autoHandoff: true, handoffColdCostThresholdUsd: .5 } })
    const recorded = h.manager.getEntries().reduce((sum, entry) => sum + (entry.usage?.cost.total ?? entry.message?.usage?.cost.total ?? 0), 0)
    assert.equal(recorded, compacted ? 120 : 70, "historical spending intentionally exceeds both old and new thresholds")
    h.tick(240000)
    await assertNoDispatch(h)
    h.tick(61000)
    await assertNoDispatch(h)
  })
}

for (const usage of [undefined, { tokens: null }]) {
  test(`real Pi unknown current context (${usage === undefined ? "missing" : "null tokens"}) cannot use historical cache tokens`, { timeout: 10000 }, async (t) => {
    const h = await fixture(t)
    // Controlled uncertainty at the real SDK context-usage boundary; recorded
    // cache usage remains 81,600 tokens ($0.51), which must not authorize spending.
    h.session.getContextUsage = () => usage
    h.tick(240000)
    await assertNoDispatch(h)
  })
}

test("real Pi saved explicit off stays off for expensive current context and history", { timeout: 10000 }, async (t) => {
  const h = await fixture(t, { expensiveHistory: true, saved: { autoHandoff: false, handoffColdCostThresholdUsd: .5 } })
  h.tick(240000)
  await assertNoDispatch(h)
  h.tick(61000)
  await assertNoDispatch(h)
})
