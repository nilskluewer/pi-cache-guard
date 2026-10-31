import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import test from "node:test"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import { TuiMainScreen, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui"
import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime,
  SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import extension from "../extensions/cache-guard.ts"

// Oracle: the explicit exact-route policy and passive-learning acceptance criteria.
// These fallback-learning fixtures omit promptCache. Declared-tier precedence is
// covered separately in cache-warming-pi.test.mjs.
// Falsifiers: protocol TTL fallback, normalized-zero misses, missing native hooks,
// prompt-bearing persistence, promotion before three comparable hits, extra sends.
// The native Anthropic payload/events below replace only the network boundary:
// prompt -> AgentSession -> ModelRuntime callbacks -> extension -> real file I/O.
const provider = "github-copilot", api = "anthropic-messages"
const secret = "PRIVATE PROMPT SENTINEL: never store this in cache telemetry"

async function fixture(t, { id = "claude-sonnet-5.5", reads = [100000], budgetUsd = 0,
  provider = "github-copilot", api = "anthropic-messages", placement = "footer" } = {}) {
  // macOS /var is a symlink. The learner deliberately rejects symlink ancestors.
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cache-learning-real-pi-"))
  const cwd = join(root, "workspace"), agentDir = join(root, "configured-agent")
  mkdirSync(cwd); mkdirSync(agentDir)
  const previous = new Map(["PI_CODING_AGENT_DIR", "PI_CACHE_RETENTION"].map(key => [key, process.env[key]]))
  let session
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
  writeFileSync(join(agentDir, "cache-guard.json"), JSON.stringify({ autoHandoff: false,
    handoffColdCostThresholdUsd: 0, placement, budgetUsd }))
  // Keep real setTimeout for Pi I/O; only idle time and its status interval move.
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() })
  const requests = [], errors = [], statuses = [], dialogs = [], hooks = [], widgets = new Map()
  const terminal = { columns: 120, rows: 40, write() {}, hideCursor() {}, showCursor() {} }
  const tui = new TuiMainScreen(terminal)
  const theme = { fg: (_color, text) => text }
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false })
  modelRuntime.registerProvider(provider, { api, apiKey: "offline-dummy-not-a-credential", baseUrl: "http://127.0.0.1:1",
    models: [{ id, name: id, reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 1000,
      // No declared tier: exercise fallback learning and its explicit allowlist.
      cost: { input: 5, output: 25, cacheRead: .5, cacheWrite: 6.25 } }],
    streamSimple: (model, context, options) => {
      const n = requests.length
      requests.push(structuredClone(context.messages))
      const stream = new AssistantMessageEventStream()
      const zeroImplicit = api === "openai-completions" && reads[n] === 0
      const message = { role: "assistant", provider, api, model: id, timestamp: Date.now(),
        content: [{ type: "text", text: "Offline response" }], stopReason: "stop",
        // Deliberately positive normalized usage on Anthropic/Responses even when raw reads are absent/zero.
        // On openai-completions with raw read=0, normalized cacheRead/cacheWrite are both 0 (free implicit write).
        usage: { input: zeroImplicit ? 100000 : 0, output: 2, cacheRead: zeroImplicit ? 0 : 100000, cacheWrite: 0, totalTokens: 100002,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
      queueMicrotask(async () => {
        try {
          assert.equal(typeof options?.onPayload, "function", "real Pi installs the provider payload callback")
          assert.equal(typeof options?.onProviderStreamEvent, "function", "real Pi installs the raw stream callback")
          const messages = context.messages.map(m => ({ role: m.role,
            content: typeof m.content === "string" ? [{ type: "text", text: m.content }]
              : m.content.filter(part => part.type === "text").map(part => ({ type: "text", text: part.text })) }))
          const anthropic = api === "anthropic-messages"
          const completions = api === "openai-completions"
          const payload = anthropic ? { model: id, max_tokens: 1000, system: context.systemPrompt, messages }
            : completions ? { model: id, messages }
            : { model: id, max_output_tokens: 1000, instructions: context.systemPrompt, input: messages }
          await options.onPayload(payload, model)
          const usage = anthropic ? { input_tokens: 20, output_tokens: 0,
            ...(reads[n] === undefined ? {} : { cache_read_input_tokens: reads[n] }) }
            : completions ? { prompt_tokens: 100020, completion_tokens: 2,
              prompt_tokens_details: reads[n] === undefined ? {} : { cached_tokens: reads[n] } }
            : { input_tokens: 100020, output_tokens: 0,
              input_tokens_details: reads[n] === undefined ? {} : { cached_tokens: reads[n] } }
          const raw = anthropic ? { type: "message_start", message: { id: "offline-native-message",
            type: "message", role: "assistant", model: id, content: [], usage } }
            : completions ? { choices: [{ usage }] }
            : { type: "response.completed", response: { model: id, usage } }
          await options.onProviderStreamEvent(raw, model)
          stream.push({ type: "start", partial: message })
          stream.push({ type: "done", reason: "stop", message })
          stream.end()
        } catch (error) {
          errors.push(error)
          stream.push({ type: "error", reason: "error", error: { ...message, stopReason: "error", errorMessage: String(error) } })
          stream.end()
        }
      })
      return stream
    } })
  // No user credentials are read. The registered override is the only request path.
  await modelRuntime.setRuntimeApiKey(provider, "offline-dummy-not-a-credential")
  const model = modelRuntime.getModel(provider, id)
  assert.ok(model)
  const manager = SessionManager.create(cwd, join(root, "sessions"))
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" })
  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: settings,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [extension, pi => {
        pi.on("before_provider_request", event => { hooks.push(event.type) })
        pi.on("provider_stream_event", event => { hooks.push(event.type) })
      }] } })
  ;({ session } = await createAgentSessionFromServices({ services, sessionManager: manager, model, noTools: true }))
  await session.bindExtensions({ mode: "tui", onError: error => errors.push(error),
    uiContext: { select: async (title, choices) => {
      dialogs.push({ title, choices: [...choices] })
      return choices.find(choice => choice.startsWith("Continue"))
    }, notify: () => {}, setStatus: (_key, value) => { if (value) statuses.push(value) },
    setWidget: (key, content) => widgets.set(key, content), theme,
    custom: (factory, options) => new Promise(resolve => {
      let handle
      const component = factory(tui, theme, undefined, () => { handle?.hide(); resolve() })
      // Real Pi resolves overlayOptions only when opening an overlay, not each frame.
      handle = tui.showOverlay(component, typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions)
    }) } })
  const observationPath = join(agentDir, "cache-guard", "observations.jsonl")
  return { session, manager, root, cwd, agentDir, requests, errors, statuses, dialogs, hooks,
    tick: ms => t.mock.timers.tick(ms),
    frame: width => {
      terminal.columns = width
      return tui.compositeOverlays([], width, terminal.rows).map(stripTerminalSequences)
    },
    widget: (width, key = "cache-guard") => {
      const content = widgets.get(key)
      return (typeof content === "function" ? content(tui, theme).render(width) : content ?? []).map(stripTerminalSequences)
    },
    records: () => existsSync(observationPath) ? readFileSync(observationPath, "utf8").trim().split("\n").map(JSON.parse) : [],
    estimates: () => JSON.parse(readFileSync(join(agentDir, "cache-guard", "estimates.json"), "utf8")),
    prompt: async text => {
      await session.prompt(text)
      await delay(0) // allow normal post-run lifecycle notifications to finish
      assert.deepEqual(errors, [])
    } }
}

function assertPrivateTelemetry(h) {
  const files = readdirSync(join(h.agentDir, "cache-guard")).filter(name => /^(observations|estimates)/.test(name))
  assert.ok(files.includes("estimates.json"))
  assert.ok(files.includes("observations.jsonl"))
  for (const file of files) {
    const text = readFileSync(join(h.agentDir, "cache-guard", file), "utf8")
    for (const forbidden of [secret, "Offline response", "offline-native-message", h.cwd, "offline-dummy-not-a-credential"])
      assert.equal(text.includes(forbidden), false, `${file} must not contain ${forbidden}`)
    assert.doesNotMatch(text, /"(?:messages|content|system|payload|authorization)"\s*:/)
  }
  assert.deepEqual(readdirSync(h.cwd), [], "telemetry belongs only in the configured agent directory")
}

// Oracle: subscription-route support requested by the user. These tests reject
// a Copilot-only allowlist and failure to parse Codex response.usage counters.
for (const route of [
  { provider: "anthropic", api: "anthropic-messages", id: "claude-sonnet-5-5", minutes: 5 },
  { provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6.1-sol", minutes: 30 },
]) {
  test(`real Pi ${route.provider} subscription learns from its raw counters without extra requests`, { timeout: 15000 }, async t => {
    const h = await fixture(t, { ...route, reads: [100000, undefined, 0] })
    await h.prompt(secret)
    assert.match(h.statuses.at(-1), new RegExp(`~${route.minutes}m`))
    assert.match(h.statuses.at(-1), /family est\./)
    assert.equal(h.estimates().estimates[0].source, "family")
    for (const text of ["Normal follow-up", "Another normal follow-up"]) await h.prompt(text)
    assert.deepEqual(h.records().map(r => [r.outcome, r.read]), [["hit", 100000], ["unknown", undefined], ["miss", 0]])
    assert.ok(h.records().every(r => r.provider === route.provider))
    assert.equal(h.requests.length, 3)
    assertPrivateTelemetry(h)
  })
}

// Oracle: user-approved adaptive wrapping. Falsifiers: ignoring render(width),
// stale overlay width after unknown -> warm -> ended, or silently clipping cost.
// Boundary: real AgentSession events -> custom component -> real Pi TUI compositor.
test("real Pi corner keeps the full miss cost through status changes and terminal resize", { timeout: 15000 }, async t => {
  const h = await fixture(t, { placement: "corner" })
  await h.prompt(secret)
  assert.match(h.frame(120).join("\n"), /~5m.*\(est\.\)/)
  h.tick(300000)
  for (const width of [120, 42, 32, 24, 42, 120]) {
    const frame = h.frame(width)
    const text = frame.join("\n")
    assert.match(text, /(?:est\.|estimate)/, "ended remains an estimate, not confirmed expiry")
    assert.match(text, /miss[^\n]*~\$0\.63/, "100,002 prompt tokens × $6.25/M rounds to $0.63; cost must remain whole")
    assert.ok(frame.every(line => visibleWidth(line) <= width), `frame must fit ${width} columns`)
    const rows = frame.filter(line => line.includes("▌"))
    assert.equal(rows.length, width >= 42 ? 1 : 2, "wrap only when the shorter single line does not fit")
    assert.ok(rows.every(line => line.trimEnd().endsWith("▐")), "right border must not be clipped")
  }
  assert.equal(h.requests.length, 1, "layout and resizing must not send model requests")
})

test("real Pi narrow corner keeps family provenance and the complete live countdown", { timeout: 15000 }, async t => {
  const h = await fixture(t, { placement: "corner", id: "claude-opus-5.5" })
  await h.prompt(secret)
  // Independent cell count for ◷ ~5m ▰▰▰▰▰▰▰▰▰▰ 5:00 (family est.):
  // prefix 5 + space 1 + bar/time/est 29 = 35; box frame + margins = 39.
  // Wraps below 39 columns.
  for (const width of [120, 48, 38, 24, 120]) {
    const frame = h.frame(width)
    const text = frame.join("\n")
    assert.match(text, /family/)
    assert.match(text, /est\./)
    assert.match(text, /5:00/)
    assert.ok(frame.every(line => visibleWidth(line) <= width))
    assert.equal(frame.filter(line => line.includes("▌")).length, width >= 39 ? 1 : width <= 24 ? 3 : 2)
  }
  h.tick(60000)
  assert.match(h.frame(24).join("\n"), /4:00/)
  assert.equal(h.requests.length, 1)
})

for (const placement of ["above", "below"]) {
  test(`real Pi ${placement} widget adapts to its render width`, { timeout: 15000 }, async t => {
    const h = await fixture(t, { placement })
    await h.prompt(secret)
    h.tick(300000)
    const key = placement === "above" ? "cache-guard" : "cache-guard-below"
    for (const width of [80, 24, 18]) {
      const lines = h.widget(width, key)
      assert.match(lines.join("\n"), /miss[^\n]*~\$0\.63/)
      assert.ok(lines.every(line => visibleWidth(line) <= width), `widget must fit ${width} columns`)
      assert.equal(lines.length, width >= 32 ? 1 : 2)
    }
  })
}

test("real Pi unsupported model without a declaration stays unknown despite reported cache reads", { timeout: 15000 }, async t => {
  const h = await fixture(t, { id: "unsupported-sonnet-alias" })
  await h.prompt(secret)
  assert.match(h.statuses.at(-1), /cache duration unknown/)
  h.tick(240000)
  await delay(0)
  assert.equal(h.requests.length, 1, "unsupported route and saved off cannot cause automatic requests")
  assert.equal(h.dialogs.length, 0)
  assert.deepEqual(h.records(), [], "unsupported telemetry must not enter the learned allowlist")
  assert.deepEqual(h.hooks, ["before_provider_request", "provider_stream_event"])
})

test("real Pi known Opus route displays family estimate and writes private raw evidence", { timeout: 15000 }, async t => {
  const h = await fixture(t, { id: "claude-opus-5.5" })
  await h.prompt(secret)
  assert.match(h.statuses.at(-1), /~5m.*\(family est\.\)/)
  assert.deepEqual(h.records().map(r => [r.outcome, r.read]), [["hit", 100000]])
  assert.equal(h.estimates().estimates[0].source, "family")
  assert.deepEqual(h.hooks, ["before_provider_request", "provider_stream_event"])
  assertPrivateTelemetry(h)
})

test("real Pi absent raw read stays unknown and explicit zero stays a miss despite normalized reads", { timeout: 15000 }, async t => {
  const h = await fixture(t, { reads: [100000, undefined, 0] })
  for (const text of [secret, "Normal follow-up", "Another normal follow-up"]) await h.prompt(text)
  const records = h.records()
  assert.deepEqual(records.map(r => r.outcome), ["hit", "unknown", "miss"])
  assert.deepEqual(records.map(r => r.read), [100000, undefined, 0])
  assert.equal(Object.hasOwn(records[1], "read"), false, "absence is not invented as an explicit zero")
  assert.equal(records[1].qualified, false)
  assert.equal(h.requests.length, 3)
  assert.equal(h.dialogs.length, 0)
  assert.equal(h.hooks.filter(type => type === "before_provider_request").length, 3)
  assert.equal(h.hooks.filter(type => type === "provider_stream_event").length, 3)
  assertPrivateTelemetry(h)
})

test("real Pi three comparable six-minute normal follow-ups promote to the ten-minute bucket without extra sends",
  { timeout: 15000 }, async t => {
    const h = await fixture(t, { reads: [100000, 100000, 100000, 100000] })
    await h.prompt(secret)
    for (let n = 1; n <= 3; n++) {
      // Six minutes rounds up to the next five-minute bucket: ten minutes.
      h.tick(360000)
      await delay(0)
      assert.equal(h.requests.length, n, "elapsed time never initiates a provider request with saved autoHandoff false")
      assert.match(h.statuses.at(-1), /cache est\. ended/)
      assert.doesNotMatch(h.statuses.at(-1), /cache is cold/i)
      await h.prompt(`Normal follow-up ${n}`)
      const estimate = h.estimates().estimates[0]
      assert.equal(estimate.ttlMs, n === 3 ? 600000 : 300000, "three comparable hits are required, not one or two")
      assert.equal(estimate.source, n === 3 ? "learned" : "measured")
    }
    assert.deepEqual(h.records().map(r => r.qualified), [false, true, true, true])
    assert.deepEqual(h.records().slice(1).map(r => r.elapsed), [360000, 360000, 360000])
    assert.ok(h.records().slice(1).every(r => r.substantial))
    assert.match(h.statuses.at(-1), /~10m.*\(est\.\)/)
    assert.equal(h.estimates().estimates[0].lastHitAfterMs, 360000)
    assert.equal(h.dialogs.length, 3)
    for (const { title } of h.dialogs) {
      assert.match(title, /may need rebuilding.*estimated window ended/)
      assert.doesNotMatch(title, /cache is cold/i)
    }
    h.tick(540000) // the learned window's one-minute-before-expiry scheduling point
    await delay(0)
    assert.equal(h.requests.length, 4, "one request per user prompt; no hidden probes or automatic handoff")
    assert.equal(h.manager.getEntries().some(entry => entry.type === "custom" && entry.customType === "cache-guard.handoff"), false)
    assertPrivateTelemetry(h)
  })

test("real Pi gemini-4-argon anchors cold zero-write turns and displays learned duration with read-hit uncertainty",
  { timeout: 15000 }, async t => {
    const h = await fixture(t, {
      id: "gemini-4-argon",
      api: "openai-completions",
      reads: [0, 100000, 100000, 100000, 0, 100000, 0, 100000, 0],
    })
    // Turn 1: cold cache fill with cacheRead=0, cacheWrite=0 (free implicit write).
    await h.prompt(secret)
    assert.match(h.statuses.at(-1), /~15m.*\(est\.\)/, "cold zero-write turn on known implicit-cache route still starts the countdown")
    assert.doesNotMatch(h.statuses.at(-1), /cache duration (?:unknown|variable)/)

    // 3 comparable hits up to 5m06s establish the 10m bucket.
    for (const [elapsedMs, label] of [[60000, "Hit 1m"], [180000, "Hit 3m"], [306000, "Hit 5m06s"]]) {
      h.tick(elapsedMs)
      await h.prompt(label)
    }
    // Isolated early miss at 20s, re-warm hit, late miss at 16m, re-warm hit, late miss at 16m.
    h.tick(20000); await h.prompt("Early miss 20s")
    h.tick(60000); await h.prompt("Re-warm hit 1")
    h.tick(960000); await h.prompt("Late miss 16m 1")
    h.tick(60000); await h.prompt("Re-warm hit 2")
    h.tick(960000); await h.prompt("Late miss 16m 2")

    const latestStatus = h.statuses.at(-1)
    assert.doesNotMatch(latestStatus, /cache duration variable/, "supported route with hit-supported bucket must not collapse into bare variable")
    assert.match(latestStatus, /~10m.*\(est\.\)/)
    assert.match(latestStatus, /hits ≤5:06/)
    assert.match(latestStatus, /1 early miss/)
    assert.match(latestStatus, /writes \$0\/unreported/)
    assertPrivateTelemetry(h)
  })

test("real Pi variable route displays observed read hits and uncertainty instead of bare variable label",
  { timeout: 15000 }, async t => {
    const h = await fixture(t, {
      id: "gemini-3.8-flash",
      api: "openai-completions",
      reads: [100000, 100000, 0],
    })
    await h.prompt(secret)
    h.tick(300000)
    await h.prompt("Comparable hit at 5m")
    h.tick(60000)
    await h.prompt("Comparable early miss at 1m")

    const latestStatus = h.statuses.at(-1)
    assert.match(latestStatus, /cache duration variable/)
    assert.match(latestStatus, /hits up to 5:00/)
    assert.match(latestStatus, /early misses \(1\)/)
    assert.match(latestStatus, /writes unconfirmed/)
    assertPrivateTelemetry(h)
  })
