import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime,
  SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import extension from "../extensions/cache-guard.ts"

// Oracle: assigned flat-menu acceptance requirements, not the current UI output.
// Claim                         | Plausible error                 | Observable criterion
// Main menu exposes preferences | handoff/placement submenu      | named rows in first selector
// Toggle changes immediately    | second selector or input       | one select, zero inputs, saved opposite state
// Numeric edits are direct      | budget presets / wrong key     | one select/input, only intended setting changes
// Placement is direct           | placement submenu / lost prefs | one select, zero inputs, only placement changes
// Cancellation is inert         | eager write / default overwrite| byte-for-byte unchanged settings
// /cache-guard handoff is alias | dedicated handoff screen       | same title and options as /cache-guard
// Scope: real Pi prompt/command dispatch and file persistence; UI answers are controlled.
// All five named placements are covered. The assignment says six but gives no sixth name.
const placements = ["above", "below", "corner", "footer", "off"]
const initial = { budgetUsd: 0.23, placement: "below", autoHandoff: false, handoffColdCostThresholdUsd: 0.87 }
const titles = { budget: "Cold-send budget", toggle: "Automatic handoff", threshold: "Handoff threshold" }

function row(choices, prefix) {
  const matches = choices.filter((choice) => choice.startsWith(`${prefix} ·`))
  assert.equal(matches.length, 1, `Expected one ${prefix} row directly in the main menu; got ${JSON.stringify(choices)}`)
  return matches[0]
}

function placementRow(choices, placement) {
  // Allow a Countdown prefix or a plain placement name, but match a whole name:
  // "above" must not accidentally match a help sentence in a different row.
  const matches = choices.filter((choice) => new RegExp(`^(?:Countdown\\s*·\\s*)?${placement}(?:\\s|$)`, "i").test(choice))
  assert.equal(matches.length, 1, `Expected ${placement} directly in the main menu; got ${JSON.stringify(choices)}`)
  return matches[0]
}

async function fixture(t, { saved = initial, choose = () => undefined, answer } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cache-guard-settings-pi-"))
  const cwd = join(root, "workspace"), agentDir = join(root, "agent")
  mkdirSync(cwd); mkdirSync(agentDir)
  const legacySettingsPath = join(agentDir, "cache-guard.json")
  writeFileSync(legacySettingsPath, JSON.stringify(saved, null, 2) + "\n")
  const originalBytes = readFileSync(legacySettingsPath, "utf8")
  const keys = ["PI_CODING_AGENT_DIR", "PI_CACHE_RETENTION", "PI_CACHE_GUARD_MIN_USD"]
  const previous = new Map(keys.map((key) => [key, process.env[key]]))
  let session
  t.after(async () => {
    try {
      if (session) {
        try { await session.abort(); await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }) }
        finally { session.dispose() }
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CACHE_RETENTION = "short"
  delete process.env.PI_CACHE_GUARD_MIN_USD
  const selects = [], inputs = [], editors = [], requests = [], errors = [], notes = []
  let commandSelects = 0, commandInputs = 0
  const provider = "cache-guard-settings-offline", api = "cache-guard-settings-fixture-api"
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false })
  modelRuntime.registerProvider(provider, { api, baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "Offline settings fixture", reasoning: false, input: ["text"], contextWindow: 200000,
      maxTokens: 1000, promptCache: { short: 300, long: 300 }, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }],
    streamSimple: (model, context) => {
      // A local fallback makes accidental model dispatch visible without any HTTP.
      requests.push(structuredClone(context.messages))
      const stream = new AssistantMessageEventStream()
      const message = { role: "assistant", provider, api, model: model.id, timestamp: Date.now(),
        content: [{ type: "text", text: "Unexpected settings model request" }], stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end() })
      return stream
    } })
  await modelRuntime.setRuntimeApiKey(provider, "offline-not-a-credential")
  const model = modelRuntime.getModel(provider, "fixture")
  assert.ok(model)
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" })
  const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => extension(pi, { handoff: { agentDir, tempDir: root } })] } })
  ;({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd), model, noTools: true }))
  await session.bindExtensions({ mode: "tui", onError: (error) => errors.push(error),
    uiContext: {
      select: async (title, choices) => {
        selects.push({ title, choices: [...choices] })
        assert.ok(++commandSelects <= 1, "Nested selector or menu loop: each command must open only one settings menu")
        return choose(choices, title)
      },
      input: async (title, placeholder) => {
        inputs.push({ title, placeholder })
        assert.ok(++commandInputs <= 1, "Each edit must use at most one input")
        return answer
      },
      editor: async (title, text) => {
        editors.push({ title, text })
        return text
      },
      confirm: async () => { assert.fail("Settings must not open a confirmation dialog") },
      custom: async () => { assert.fail("Settings must not open a custom second screen") },
      notify: (text, level) => notes.push({ text, level }), setStatus: () => {}, setWidget: () => {},
      theme: { fg: (_color, text) => text },
    } })
  const settingsPath = join(agentDir, "cache-guard", "settings.json")
  return {
    agentDir, selects, inputs, editors, requests, errors, notes, originalBytes,
    bytes: () => readFileSync(settingsPath, "utf8"), saved: () => JSON.parse(readFileSync(settingsPath, "utf8")),
    async prompt(command = "/cache-guard") {
      commandSelects = 0; commandInputs = 0
      await session.prompt(command)
      assert.deepEqual(errors, [], "Pi must not swallow a UI assertion as an extension error")
      assert.equal(requests.length, 0, "Settings commands must not request a model response")
      assert.equal(session.messages.length, 0, "Settings must not add conversation turns")
    },
  }
}

test("startup migrates legacy settings unchanged and command updates only new file", { timeout: 10000 }, async (t) => {
  const legacy = { budgetUsd: 0.42, placement: "footer", autoHandoff: false, handoffColdCostThresholdUsd: 0.99 }
  const h = await fixture(t, { saved: legacy, choose: (choices) => choices.find((c) => c.startsWith("Countdown · corner")) })
  const legacyFile = join(h.agentDir, "cache-guard.json")
  const newFile = join(h.agentDir, "cache-guard", "settings.json")
  assert.equal(existsSync(legacyFile), false, "legacy file must be removed after migration")
  assert.deepEqual(JSON.parse(readFileSync(newFile, "utf8")), legacy, "migrated settings match legacy settings before command")
  await h.prompt()
  assert.equal(existsSync(legacyFile), false, "legacy file must not be recreated")
  assert.equal(h.saved().placement, "corner")
  assert.equal(h.saved().budgetUsd, 0.42)
})

test("real Pi /cache-guard exposes budget, toggle, threshold and every named placement in one menu", { timeout: 10000 }, async (t) => {
  const h = await fixture(t)
  await h.prompt()
  assert.equal(h.selects.length, 1)
  assert.equal(h.selects[0].title, "Cache guard settings")
  const choices = h.selects[0].choices
  assert.ok(choices.some((choice) => choice.includes("History ·")), `Expected History · row in menu; got ${JSON.stringify(choices)}`)
  assert.ok(row(choices, titles.budget).includes("$0.23"))
  assert.match(row(choices, titles.toggle), /off.*\(turn on\)/i)
  assert.ok(row(choices, titles.threshold).includes("$0.87"))
  for (const placement of placements) placementRow(choices, placement)
  assert.equal(h.inputs.length, 0)
  assert.equal(h.bytes(), h.originalBytes)
})

for (const enabled of [false, true]) {
  test(`real Pi main-menu toggle changes ${enabled ? "on to off" : "off to on"} without a second selector or input`, { timeout: 10000 }, async (t) => {
    const saved = { ...initial, autoHandoff: enabled }
    const h = await fixture(t, { saved, choose: (choices) => row(choices, titles.toggle) })
    await h.prompt()
    assert.equal(h.selects.length, 1)
    assert.equal(h.inputs.length, 0)
    assert.match(row(h.selects[0].choices, titles.toggle), enabled ? /on.*\(turn off\)/i : /off.*\(turn on\)/i)
    assert.deepEqual(h.saved(), { ...saved, autoHandoff: !enabled })
  })
}

for (const enabled of [false, true]) {
  test(`real Pi threshold uses one direct input and preserves budget, placement and automatic ${enabled ? "on" : "off"}`, { timeout: 10000 }, async (t) => {
    const saved = { ...initial, autoHandoff: enabled }
    const h = await fixture(t, { saved, choose: (choices) => row(choices, titles.threshold), answer: "1.42" })
    await h.prompt()
    assert.equal(h.selects.length, 1)
    assert.equal(h.inputs.length, 1)
    assert.deepEqual(h.saved(), { ...saved, handoffColdCostThresholdUsd: 1.42 })
    assert.equal(Object.hasOwn(h.saved(), "handoffThresholdUsd"), false, "Do not save the legacy lifetime-cost key")
  })
}

test("real Pi cold-send budget uses one direct input and preserves the independent handoff threshold", { timeout: 10000 }, async (t) => {
  const h = await fixture(t, { choose: (choices) => row(choices, titles.budget), answer: "0.64" })
  await h.prompt()
  assert.equal(h.selects.length, 1)
  assert.equal(h.inputs.length, 1)
  assert.deepEqual(h.saved(), { ...initial, budgetUsd: 0.64 })
})

for (const placement of placements) {
  test(`real Pi main-menu countdown ${placement} saves directly without altering handoff or budget`, { timeout: 10000 }, async (t) => {
    const saved = { ...initial, placement: placement === "below" ? "above" : "below" }
    const h = await fixture(t, { saved, choose: (choices) => placementRow(choices, placement) })
    await h.prompt()
    assert.equal(h.selects.length, 1)
    assert.equal(h.inputs.length, 0)
    assert.deepEqual(h.saved(), { ...saved, placement })
  })
}

test("real Pi cancelling the main settings selector does not rewrite any preference", { timeout: 10000 }, async (t) => {
  const h = await fixture(t)
  await h.prompt()
  assert.equal(h.selects.length, 1)
  assert.equal(h.inputs.length, 0)
  assert.equal(h.bytes(), h.originalBytes)
  assert.deepEqual(h.notes, [])
})

for (const prefix of [titles.budget, titles.threshold]) {
  test(`real Pi cancelling the direct ${prefix} input leaves settings unchanged`, { timeout: 10000 }, async (t) => {
    const h = await fixture(t, { choose: (choices) => row(choices, prefix) })
    await h.prompt()
    assert.equal(h.selects.length, 1)
    assert.equal(h.inputs.length, 1)
    assert.equal(h.bytes(), h.originalBytes)
    assert.deepEqual(h.notes, [])
  })
}

test("real Pi /cache-guard handoff without arguments opens the same main settings menu", { timeout: 10000 }, async (t) => {
  const h = await fixture(t)
  await h.prompt()
  await h.prompt("/cache-guard handoff")
  assert.equal(h.selects.length, 2, "Exactly one selector per command")
  assert.equal(h.selects[0].title, "Cache guard settings")
  assert.deepEqual(h.selects[1], h.selects[0], "Handoff must be an alias, not a second handoff screen")
  assert.equal(h.inputs.length, 0)
  assert.equal(h.bytes(), h.originalBytes)
})

test("real Pi /cache-guard menu History item and /cache-guard history subcommand open cross-session history in editor without modifying settings", { timeout: 10000 }, async (t) => {
  const h = await fixture(t, {
    choose: (choices) => choices.find((choice) => choice.includes("History ·")),
  })
  const sessionsDir = join(h.agentDir, "sessions", "--workspace--")
  mkdirSync(sessionsDir, { recursive: true })
  const now = Date.now()
  writeFileSync(
    join(sessionsDir, "2026-04-19_sess111111.jsonl"),
    [
      JSON.stringify({ type: "session", id: "sess111111", timestamp: new Date(now - 120_000).toISOString() }),
      JSON.stringify({
        type: "message",
        id: "msg-argon",
        timestamp: new Date(now - 120_000).toISOString(),
        message: {
          role: "assistant",
          provider: "github-copilot",
          model: "gemini-4-argon",
          timestamp: now - 120_000,
          usage: {
            input: 400,
            output: 100,
            cacheRead: 15000,
            cacheWrite: 0,
            totalTokens: 15500,
            cost: { input: 0.0008, output: 0.001, cacheRead: 0.003, cacheWrite: 0, total: 0.0048 },
          },
        },
      }),
      JSON.stringify({
        type: "message",
        id: "msg-sonnet",
        timestamp: new Date(now - 60_000).toISOString(),
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          timestamp: now - 60_000,
          usage: {
            input: 200,
            output: 150,
            cacheRead: 0,
            cacheWrite: 10000,
            totalTokens: 10350,
            cost: { input: 0.0006, output: 0.0022, cacheRead: 0, cacheWrite: 0.0375, total: 0.0403 },
          },
        },
      }),
    ].join("\n") + "\n",
  )

  // 1. Open from /cache-guard menu
  await h.prompt("/cache-guard")
  assert.equal(h.selects.length, 1)
  assert.equal(h.editors.length, 1)
  assert.equal(h.editors[0].title, "Cache Guard History")
  assert.match(h.editors[0].text, /github-copilot\/gemini-4-argon/)
  assert.match(h.editors[0].text, /anthropic\/claude-sonnet-5-5/)
  assert.match(h.editors[0].text, /15,000/)
  assert.match(h.editors[0].text, /10,000/)
  assert.match(h.editors[0].text, /\$0\.0030/)
  assert.match(h.editors[0].text, /\$0\.0375/)
  assert.match(h.editors[0].text, /\$0\.0451/)
  assert.equal(h.bytes(), h.originalBytes)

  // 2. Open directly via /cache-guard history
  await h.prompt("/cache-guard history")
  assert.equal(h.selects.length, 1, "Subcommand should open history directly without menu selector")
  assert.equal(h.editors.length, 2)
  assert.equal(h.editors[1].title, "Cache Guard History")
  assert.match(h.editors[1].text, /github-copilot\/gemini-4-argon/)
  assert.match(h.editors[1].text, /anthropic\/claude-sonnet-5-5/)

  // 3. Open filtered via /cache-guard history gemini-4-argon
  await h.prompt("/cache-guard history gemini-4-argon")
  assert.equal(h.editors.length, 3)
  assert.equal(h.editors[2].title, "Cache Guard History")
  assert.match(h.editors[2].text, /github-copilot\/gemini-4-argon/)
  assert.doesNotMatch(h.editors[2].text, /anthropic\/claude-sonnet-5-5/)
  assert.equal(h.bytes(), h.originalBytes)
})
