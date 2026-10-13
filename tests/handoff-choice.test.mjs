import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readdirSync, statSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import extension from "../extensions/cache-guard.ts"

// Independent price oracle: 100,000 × $6.25 / 1,000,000 = $0.625 (short retention).
process.env.PI_CACHE_RETENTION = "short"
process.env.PI_CACHE_GUARD_MIN_USD = "0.10"

const model = { provider: "anthropic", id: "expensive", name: "Current", api: "anthropic-messages",
  contextWindow: 200000, promptCache: { short: 300 }, cost: { input: 5, output: 25, cacheRead: .5, cacheWrite: 6.25 } }
const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" }
const request = { source: "interactive", text: "Continue my task", images: [image] }

// Oracle: spec stories 19–26 and installed Pi command-context contract.
// Falsifiers: unverified files offered; metadata/generation marks stale; retained old ctx;
// plain-text internal command; lost/duplicate images; silent switch on cancel.
function harness(t) {
  const root = mkdtempSync(join(tmpdir(), "handoff-choice-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manager = SessionManager.create(root, join(root, "sessions"))
  const append = (text) => manager.appendMessage({ role: "user", content: text, timestamp: 0 })
  append("Original task")
  manager.appendMessage({ role: "assistant", provider: model.provider, model: model.id, timestamp: 0,
    content: [{ type: "text", text: "Original work" }], usage: { input: 0, cacheRead: 100000, cacheWrite: 0 }, stopReason: "stop" })
  const source = { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), leafId: manager.getLeafId() }
  append("Automatic handoff generation")
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Saved" }], timestamp: 0, stopReason: "stop" })
  const completedLeafId = manager.getLeafId()
  const path = join(root, "agent", "handoffs", "fixture.md")
  mkdirSync(join(root, "agent", "handoffs"), { recursive: true })
  const body = "# Verified handoff\nReference the plan.\n"
  writeFileSync(path, body)
  const artifact = { path, sha256: createHash("sha256").update(body).digest("hex"), source,
    createdAt: "2026-01-02T03:04:05.000Z", completedLeafId }
  manager.appendCustomEntry("cache-guard.handoff", { version: 1, runId: "fixture", source, startedAt: artifact.createdAt,
    status: "ready", artifact, completedLeafId })
  const commands = new Map(), handlers = new Map(), sent = [], contexts = [], bridges = [], notes = []
  let options, title, pick = (choices) => choices.find((s) => s.startsWith("New session")), editor, replacements = 0, stale = false
  let cancelSwitch = false, failSwitch = false, failSend = false, beforeBridge
  const ctx = { cwd: join(root, "workspace"), hasUI: true, mode: "tui", model, scopedModels: [], sessionManager: manager,
    isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ tokens: 100000 }),
    ui: { select: async (heading, choices) => { title = heading; options = choices; return pick(choices) },
      notify: (text, level) => notes.push({ text, level }), setEditorText: (text) => { if (stale) throw Error("stale context"); editor = text },
      getEditorText: () => editor ?? "", setStatus: () => {}, setWidget: () => {}, theme: { fg: (_color, text) => text } } }
  const fresh = { ...ctx, sessionManager: SessionManager.inMemory(root),
    sendMessage: async (message) => contexts.push(message),
    sendUserMessage: async (content, opts) => { if (failSend) throw Error("send failed"); sent.push({ content, opts }) },
    switchSession: async (_path, opts) => { stale = false; await opts.withSession({ ...ctx, sendUserMessage: fresh.sendUserMessage }); return { cancelled: false } } }
  const commandCtx = { ...ctx, newSession: async (opts) => {
    replacements++
    if (failSwitch) throw Error("switch failed")
    if (cancelSwitch) return { cancelled: true }
    assert.equal(opts.parentSession, source.sessionFile)
    stale = true
    await opts.withSession(fresh)
    return { cancelled: false }
  } }
  const load = () => {
    commands.clear(); handlers.clear()
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = join(root, "agent")
    try { extension({ on: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list) },
      registerCommand: (name, cmd) => commands.set(name, cmd), getCommands: () => [],
      appendEntry: (type, data) => manager.appendCustomEntry(type, data),
      sendUserMessage: (text, opts) => {
        bridges.push({ text, opts })
        assert.equal(opts.expandPromptTemplates, true, "must cross command dispatch boundary")
        assert.ok(text.startsWith("/"))
      }, setModel: async () => false,
    }, { handoff: { agentDir: join(root, "agent"), tempDir: root } }) } finally {
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    }
  }
  load()
  t.after(async () => { for (const fn of handlers.get("session_shutdown") ?? []) await fn({}, ctx) })
  return { root, manager, source, artifact, body, ctx, commandCtx, fresh, commands, sent, contexts, bridges, notes, load, append,
    get options() { return options }, get title() { return title }, get editor() { return editor }, get replacements() { return replacements },
    set pick(value) { pick = value }, set cancelSwitch(value) { cancelSwitch = value }, set failSwitch(value) { failSwitch = value },
    set failSend(value) { failSend = value }, set beforeBridge(value) { beforeBridge = value },
    emit: async (name, event = {}) => { for (const fn of handlers.get(name) ?? []) await fn({ type: name, ...event }, ctx) },
    startSession: async () => { for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx) },
    input: async (event = request) => { let result; for (const fn of handlers.get("input") ?? []) result = await fn(event, ctx); return result },
    dispatch: async () => { beforeBridge?.(); const text = bridges.at(-1).text; const [name, ...args] = text.slice(1).split(" ");
      assert.ok(commands.has(name), "registered bridge command required"); await commands.get(name).handler(args.join(" "), commandCtx) },
  }
}

test("verified handoff crosses command boundary, links parent, sends once through fresh ctx with images", async (t) => {
  const h = harness(t)
  assert.deepEqual(await h.input(), { action: "handled" })
  assert.equal(h.replacements, 0)
  assert.equal(h.bridges.length, 1)
  assert.equal(h.bridges[0].opts.expandPromptTemplates, true, "internal slash command must be dispatched, never sent as model text")
  assert.match(h.options[0], /New session.*2026-01-02T03:04:05/)
  assert.doesNotMatch(h.options[0], /older/i)
  assert.match(h.options[1], /Continue.*estimated prompt\/cache cost.*\$0.63/)
  await h.dispatch()
  assert.equal(h.replacements, 1)
  assert.equal(h.sent.length, 1)
  const content = h.sent[0].content
  assert.equal(h.contexts.length, 1)
  assert.equal(h.contexts[0].content, h.body)
  assert.equal(content[0].text, request.text)
  assert.equal(h.sent[0].opts.expandPromptTemplates, true)
  assert.deepEqual(content.slice(1), [image])
  await h.dispatch() // token consumed, never duplicate send
  assert.equal(h.sent.length, 1)
  h.ctx.sessionManager = SessionManager.open(h.source.sessionFile)
  h.load(); h.pick = (choices) => choices.find((s) => s.startsWith("Continue"))
  assert.deepEqual(await h.input({ source: "interactive", text: "Return to old session" }), { action: "continue" }, "consumed draft must not replay on source resume")
})

test("missing and modified artifacts are not offered", async (t) => {
  for (const mutation of [(p) => rmSync(p), (p) => writeFileSync(p, "# Tampered")]) {
    const h = harness(t); mutation(h.artifact.path); h.pick = (choices) => choices[0]
    assert.deepEqual(await h.input(), { action: "continue" })
    assert.equal(h.options.some((s) => s.startsWith("New session")), false)
    assert.equal(h.bridges.length, 0)
  }
})

test("metadata is fresh; later and divergent branch task work is older", async (t) => {
  const h = harness(t); h.pick = () => undefined
  h.manager.appendCustomEntry("unrelated", { value: 1 })
  await h.input(); assert.doesNotMatch(h.options[0], /older/i)
  h.append("Later work")
  await h.input(); assert.match(h.options[0], /older/i)
  h.manager.branch(h.source.leafId); h.append("Different branch task")
  await h.input(); assert.match(h.options[0], /older/i)
})

test("continue retains old history, without replacement", async (t) => {
  const h = harness(t); const count = h.manager.getBranch().length
  h.pick = (choices) => choices.find((s) => s.startsWith("Continue"))
  assert.deepEqual(await h.input(), { action: "continue" })
  assert.equal(h.manager.getBranch().length, count)
  assert.equal(h.replacements, 0); assert.equal(h.bridges.length, 0)
})

test("cancel preserves text and images across reload and an edited retry", async (t) => {
  const h = harness(t); h.pick = () => undefined
  assert.deepEqual(await h.input(), { action: "handled" })
  assert.equal(h.editor, request.text)
  const drafts = join(h.root, "agent", "cache-guard-drafts")
  assert.equal(readdirSync(drafts).length, 1)
  if (process.platform !== "win32") assert.equal(statSync(join(drafts, readdirSync(drafts)[0])).mode & 0o777, 0o600)
  h.load(); h.pick = (choices) => choices.find((s) => s.startsWith("Continue"))
  assert.deepEqual(await h.input({ source: "interactive", text: "Edited task" }),
    { action: "transform", text: "Edited task", images: [image] })
  assert.equal(readdirSync(drafts).length, 1, "input processing is not acceptance")
  await h.emit("before_agent_start", { prompt: "Edited task", images: [image] })
  const message = { role: "user", content: [{ type: "text", text: "Edited task" }, image], timestamp: 1 }
  await h.emit("message_end", { message })
  assert.equal(readdirSync(drafts).length, 1, "message_end precedes persistence")
  h.manager.appendMessage(message)
  await h.emit("turn_end")
  assert.equal(readdirSync(drafts).length, 0)
  assert.deepEqual(await h.input({ source: "interactive", text: "Next task" }), { action: "continue" })
})

test("unrelated persistence or a newer cancelled draft cannot consume recovery data", async (t) => {
  const h = harness(t), drafts = join(h.root, "agent", "cache-guard-drafts")
  h.pick = () => undefined
  await h.input()
  h.pick = (choices) => choices.find((s) => s.startsWith("Continue"))
  await h.input({ source: "interactive", text: "Accepted request" })
  await h.emit("before_agent_start", { prompt: "Accepted request", images: [image] })
  const unrelated = { role: "user", content: [{ type: "text", text: "Unrelated request" }], timestamp: 1 }
  await h.emit("message_end", { message: unrelated })
  h.manager.appendMessage(unrelated)
  await h.emit("turn_end")
  assert.equal(readdirSync(drafts).length, 1)
  const accepted = { role: "user", content: [{ type: "text", text: "Accepted request" }, image], timestamp: 2 }
  await h.emit("message_end", { message: accepted })
  h.pick = () => undefined
  await h.input({ source: "interactive", text: "New cancelled draft" })
  h.manager.appendMessage(accepted)
  await h.emit("turn_end")
  assert.equal(readdirSync(drafts).length, 1, "matching old request cannot remove a newer draft")
  h.load(); await h.startSession()
  assert.equal(h.editor, "New cancelled draft")
})

test("cancelled or failed switch and a removed file preserve the pending request", async (t) => {
  for (const failure of ["cancelSwitch", "failSwitch", "removed"]) {
    const h = harness(t); if (failure !== "removed") h[failure] = true
    await h.input()
    if (failure === "removed") rmSync(h.artifact.path)
    await h.dispatch()
    assert.equal(h.sent.length, 0); assert.equal(h.editor, request.text)
    h.load(); h.pick = (choices) => choices.find((s) => s.startsWith("Continue"))
    assert.deepEqual(await h.input({ source: "interactive", text: request.text }),
      { action: "transform", text: request.text, images: [image] })
  }
})

test("send failure rolls back through fresh ctx and preserves request", async (t) => {
  const h = harness(t); h.failSend = true
  await h.input(); await h.dispatch()
  assert.equal(h.sent.length, 0); assert.equal(h.editor, request.text)
  h.load(); h.pick = (choices) => choices.find((s) => s.startsWith("Continue"))
  assert.deepEqual(await h.input({ source: "interactive", text: request.text }),
    { action: "transform", text: request.text, images: [image] })
})

test("session resume restores saved request text without replacing an existing editor draft", async (t) => {
  const h = harness(t); h.pick = () => undefined
  await h.input()
  h.ctx.ui.setEditorText("")
  h.load(); await h.startSession()
  assert.equal(h.editor, request.text)
  h.ctx.ui.setEditorText("Existing draft")
  await h.startSession()
  assert.equal(h.editor, "Existing draft")
})

test("busy or changed source cannot replace a session", async (t) => {
  for (const changed of [false, true]) {
    const h = harness(t)
    await h.input()
    if (changed) h.commandCtx.sessionManager = SessionManager.inMemory(h.ctx.cwd)
    else h.commandCtx.isIdle = () => false
    await h.dispatch()
    assert.equal(h.replacements, 0); assert.equal(h.sent.length, 0)
    assert.ok(h.notes.length)
  }
})

test("unwritable recovery storage prevents replacement and retains images in memory", async (t) => {
  const h = harness(t)
  writeFileSync(join(h.root, "agent", "cache-guard-drafts"), "Not a directory")
  assert.deepEqual(await h.input(), { action: "handled" })
  assert.equal(h.bridges.length, 0); assert.equal(h.editor, request.text)
  assert.ok(h.notes.some((n) => n.text.includes("memory only")))
  h.pick = (choices) => choices.find((s) => s.startsWith("Continue"))
  assert.deepEqual(await h.input({ source: "interactive", text: "Retry" }), { action: "transform", text: "Retry", images: [image] })
})

test("file-less source omits parent link and keeps handoff plus images on send failure", async (t) => {
  const h = harness(t)
  h.commandCtx.sessionManager = { ...h.manager,
    getSessionId: () => h.manager.getSessionId(), getEntries: () => h.manager.getEntries(), getBranch: (id) => h.manager.getBranch(id),
    getSessionFile: () => undefined }
  let parent
  h.commandCtx.newSession = async (opts) => { parent = opts.parentSession; await opts.withSession(h.fresh); return { cancelled: false } }
  h.failSend = true
  await h.input(); await h.dispatch()
  assert.equal(parent, undefined); assert.equal(h.sent.length, 0)
  assert.ok(h.editor.includes(h.body)); assert.ok(h.editor.endsWith(request.text))
  h.ctx.sessionManager = h.fresh.sessionManager
  h.load()
  assert.deepEqual(await h.input({ source: "interactive", text: h.editor }), { action: "transform", text: h.editor, images: [image] })
})

test("a failed dialog retains the request", async (t) => {
  const h = harness(t); h.pick = () => { throw Error("Dialog failed") }
  assert.deepEqual(await h.input(), { action: "handled" })
  assert.equal(h.editor, request.text); assert.equal(h.bridges.length, 0)
  h.load(); h.pick = (choices) => choices.find((s) => s.startsWith("Continue"))
  assert.deepEqual(await h.input({ source: "interactive", text: request.text }), { action: "transform", text: request.text, images: [image] })
})

test("budget and input exclusions do not offer or dispatch a handoff", async (t) => {
  const h = harness(t)
  for (const event of [{ ...request, source: "extension" }, { ...request, streamingBehavior: "steer" },
    { ...request, text: "!ls" }, { ...request, text: "/new" }]) {
    assert.deepEqual(await h.input(event), { action: "continue" })
  }
  h.ctx.getContextUsage = () => ({ tokens: 1 })
  assert.deepEqual(await h.input(), { action: "continue" })
  assert.equal(h.options, undefined); assert.equal(h.bridges.length, 0)
})
