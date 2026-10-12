import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import { createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime,
  SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent"
import extension from "../extensions/cache-guard.ts"

// Real Pi prompt → registered command → runtime invalidation/reload → fresh withSession.
// No provider HTTP implementation is registered for this model. All responses are local.
test("real Pi runtime replaces through command dispatch with a controlled offline provider", { timeout: 15000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "handoff-real-pi-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, "workspace"), agentDir = join(root, "agent")
  mkdirSync(cwd); mkdirSync(agentDir)
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = agentDir
  t.after(() => { if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir })
  writeFileSync(join(agentDir, "cache-guard.json"), JSON.stringify({ budgetUsd: 0, placement: "off" }))
  writeFileSync(join(root, "fixture-template.md"), "Expanded template: $@")
  const requests = [], errors = [], headings = [], notes = []
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: { enabled: false } })
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "catalog.json"), allowModelNetwork: false, refreshOnCreate: false })
  const provider = "cache-guard-offline-fixture"
  modelRuntime.registerProvider(provider, { api: "handoff-fixture-api", baseUrl: "http://127.0.0.1:1", apiKey: "not-a-real-key",
    models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text", "image"], contextWindow: 200000,
      maxTokens: 1000, promptCache: { short: 300, long: 300 }, cost: { input: 5, output: 25, cacheRead: .5, cacheWrite: 6.25 } }],
    streamSimple: (model, context) => {
      requests.push(structuredClone(context.messages))
      const stream = new AssistantMessageEventStream()
      const message = { role: "assistant", provider, api: model.api, model: model.id, timestamp: Date.now(),
        content: [{ type: "text", text: "Offline response" }], stopReason: "stop",
        usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 22,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
      queueMicrotask(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end() })
      return stream
    } })
  const model = modelRuntime.getModel(provider, "fixture")
  assert.ok(model)
  const manager = SessionManager.create(cwd, join(root, "sessions"))
  manager.appendMessage({ role: "user", content: "Original long task", timestamp: 0 })
  manager.appendMessage({ role: "assistant", provider, api: model.api, model: model.id, timestamp: 0,
    content: [{ type: "text", text: "OLD HISTORY MUST NOT FOLLOW" }], stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 100000, cacheWrite: 0, totalTokens: 100000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } })
  const parent = manager.getSessionFile()
  const source = { sessionId: manager.getSessionId(), sessionFile: parent, leafId: manager.getLeafId() }
  const path = join(agentDir, "handoffs", "fixture.md"), body = "# Saved handoff\nKeep the plan.\n"
  mkdirSync(join(agentDir, "handoffs")); writeFileSync(path, body)
  const artifact = { path, source, createdAt: "2026-01-02T03:04:05.000Z", completedLeafId: manager.getLeafId(),
    sha256: createHash("sha256").update(body).digest("hex") }
  manager.appendCustomEntry("cache-guard.handoff", { version: 1, runId: "fixture", source, startedAt: artifact.createdAt,
    status: "ready", artifact, completedLeafId: artifact.completedLeafId })
  let replacementDone
  const done = new Promise((resolve) => { replacementDone = resolve })
  const createRuntime = async (opts) => {
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager: settings, modelRuntime,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        noContextFiles: true,
        promptsOverride: () => ({ prompts: [{ name: "fixture-template", description: "Offline test template", source: "user",
          filePath: join(root, "fixture-template.md"), content: "Expanded template: $@" }], diagnostics: [] }),
        extensionFactories: [(pi) => extension(pi, { handoff: { agentDir, tempDir: root } })] } })
    return { ...(await createAgentSessionFromServices({ services, sessionManager: opts.sessionManager,
      sessionStartEvent: opts.sessionStartEvent, model, noTools: true })), services, diagnostics: services.diagnostics }
  }
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: manager })
  t.after(() => runtime.dispose())
  const bind = async (session) => session.bindExtensions({ mode: "tui", onError: (e) => errors.push(e),
    uiContext: { select: async (title, choices) => { headings.push(title); return choices.find((s) => s.startsWith("New session")) },
      setEditorText: () => {}, notify: (text) => notes.push(text), setStatus: () => {}, setWidget: () => {},
      theme: { fg: (_color, text) => text } },
    commandContextActions: { waitForIdle: () => session.waitForIdle(),
      newSession: async (opts) => { try { return await runtime.newSession(opts) } finally { replacementDone() } },
      switchSession: (path, opts) => runtime.switchSession(path, opts) } })
  runtime.setRebindSession(bind)
  await bind(runtime.session)
  const original = runtime.session
  const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC" }
  await original.prompt("/fixture-template Pending offline request", { images: [image] })
  await done
  assert.deepEqual(errors, [])
  assert.equal(headings.length, 1)
  assert.notEqual(runtime.session, original)
  assert.equal(requests.length, 1, "only the fresh session makes one local model request")
  const payload = JSON.stringify(requests[0])
  assert.ok(payload.includes(body.replaceAll("\n", "\\n")))
  assert.ok(payload.includes("Expanded template: Pending offline request"), "pending template must expand on the fresh command boundary")
  assert.equal(payload.includes("OLD HISTORY MUST NOT FOLLOW"), false)
  assert.equal(payload.includes("/cache-guard-resume"), false)
  assert.ok(requests[0].some((m) => m.role === "user" && m.content.some((c) => c.type === "image")))
  assert.equal(runtime.session.sessionManager.getHeader().parentSession, parent)
  assert.ok(readFileSync(parent, "utf8").includes("OLD HISTORY MUST NOT FOLLOW"))
})
