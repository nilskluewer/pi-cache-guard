import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import extension from "../extensions/cache-guard.ts"
import { HANDOFF_PROMPT } from "../extensions/handoff.ts"

const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC" }
// Oracle: spec stories 14/24/27. Rejection must keep recovery data; Pi-owned retries
// belong to one dispatch; shell expansion must name the file actually written.
async function fixture(t, responses, { retry = false, trailingTemp = false, beforeSettle, rejectCompletionNotice = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "handoff-lifecycle-pi-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, "workspace"), agentDir = join(root, "agent")
  mkdirSync(cwd); mkdirSync(agentDir)
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR, oldTemp = process.env.TMPDIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.TMPDIR = root + (trailingTemp ? "/" : "")
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir
    if (oldTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTemp
  })
  writeFileSync(join(agentDir, "cache-guard.json"), JSON.stringify({ budgetUsd: 0, placement: "off" }))
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: retry, maxRetries: 2, baseDelayMs: 1 }, cacheWarming: { enabled: false } })
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false })
  const provider = "github-copilot", requests = [], notes = [], errors = [], events = [], working = []
  modelRuntime.registerProvider(provider, { api: "anthropic-messages", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "claude-sonnet-5.5", name: "Offline", reasoning: false, input: ["text", "image"], contextWindow: 200000,
      maxTokens: 1000, promptCache: { short: 300, long: 300 }, cost: { input: 5, output: 25, cacheRead: .5, cacheWrite: 6.25 } }],
    streamSimple: (model, context) => {
      requests.push(structuredClone(context.messages))
      const response = responses(requests.length, root)
      const message = { role: "assistant", provider, api: model.api, model: model.id, timestamp: Date.now(),
        content: response.content ?? [{ type: "text", text: "Offline done" }], stopReason: response.reason ?? "stop",
        ...(response.error ? { errorMessage: response.error } : {}),
        usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 22,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
      const stream = new AssistantMessageEventStream()
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message })
        stream.push(message.stopReason === "error" ? { type: "error", reason: "error", error: message } : { type: "done", reason: message.stopReason, message })
        stream.end()
      })
      return stream
    } })
  await modelRuntime.setRuntimeApiKey(provider, "offline-key")
  const model = modelRuntime.getModel(provider, "claude-sonnet-5.5")
  const manager = SessionManager.create(cwd, join(root, "sessions"))
  manager.appendMessage({ role: "user", content: "Old task", timestamp: 0 })
  manager.appendMessage({ role: "assistant", provider, api: model.api, model: model.id, timestamp: 0,
    content: [{ type: "text", text: "Old work" }], stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 100000, cacheWrite: 0, totalTokens: 100000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
  let service, pick = () => undefined
  const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: settings, modelRuntime,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        service = extension(pi, { handoff: { agentDir } })
        pi.on("before_agent_start", () => { events.push("before_agent_start") })
        if (beforeSettle) pi.on("agent_before_settle", beforeSettle)
        pi.registerCommand("fixture-handoff", { description: "Offline test", handler: (_args, ctx) => { assert.equal(service.start(ctx), true) } })
      }] } })
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model })
  t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown" }); session.dispose() })
  await session.bindExtensions({ mode: "tui", onError: (e) => errors.push(e),
    uiContext: { select: async (_title, choices) => pick(choices), setEditorText: () => {}, getEditorText: () => "",
      notify: (text) => {
        notes.push(text)
        if (rejectCompletionNotice && text.startsWith("A handoff was created")) throw new Error("Notification display failed")
      }, setStatus: () => {}, setWidget: () => {},
      setWorkingMessage: (text) => working.push(text), theme: { fg: (_color, text) => text } } })
  session.subscribe((event) => events.push(event.type))
  const drafts = () => { try { return readdirSync(join(agentDir, "cache-guard", "drafts")) } catch { return [] } }
  return { root, agentDir, session, manager, modelRuntime, provider, requests, notes, errors, events, working, drafts,
    set pick(value) { pick = value }, state: () => manager.getEntries().filter((e) => e.type === "custom" && e.customType === "cache-guard.handoff").at(-1)?.data }
}

for (const retry of [false, true]) test(`real Pi generation uses bash output and settles after ${retry ? "503 retry" : "shell TMPDIR concatenation"}`, { timeout: 15000 }, async (t) => {
  const h = await fixture(t, (n, root) => {
    if (retry && n === 1) return { reason: "error", error: "503 Service Unavailable" }
    if (n === (retry ? 2 : 1)) return { reason: "toolUse", content: [{ type: "toolCall", id: "write-handoff", name: "bash",
      arguments: { command: retry ? `printf '# Handoff\\n' > '${join(root, "handoff.md")}'` : 'printf \'# Handoff\\n\' > "${TMPDIR}handoff.md"' } }] }
    return {}
  }, { retry, trailingTemp: true })
  const settled = new Promise((resolve) => { const unsub = h.session.subscribe((event) => { if (event.type === "agent_settled") { unsub(); resolve() } }) })
  await h.session.prompt("/fixture-handoff")
  await settled
  assert.equal(readFileSync(join(h.root, "handoff.md"), "utf8"), "# Handoff\n", "real built-in bash tool writes the file")
  assert.equal(h.state().status, "ready")
  assert.ok(readFileSync(h.state().artifact.path, "utf8").endsWith("# Handoff\n"))
  assert.equal(h.requests.length, retry ? 3 : 2)
  assert.equal(h.manager.getEntries().filter((e) => e.type === "message" && e.message.role === "user" && JSON.stringify(e.message.content).includes(HANDOFF_PROMPT.slice(0, 30))).length, 1)
  assert.equal(h.notes.filter((n) => n.startsWith("Handoff failed:")).length, 0)
  assert.equal(h.notes.filter((n) => n.startsWith("A handoff was created")).length, 1)
  assert.deepEqual(h.working, ["Preparing handoff…", undefined], "working label spans the run, including retries, and then resets")
  assert.deepEqual(h.errors, [])
})

test("real Pi continuation updates the artifact before final success notification", { timeout: 15000 }, async (t) => {
  let continued = false, h
  h = await fixture(t, (n, root) => {
    if (n === 1 || n === 3) return { reason: "toolUse", content: [{ type: "toolCall", id: `write-${n}`, name: "write",
      arguments: { path: join(root, "handoff.md"), content: n === 1 ? "# Draft\n" : "# Final handoff\n" } }] }
    return {}
  }, { beforeSettle: (event) => {
    assert.equal(h.notes.some((n) => n.startsWith("A handoff was created")), false, "success is not final at the actionable boundary")
    assert.deepEqual(h.working, ["Preparing handoff…"], "continuation must not reset the working label early")
    if (continued) return
    continued = true
    return { entries: [...event.entries, { type: "custom_message", customType: "offline-verification", content: "Verify the handoff", display: false }], continue: true }
  } })
  const settled = new Promise((resolve) => { const unsub = h.session.subscribe((event) => { if (event.type === "agent_settled") { unsub(); resolve() } }) })
  await h.session.prompt("/fixture-handoff")
  await settled
  assert.equal(h.requests.length, 4)
  assert.equal(h.state().status, "ready")
  assert.ok(readFileSync(h.state().artifact.path, "utf8").endsWith("# Final handoff\n"))
  assert.equal(h.notes.filter((n) => n.startsWith("A handoff was created")).length, 1)
  assert.deepEqual(h.working, ["Preparing handoff…", undefined])
  assert.deepEqual(h.errors, [])
})

test("real Pi exhausted retries report one final failure and never dispatch another handoff", { timeout: 15000 }, async (t) => {
  const h = await fixture(t, () => ({ reason: "error", error: "503 Service Unavailable" }), { retry: true })
  const settled = new Promise((resolve) => { const unsub = h.session.subscribe((event) => { if (event.type === "agent_settled") { unsub(); resolve() } }) })
  await h.session.prompt("/fixture-handoff")
  await settled
  assert.equal(h.requests.length, 3)
  assert.equal(h.state().status, "failed")
  assert.equal(h.notes.filter((n) => n.startsWith("Handoff failed:")).length, 1)
  assert.equal(h.notes.some((n) => n.startsWith("A handoff was created")), false)
  assert.deepEqual(h.working, ["Preparing handoff…", undefined], "failed runs must restore the regular working label")
  assert.equal(h.manager.getEntries().filter((e) => e.type === "custom" && e.customType === "cache-guard.handoff" && e.data.status === "dispatched").length, 1)
  assert.deepEqual(h.errors, [])
})

test("real Pi completion display failure cannot undo a verified durable handoff", { timeout: 15000 }, async (t) => {
  const h = await fixture(t, (n, root) => n === 1 ? { reason: "toolUse", content: [{ type: "toolCall", id: "write-notice-test", name: "write",
    arguments: { path: join(root, "handoff.md"), content: "# Saved despite display failure\n" } }] } : {}, { rejectCompletionNotice: true })
  const settled = new Promise((resolve) => { const unsub = h.session.subscribe((event) => { if (event.type === "agent_settled") { unsub(); resolve() } }) })
  await h.session.prompt("/fixture-handoff")
  await settled
  assert.equal(h.state().status, "ready")
  assert.ok(readFileSync(h.state().artifact.path, "utf8").endsWith("# Saved despite display failure\n"))
  assert.equal(h.notes.some((text) => text.startsWith("Handoff failed:")), false)
  assert.deepEqual(h.working, ["Preparing handoff…", undefined])
  assert.deepEqual(h.errors, [])
})

test("real Pi auth rejection retains cancelled images until an edited request is persisted", { timeout: 15000 }, async (t) => {
  const h = await fixture(t, () => ({}))
  await h.session.prompt("Request with image", { images: [image] }) // Cancel the cold-send dialog.
  assert.equal(h.drafts().length, 1)
  h.pick = (choices) => choices.find((s) => s.startsWith("Send") || s.startsWith("Continue"))
  await h.modelRuntime.removeRuntimeApiKey(h.provider)
  await assert.rejects(h.session.prompt("Edited request"), /API key|Authentication/)
  assert.equal(h.events.includes("before_agent_start"), false)
  assert.equal(h.drafts().length, 1, "auth fails before persistence; recovery draft must remain")
  assert.equal(h.requests.length, 0)
  await h.modelRuntime.setRuntimeApiKey(h.provider, "offline-key")
  // Controlled fault at Pi's real image-processing boundary, after before_agent_start.
  const normalize = h.session._normalizePromptImages
  h.session._normalizePromptImages = async () => { throw new Error("offline image processing rejection") }
  try { await assert.rejects(h.session.prompt("Edited request"), /image processing rejection/) }
  finally { h.session._normalizePromptImages = normalize }
  assert.equal(h.events.includes("before_agent_start"), true)
  assert.equal(h.drafts().length, 1, "before_agent_start is also too early to consume recovery data")
  assert.equal(h.requests.length, 0)
  await h.session.prompt("Edited request", { images: [image] })
  assert.equal(h.drafts().length, 0)
  const persisted = SessionManager.open(h.manager.getSessionFile()).getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user").at(-1).message
  assert.equal(persisted.content[0].text, "Edited request")
  assert.equal(persisted.content.filter((part) => part.type === "image").length, 1)
  const users = h.requests[0].filter((m) => m.role === "user")
  assert.equal(users.at(-1).content.filter((c) => c.type === "image").length, 1, "same newly attached image must not duplicate the saved image")
  await h.session.prompt("Unrelated next request")
  assert.equal(h.requests.at(-1).filter((m) => m.role === "user").at(-1).content.filter((c) => c.type === "image").length, 0)
  assert.deepEqual(h.errors, [])
})
