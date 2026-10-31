import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import extension from "../extensions/cache-guard.ts"

// Oracle: the task requires every scoped entry, regardless of price/provider/context fit.
// A recorded 100k-token prompt at $5/M input costs $0.50 cold; the other fixture
// input rates give $0.10, $0.50, $1.00, $0.10, and $0.20 (no cache-write charge).
// Falsifiers: cheaper-only filtering, catalog fallback, sending an ineligible choice,
// consuming a cancelled request, switching without scoped thinking, or duplicate sends.
const provider = "github-copilot"
const currentId = "claude-sonnet-5.5"
const crossProvider = "cache-guard-scoped-cross-offline"
const pending = "Keep this pending offline request intact."

async function fixture(t, pick) {
  const root = mkdtempSync(join(tmpdir(), "scoped-selection-real-pi-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, "workspace"), agentDir = join(root, "agent")
  mkdirSync(cwd); mkdirSync(agentDir)
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir
  })
  writeFileSync(join(agentDir, "cache-guard.json"), JSON.stringify({ budgetUsd: 0, placement: "off" }))
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false },
    cacheWarming: { enabled: false } })
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false })
  const requests = [], errors = [], dialogs = [], editor = [], switches = []
  const definition = (id, input, contextWindow = 200000) => ({ id, name: id, reasoning: true,
    input: ["text"], contextWindow, maxTokens: 1000, promptCache: { short: 300, long: 300 },
    cost: { input, output: 0, cacheRead: input / 10, cacheWrite: 0 } })
  const streamSimple = (model, context, options) => {
    requests.push({ provider: model.provider, id: model.id, reasoning: options?.reasoning,
      messages: structuredClone(context.messages) })
    const stream = new AssistantMessageEventStream()
    const message = { role: "assistant", provider: model.provider, api: model.api, model: model.id,
      timestamp: Date.now(), content: [{ type: "text", text: "Offline response" }], stopReason: "stop",
      usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 22,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message })
      stream.push({ type: "done", reason: "stop", message })
      stream.end()
    })
    return stream
  }
  // The canonical current route and alternative scoped models use only the local
  // stream override; catalog discovery and model network access are off.
  for (const [name, models] of [
    [provider, [definition(currentId, 5), definition("cheap", 1), definition("equal", 5),
      definition("higher", 10), definition("too-small", 1, 50000), definition("unscoped", .5)]],
    [crossProvider, [definition("cross", 2)]],
  ]) modelRuntime.registerProvider(name, { api: "anthropic-messages", baseUrl: "http://127.0.0.1:1",
    apiKey: "not-a-real-key", models, streamSimple })
  const model = modelRuntime.getModel(provider, currentId)
  assert.ok(model)
  const scopedModels = [
    [provider, currentId, "off"], [provider, "cheap", "low"], [provider, "equal", "medium"],
    [provider, "higher", "high"], [provider, "too-small", "low"], [crossProvider, "cross", "low"],
  ].map(([name, id, thinkingLevel]) => {
    const model = modelRuntime.getModel(name, id)
    assert.ok(model)
    return { model, thinkingLevel }
  })
  const manager = SessionManager.create(cwd, join(root, "sessions"))
  manager.appendMessage({ role: "user", content: "Original task", timestamp: 0 })
  manager.appendMessage({ role: "assistant", provider, api: model.api, model: model.id, timestamp: 0,
    content: [{ type: "text", text: "Recorded cache hit" }], stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 100000, cacheWrite: 0, totalTokens: 100000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
  const createRuntime = async (opts) => {
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: settings, modelRuntime,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        noContextFiles: true, extensionFactories: [extension, (pi) => {
          pi.on("model_select", (event) => switches.push(event))
        }] } })
    return { ...(await createAgentSessionFromServices({ services, sessionManager: opts.sessionManager,
      sessionStartEvent: opts.sessionStartEvent, model, thinkingLevel: "off", scopedModels, noTools: true })),
      services, diagnostics: services.diagnostics }
  }
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: manager })
  t.after(() => runtime.dispose())
  await runtime.session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error),
    uiContext: { select: async (title, choices) => {
      dialogs.push({ title, choices: [...choices], model: runtime.session.model,
        requestCount: requests.length, switchCount: switches.length })
      return pick(choices, dialogs.length)
    }, setEditorText: (text) => editor.push(text), notify: () => {}, setStatus: () => {}, setWidget: () => {},
    theme: { fg: (_color, text) => text } } })
  assert.equal(runtime.session.getContextUsage().tokens, 100000, "fixture supplies the known priced prompt size")
  const before = manager.getLeafId()
  return { runtime, manager, scopedModels, requests, errors, dialogs, editor, switches, before }
}

function switchRow(choices, name, id) {
  return choices.find((row) => row.startsWith(`Switch to ${name}/${id} ·`))
}

function assertAllScopedRows(f) {
  assert.equal(f.dialogs.length > 0, true, "real prompt opens the cold-cache dialog")
  const { title, choices } = f.dialogs[0]
  assert.match(title, /estimated window ended/i)
  assert.doesNotMatch(title, /cache is cold/i)
  const costs = new Map([[currentId, "$0.50"], ["cheap", "$0.10"], ["equal", "$0.50"],
    ["higher", "$1.00"], ["too-small", "$0.10"], ["cross", "$0.20"]])
  for (const { model } of f.scopedModels) {
    const row = switchRow(choices, model.provider, model.id) ?? (model.id === currentId
      ? choices.find((choice) => choice.startsWith(`Continue with ${model.name} ·`)) : undefined)
    assert.ok(row, `scoped entry ${model.provider}/${model.id} must be visible; got ${JSON.stringify(choices)}`)
    assert.ok(row.includes(costs.get(model.id)), `${model.id} must show its independently calculated cold cost`)
    if (model.id === "too-small") assert.match(row, /\(context too large for model[^)]*\)/)
    else assert.doesNotMatch(row, /context too large for model/)
  }
  assert.equal(choices.some((row) => row.includes(`${provider}/unscoped`)), false, "catalog-only entry stays hidden")
}

test("real Pi cold-cache dialog lists every scoped entry and its cost", { timeout: 15000 }, async (t) => {
  const f = await fixture(t, (choices) => choices.find((row) => row.startsWith("Cancel")))
  await f.runtime.session.prompt(pending)
  assertAllScopedRows(f)
  assert.deepEqual(f.errors, [])
  assert.equal(f.requests.length, 0)
  assert.equal(f.switches.length, 0)
  assert.equal(f.manager.getLeafId(), f.before)
  assert.equal(f.editor.at(-1), pending)
})

test("real Pi too-small selection reopens without switching or sending; Cancel preserves the request",
  { timeout: 15000 }, async (t) => {
    const f = await fixture(t, (choices, round) => round === 1
      ? switchRow(choices, provider, "too-small") : choices.find((row) => row.startsWith("Cancel")))
    await f.runtime.session.prompt(pending)
    assert.deepEqual(f.errors, [])
    assert.equal(f.dialogs.length, 2, "ineligible selection must reopen the dialog")
    assert.equal(f.dialogs[1].model.id, currentId, "no transient switch before reopening")
    assert.equal(f.dialogs[1].requestCount, 0, "no transient send before reopening")
    assert.equal(f.dialogs[1].switchCount, 0, "no model_select event before reopening")
    assert.equal(f.runtime.session.model.id, currentId)
    assert.equal(f.runtime.session.thinkingLevel, "off")
    assert.equal(f.requests.length, 0)
    assert.equal(f.switches.length, 0)
    assert.equal(f.manager.getLeafId(), f.before, "cancel must not append the request")
    assert.equal(f.editor.at(-1), pending, "cancel restores the full pending text")
    assertAllScopedRows(f)
  })

for (const [id, thinking] of [["equal", "medium"], ["higher", "high"]]) {
  test(`real Pi eligible ${id}-price selection sends once with scoped thinking`, { timeout: 15000 }, async (t) => {
    const f = await fixture(t, (choices) => switchRow(choices, provider, id))
    await f.runtime.session.prompt(pending)
    assert.deepEqual(f.errors, [])
    assert.equal(f.dialogs.length, 1)
    assert.equal(f.requests.length, 1, "exactly one local provider request")
    assert.equal(f.switches.length, 1, "exactly one model switch")
    assert.equal(f.runtime.session.model.provider, provider)
    assert.equal(f.runtime.session.model.id, id)
    assert.equal(f.runtime.session.thinkingLevel, thinking)
    assert.equal(f.requests[0].provider, provider)
    assert.equal(f.requests[0].id, id)
    assert.equal(f.requests[0].reasoning, thinking, "scoped thinking reaches the real provider boundary")
    const userMessages = f.requests[0].messages.filter((message) => message.role === "user")
    assert.equal(userMessages.filter((message) => JSON.stringify(message.content).includes(pending)).length, 1)
    assert.equal(f.manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user" &&
      JSON.stringify(entry.message.content).includes(pending)).length, 1, "pending request enters the session once")
    assertAllScopedRows(f)
  })
}
