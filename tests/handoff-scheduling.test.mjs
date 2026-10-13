import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import extension from "../extensions/cache-guard.ts"
import { HANDOFF_PROMPT } from "../extensions/handoff.ts"

// Oracle: automatic-session-handoff spec and ticket 02 (known before implementation).
// Falsifiers: >= threshold, branch/assistant-only costs, early/cold sends,
// stale lifecycle context, retries, and placement-dependent scheduling.
const model = { provider: "p", id: "m", name: "M", api: "anthropic-messages", promptCache: { short: 300 },
  contextWindow: 200000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }
const usage = (total) => ({ input: 0, output: 0, cacheRead: 100000, cacheWrite: 0, totalTokens: 100000,
  cost: { input: 0, output: 0, cacheRead: total, cacheWrite: 0, total } })

function harness(t, { settings = {}, total = 11, mode = "tui" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "handoff-scheduler-"))
  const agentDir = join(root, "agent")
  mkdirSync(agentDir)
  const settingsFile = join(agentDir, "cache-guard.json")
  writeFileSync(settingsFile, JSON.stringify(settings))
  const previousDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  const previousRetention = process.env.PI_CACHE_RETENTION
  delete process.env.PI_CACHE_RETENTION
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: Date.now() })
  const anchor = Date.now()
  let manager = SessionManager.create(join(root, "workspace"), join(root, "sessions"))
  manager.appendMessage({ role: "user", content: "Work", timestamp: anchor })
  const userLeaf = manager.getLeafId()
  const warm = (cost = total, at = Date.now()) => manager.appendMessage({ role: "assistant", provider: "p", model: "m",
    api: "anthropic-messages", content: [{ type: "text", text: "Work done" }], usage: usage(cost), stopReason: "stop", timestamp: at })
  warm()
  let idle = true, pending = false, handlers, command, service
  const sent = [], notes = [], widgets = []
  let ctx = {
    cwd: join(root, "workspace"), mode, hasUI: mode === "tui" || mode === "rpc", model, scopedModels: [], sessionManager: manager,
    isIdle: () => idle, hasPendingMessages: () => pending, getContextUsage: () => ({ tokens: 100000 }),
    ui: { theme: { fg: (_color, text) => text }, setStatus: () => {},
      setWidget: (...args) => widgets.push(args), notify: (...args) => notes.push(args),
      select: async () => undefined, input: async () => undefined },
  }
  const emit = async (name, event = {}, context = ctx) => {
    for (const fn of handlers.get(name) ?? []) await fn({ type: name, ...event }, context)
  }
  const load = () => {
    handlers = new Map()
    service = extension({
      on: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list) },
      registerCommand: (name, options) => { if (name === "cache-guard") command = options }, getCommands: () => [],
      appendEntry: (type, data) => manager.appendCustomEntry(type, data),
      sendUserMessage: (text, options) => {
        assert.equal(service.getState(ctx)?.status, "dispatched", "persist before spending")
        sent.push({ text, options })
      },
    }, { handoff: { tempDir: root, agentDir } })
  }
  load()
  t.after(async () => {
    await emit("session_shutdown", { reason: "quit" })
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousDir
    if (previousRetention === undefined) delete process.env.PI_CACHE_RETENTION
    else process.env.PI_CACHE_RETENTION = previousRetention
    rmSync(root, { recursive: true, force: true })
  })
  return { root, anchor, userLeaf, warm, sent, notes, widgets, emit, load,
    get ctx() { return ctx }, set ctx(value) { ctx = value },
    get manager() { return manager }, get service() { return service }, get command() { return command },
    set idle(value) { idle = value }, set pending(value) { pending = value },
    saved: () => JSON.parse(readFileSync(settingsFile, "utf8")),
    tick: (ms) => t.mock.timers.tick(ms),
    jump: (ms) => { t.mock.timers.setTime(anchor + ms); t.mock.timers.tick(1000) },
    resume: () => { manager = SessionManager.open(manager.getSessionFile()); ctx = { ...ctx, sessionManager: manager }; load() },
    newSession: () => { manager = SessionManager.create(ctx.cwd, join(root, "sessions")); ctx = { ...ctx, sessionManager: manager }; warm(11) },
  }
}

for (const total of [9.99, 10, 10.01]) {
  test(`strict default $10 threshold: total $${total}`, async (t) => {
    const h = harness(t, { settings: { autoHandoff: true }, total })
    await h.emit("session_start")
    h.tick(239000)
    assert.equal(h.sent.length, 0, "61 seconds is too early")
    h.tick(1000)
    assert.equal(h.sent.length, total > 10 ? 1 : 0, "dispatch only above $10, at 60 seconds")
  })
}

test("disabled by default; hidden placement does not disable an opted-in scheduler", async (t) => {
  const h = harness(t, { settings: { placement: "off" } })
  await h.emit("session_start")
  h.tick(240000)
  assert.equal(h.sent.length, 0)
  await h.command.handler("handoff on", h.ctx)
  h.tick(1000)
  assert.equal(h.sent.length, 1)
  assert.deepEqual(h.sent[0], { text: HANDOFF_PROMPT, options: { expandPromptTemplates: false } })
  assert.ok(h.widgets.every(([, content]) => content === undefined))
})

test("full-session $6 assistant + $1 tool + $2 compaction + $2 abandoned branch = $11", async (t) => {
  const h = harness(t, { settings: { autoHandoff: true }, total: 0 })
  h.manager.appendUsage("other", "p", "m", usage(2)) // abandoned, not a cache refresh
  h.manager.branch(h.userLeaf)
  h.manager.appendCompaction("Summary", h.userLeaf, 100000, { usage: usage(100) }, false, usage(2))
  h.manager.appendMessage({ role: "toolResult", toolCallId: "nested", toolName: "lookup", content: [], isError: false,
    usage: usage(1), details: { usage: usage(100) }, timestamp: Date.now() })
  h.warm(6)
  await h.emit("session_start")
  h.tick(240000)
  assert.equal(h.sent.length, 1)
})

test("standalone and branch summary costs count once; nested details and components do not", async (t) => {
  const h = harness(t, { settings: { autoHandoff: true }, total: 0 })
  h.manager.appendUsage("other", "p", "m", usage(4))
  h.manager.branchWithSummary(h.userLeaf, "Branch summary", { usage: usage(100) }, false, usage(3))
  h.warm(3) // 4 + 3 + 3 = exactly $10, not $20 by counting cost components again
  await h.emit("session_start")
  h.tick(240000)
  assert.equal(h.sent.length, 0)
  await h.command.handler("handoff threshold 9.99", h.ctx)
  h.tick(1000)
  assert.equal(h.sent.length, 1)
})

for (const block of ["busy", "pending", "cold", "sleep", "changed session", "changed model", "disabled", "threshold", "compaction"]) {
  test(`no automatic dispatch when ${block}`, async (t) => {
    const h = harness(t, { settings: { autoHandoff: true } })
    await h.emit("session_start")
    if (block === "busy") h.idle = false
    if (block === "pending") h.pending = true
    if (block === "changed session") {
      const replacement = SessionManager.inMemory(h.ctx.cwd)
      replacement.appendMessage(h.manager.getBranch().at(-1).message)
      h.ctx.sessionManager = replacement // still warm and over threshold, but not the started session
    }
    if (block === "changed model") await h.emit("model_select", {}, { ...h.ctx, model: { ...model, id: "different" } })
    if (block === "disabled") await h.command.handler("handoff off", h.ctx)
    if (block === "threshold") await h.command.handler("handoff threshold 11", h.ctx)
    if (block === "compaction") h.manager.appendCompaction("New context", h.userLeaf, 100000)
    if (block === "cold" || block === "sleep") h.jump(block === "cold" ? 299000 : 600000)
    else h.tick(240000)
    assert.equal(h.sent.length, 0)
    h.idle = true
    h.pending = false
    h.jump(900000)
    assert.equal(h.sent.length, 0, "no cold catch-up")
  })
}

test("busy/pending can become eligible before expiry using the latest lifecycle context", async (t) => {
  const h = harness(t, { settings: { autoHandoff: true } })
  await h.emit("session_start", {}, { ...h.ctx, isIdle: () => false })
  h.tick(240000)
  assert.equal(h.sent.length, 0)
  await h.emit("agent_end", { messages: [] })
  h.pending = true
  h.tick(1000)
  assert.equal(h.sent.length, 0)
  h.pending = false
  h.tick(1000)
  assert.equal(h.sent.length, 1)
})

// Inject state changes at the last idle check, after the timer's first observation.
for (const race of ["busy", "pending", "model", "branch", "expiry", "settings"]) {
  test(`dispatch-time recheck rejects a ${race} race`, async (t) => {
    const h = harness(t, { settings: { autoHandoff: true } })
    const idle = h.ctx.isIdle
    let calls = 0, pendingChecks = 0
    if (race === "pending") h.ctx.hasPendingMessages = () => ++pendingChecks > 1
    h.ctx.isIdle = () => {
      calls++
      if (race === "busy") return calls === 1
      if (race === "model") h.ctx.model = { ...model, id: "other" }
      if (race === "branch") h.manager.branch(h.userLeaf)
      if (race === "expiry") t.mock.timers.setTime(h.anchor + 300000)
      // handler is synchronous until its resolved return; no awaited dialog for off.
      if (race === "settings") void h.command.handler("handoff off", h.ctx)
      return idle()
    }
    await h.emit("session_start")
    h.tick(240000)
    assert.equal(h.sent.length, 0)
  })
}

test("UI changes policy without changing budget/placement; threshold alone does not enable", async (t) => {
  const h = harness(t, { settings: { budgetUsd: 0.75, placement: "below" } })
  await h.command.handler("handoff threshold 0", h.ctx)
  await h.emit("session_start")
  h.tick(240000)
  assert.equal(h.sent.length, 0)
  h.ctx.ui.select = async (_title, options) => options.find((item) => item.startsWith("On ·"))
  await h.command.handler("handoff", h.ctx)
  assert.equal(h.saved().autoHandoff, true)
  h.ctx.ui.select = async (_title, options) => options.find((item) => item.startsWith("Threshold ·"))
  h.ctx.ui.input = async () => "12.50"
  await h.command.handler("handoff", h.ctx)
  assert.deepEqual(h.saved(), { budgetUsd: 0.75, placement: "below", autoHandoff: true, handoffThresholdUsd: 12.5 })
  h.tick(1000)
  assert.equal(h.sent.length, 0)
  h.ctx.ui.input = async () => undefined
  await h.command.handler("handoff threshold", h.ctx)
  assert.equal(h.saved().handoffThresholdUsd, 12.5)
})

test("invalid saved policy uses disabled/$10 defaults, and valid policy reloads", async (t) => {
  const h = harness(t, { settings: { autoHandoff: "true", handoffThresholdUsd: -1 }, total: 10 })
  await h.emit("session_start")
  h.tick(240000)
  assert.equal(h.sent.length, 0)
  await h.command.handler("handoff on", h.ctx)
  h.tick(1000)
  assert.equal(h.sent.length, 0, "invalid threshold must not become zero")
  await h.command.handler("handoff threshold 9", h.ctx)
  await h.emit("session_shutdown", { reason: "reload" })
  h.load()
  await h.emit("session_start", { reason: "reload" })
  h.tick(1000)
  assert.equal(h.sent.length, 1)
})

test("automatic turn saves a real artifact; guard survives warming, branch, reload and resume", async (t) => {
  const h = harness(t, { settings: { autoHandoff: true } })
  await h.emit("session_start")
  h.tick(240000)
  assert.equal(h.sent.length, 1)
  await h.emit("before_agent_start", { prompt: HANDOFF_PROMPT })
  const path = join(h.root, "handoff.md"), body = "# Handoff\n\nContinue work.\n"
  const tool = { toolName: "write", toolCallId: "output", input: { path, content: body } }
  await h.emit("tool_call", tool)
  writeFileSync(path, body)
  await h.emit("tool_result", { ...tool, content: [], isError: false })
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] })
  await h.emit("agent_settled")
  const saved = h.service.getAvailable(h.ctx)
  assert.ok(saved)
  rmSync(path)
  assert.ok(readFileSync(saved.path, "utf8").endsWith(body))
  h.warm(1)
  h.tick(240000)
  h.manager.branch(h.userLeaf)
  h.warm(1)
  await h.emit("session_tree")
  h.tick(240000)
  await h.emit("session_shutdown", { reason: "reload" })
  h.load()
  await h.emit("session_start", { reason: "reload" })
  h.tick(1000)
  await h.emit("session_shutdown", { reason: "resume" })
  h.resume()
  await h.emit("session_start", { reason: "resume" })
  h.tick(1000)
  assert.equal(h.sent.length, 1)
  await h.emit("session_shutdown", { reason: "new" })
  h.newSession()
  h.load()
  await h.emit("session_start", { reason: "new" })
  h.tick(240000)
  assert.equal(h.sent.length, 2, "a separate session has its own guard")
})

test("failed generation never retries and shutdown stops scheduling", async (t) => {
  const h = harness(t, { settings: { autoHandoff: true } })
  await h.emit("session_start")
  h.tick(240000)
  await h.emit("before_agent_start", { prompt: HANDOFF_PROMPT })
  await h.emit("agent_end", { messages: [] })
  await h.emit("agent_settled")
  assert.equal(h.service.getState(h.ctx).status, "failed")
  h.warm(1)
  h.tick(240000)
  assert.equal(h.sent.length, 1)
  await h.emit("session_shutdown")
  h.newSession()
  h.tick(240000)
  assert.equal(h.sent.length, 1)
})

test("settings UI, completions, validation, persistence, and budget/placement preservation", async (t) => {
  const h = harness(t, { settings: { budgetUsd: 0.75, placement: "below" } })
  await h.command.handler("handoff on", h.ctx)
  await h.command.handler("handoff threshold $12.50", h.ctx)
  for (const bad of ["-1", "NaN", "Infinity", "1e309", "nope"]) {
    await h.command.handler(`handoff threshold ${bad}`, h.ctx)
    assert.equal(h.notes.at(-1)[1], "error")
    assert.equal(h.saved().handoffThresholdUsd, 12.5)
  }
  await h.command.handler("budget 0.5", h.ctx)
  await h.command.handler("off", h.ctx)
  assert.deepEqual(h.saved(), { budgetUsd: 0.5, placement: "off", autoHandoff: true, handoffThresholdUsd: 12.5 })
  assert.ok(h.command.getArgumentCompletions("hand").some((item) => item.value === "handoff"))
  assert.ok(h.command.getArgumentCompletions("handoff ").some((item) => item.value === "handoff on"))
  assert.ok(h.command.getArgumentCompletions("handoff th").some((item) => item.value === "handoff threshold"))
  assert.equal(h.command.getArgumentCompletions("handoff threshold 12"), null, "keep an amount already being typed")
  const menus = []
  h.ctx.ui.select = async (title, options) => { menus.push({ title, options }); return options.find((item) => item.startsWith("Automatic handoff")) }
  await h.command.handler("", h.ctx)
  assert.match(menus[0].options.join("\n"), /on.*12\.50/)
  assert.match(menus[1].title, /handoff/i)
  await h.command.handler("handoff off", h.ctx)
  await h.command.handler("handoff threshold 0", h.ctx)
  assert.equal(h.saved().autoHandoff, false)
  assert.equal(h.saved().handoffThresholdUsd, 0)
})

for (const mode of ["rpc", "json", "print"]) {
  test(`no automatic sends in ${mode} mode`, async (t) => {
    const h = harness(t, { mode, settings: { autoHandoff: true } })
    await h.emit("session_start")
    h.tick(240000)
    assert.equal(h.sent.length, 0)
  })
}
