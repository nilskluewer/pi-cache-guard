import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import extension from "../extensions/cache-guard.ts"

// Oracle: the current user-authored handoff prompt, passed without added instructions or focus.
const PROMPT = `Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS ($TMPDIR, else /tmp; %TEMP% on Windows) - not the current workspace.

Include a "used skills" section in the document, naming which skills the previous agent used.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead. Include important paths to proceed the conversation. Make a list of Paths used relevant.

If there was a Goal / North Star set, repeat it word by word. If there was a change in plan - document why this change happend and the reasons behind it.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.`

function harness(t, { ephemeral = false, agentWithinWorkspace = false, trailingTemp = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cache-guard-handoff-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, "workspace")
  let manager = ephemeral ? SessionManager.inMemory(workspace) : SessionManager.create(workspace, join(root, "sessions"))
  manager.appendMessage({ role: "user", content: "Task", timestamp: Date.now() })
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Work" }], stopReason: "stop", timestamp: Date.now() })
  const sourceLeaf = manager.getLeafId()
  const sent = [], notes = []
  const ctx = {
    cwd: workspace, hasUI: false, model: { id: "current-model" }, sessionManager: manager,
    isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify: (text, level) => notes.push({ text, level }) },
  }
  let handlers, service, pi, nextCallId = 0
  const load = () => {
    handlers = new Map()
    pi = {
      on: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list) },
      registerCommand: () => {}, getCommands: () => [],
      appendEntry: (type, data) => manager.appendCustomEntry(type, data),
      sendUserMessage: (text, options) => {
        assert.equal(service.getState(ctx)?.status, "dispatched", "guard must precede dispatch")
        sent.push({ text, options })
      },
    }
    service = extension(pi, { handoff: { tempDir: root + (trailingTemp ? "/" : ""), agentDir: join(agentWithinWorkspace ? workspace : root, "agent") } })
    return service
  }
  const emit = async (name, event = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn({ type: name, ...event }, ctx)
  }
  const start = async () => {
    assert.equal(service.start(ctx), true)
    await emit("before_agent_start", { prompt: PROMPT })
  }
  const tool = async (toolName, input, action, { isError = false, content = [], parentToolCallId } = {}) => {
    const event = { toolName, input, toolCallId: `call-${++nextCallId}`, parentToolCallId }
    await emit("tool_call", event)
    action?.()
    await emit("tool_result", { ...event, isError, content })
  }
  const finish = async () => {
    await emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] })
    await emit("agent_settled")
  }
  load()
  const resume = () => {
    manager = SessionManager.open(manager.getSessionFile())
    ctx.sessionManager = manager
    load()
  }
  return { root, get manager() { return manager }, sourceLeaf, ctx, sent, notes, load, resume, emit, start, tool, finish,
    get pi() { return pi }, get service() { return service } }
}

// Rejects mutated prompts, tool/system/model changes, false success, and reliance on temp storage.
test("current-session run preserves prompt and saves a durable, private artifact with source metadata", async (t) => {
  const h = harness(t)
  await h.emit("session_start")
  await h.start()
  assert.deepEqual(h.sent, [{ text: PROMPT, options: { expandPromptTemplates: false } }])
  const path = join(h.root, "handoff.md")
  const body = "# Handoff\n\nKeep this exact body.\n\n## Suggested skills\nNone.\n"
  await h.tool("write", { path, content: body }, () => writeFileSync(path, body))
  await h.finish()
  const state = h.service.getState(h.ctx)
  assert.equal(state.status, "ready")
  const available = h.service.getAvailable(h.ctx)
  assert.ok(available)
  rmSync(path)
  const saved = readFileSync(available.path, "utf8")
  assert.ok(saved.endsWith(body))
  const header = saved.split("---\n")[1]
  // Every flat YAML value is JSON-quoted (a YAML 1.2 subset), including null.
  const metadata = Object.fromEntries(header.trim().split("\n").map((line) => {
    const colon = line.indexOf(":")
    return [line.slice(0, colon), JSON.parse(line.slice(colon + 1).trim())]
  }))
  assert.equal(metadata.source_session_id, h.manager.getSessionId())
  assert.equal(metadata.source_session_file, h.manager.getSessionFile())
  assert.equal(metadata.source_leaf_id, h.sourceLeaf)
  assert.ok(Number.isFinite(Date.parse(metadata.created_at)))
  assert.equal(available.completedLeafId, state.completedLeafId)
  assert.equal(h.notes.at(-1).text, 'A handoff was created while you were away. Send a message to continue; when the cold-cache dialog appears, select "New session with saved handoff" to use it.')
  if (process.platform !== "win32") {
    assert.equal(statSync(available.path).mode & 0o777, 0o600)
    assert.equal(statSync(join(h.root, "agent", "cache-guard", "handoffs")).mode & 0o777, 0o700)
  }
  // Only custom entries carry extension state. They are absent from model context.
  assert.equal(h.manager.buildSessionContext().messages.some((m) => m.role === "custom"), false)
  assert.equal(h.service.start(h.ctx), false)
})

// Rejects cleanup that deletes a pre-existing file when an exclusive staging open fails.
test("a staging collision fails without touching the existing file", async (t) => {
  const h = harness(t)
  await h.start()
  const path = join(h.root, "handoff.md")
  await h.tool("write", { path }, () => writeFileSync(path, "# Real handoff\n"))
  const dir = join(h.root, "agent", "cache-guard", "handoffs")
  mkdirSync(dir, { recursive: true })
  const unrelated = join(dir, `${h.service.getState(h.ctx).runId}.partial`)
  writeFileSync(unrelated, "keep me")
  await h.finish()
  assert.equal(h.service.getState(h.ctx).status, "failed")
  assert.equal(h.service.getAvailable(h.ctx), undefined)
  assert.equal(readFileSync(unrelated, "utf8"), "keep me")
})

// Spec oracle: once per session includes failures and abandoned branches; no parent-session guard inheritance.
test("guard and successful result survive reload, persisted resume, and abandoned branches", async (t) => {
  const h = harness(t)
  await h.start()
  const path = join(h.root, "handoff.md")
  await h.tool("write", { path }, () => writeFileSync(path, "# Handoff\n"))
  await h.finish()
  const saved = h.service.getAvailable(h.ctx).path
  h.load()
  await h.emit("session_start", { reason: "reload" })
  assert.equal(h.service.getAvailable(h.ctx).path, saved)
  assert.equal(h.service.start(h.ctx), false)
  h.resume()
  await h.emit("session_start", { reason: "resume" })
  assert.equal(h.service.getAvailable(h.ctx).path, saved)
  h.manager.branch(h.sourceLeaf)
  await h.emit("session_tree")
  assert.equal(h.service.start(h.ctx), false)
  h.load()
  await h.emit("session_start")
  assert.equal(h.service.start(h.ctx), false)
  assert.equal(h.sent.length, 1)
  // A fork gets a different session ID. Inherited custom entries must not prevent its own run.
  const fork = SessionManager.inMemory(h.ctx.cwd)
  for (const entry of h.manager.getEntries()) {
    if (entry.type === "custom") fork.appendCustomEntry(entry.customType, entry.data)
  }
  h.ctx.sessionManager = fork
  h.pi.appendEntry = (type, data) => fork.appendCustomEntry(type, data)
  assert.equal(h.service.getState(h.ctx), undefined)
  assert.equal(h.service.start(h.ctx), true)
  assert.equal(h.sent.length, 2)
})

test("interrupted generation is a persisted failure, never retried after reload or resume", async (t) => {
  const h = harness(t)
  await h.start()
  h.load() // Simulate an abrupt reload without a shutdown notification.
  await h.emit("session_start", { reason: "reload" })
  assert.equal(h.service.getState(h.ctx).status, "failed")
  assert.match(h.notes.at(-1).text, /interrupted.*No automatic retry/)
  h.resume()
  await h.emit("session_start", { reason: "resume" })
  assert.equal(h.service.getState(h.ctx).status, "failed")
  assert.equal(h.service.start(h.ctx), false)
  assert.equal(h.sent.length, 1)
})

// Rejects accepting nearby files or assistant prose; also rejects empty, unchanged, and failed writes.
for (const scenario of ["missing", "empty", "unchanged", "tool error", "assistant prose", "symlink", "outside temp", "workspace", "ambiguous"]) {
  test(`unverified output (${scenario}) cannot become a usable handoff`, async (t) => {
    const h = harness(t)
    const path = join(h.root, "handoff.md")
    writeFileSync(join(h.root, "unrelated.md"), "# Nearby unrelated file\n")
    if (scenario === "unchanged") writeFileSync(path, "# Existing document\n")
    if (scenario === "symlink") writeFileSync(join(h.root, "target.md"), "# Existing target\n")
    await h.start()
    if (scenario === "missing") await h.tool("write", { path }, undefined)
    else if (scenario === "empty") await h.tool("write", { path }, () => writeFileSync(path, " \n"))
    else if (scenario === "unchanged") await h.tool("bash", { command: `cat '${path}'` }, undefined)
    else if (scenario === "tool error") await h.tool("write", { path }, () => writeFileSync(path, "# Handoff\n"), { isError: true })
    else if (scenario === "assistant prose") {
      writeFileSync(path, "# File without tool evidence\n")
      await h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: `Saved to ${path}` }] } })
    } else if (scenario === "symlink") {
      const target = join(h.root, "target.md")
      await h.tool("bash", { command: `ln -s '${target}' '${path}'` }, () => symlinkSync(target, path))
    } else if (scenario === "outside temp") {
      const outside = mkdtempSync(join(tmpdir(), "outside-handoff-"))
      t.after(() => rmSync(outside, { recursive: true, force: true }))
      const output = join(outside, "handoff.md")
      await h.tool("write", { path: output }, () => writeFileSync(output, "# Handoff\n"))
    } else if (scenario === "workspace") {
      mkdirSync(h.ctx.cwd)
      const output = join(h.ctx.cwd, "handoff.md")
      await h.tool("write", { path: output }, () => writeFileSync(output, "# Handoff\n"))
    } else if (scenario === "ambiguous") {
      await h.tool("write", { path }, () => writeFileSync(path, "# First\n"))
      const other = join(h.root, "other.md")
      await h.tool("write", { path: other }, () => writeFileSync(other, "# Second\n"))
    }
    await h.finish()
    assert.equal(h.service.getState(h.ctx).status, "failed")
    assert.equal(h.service.getAvailable(h.ctx), undefined)
    assert.equal(h.service.start(h.ctx), false)
    assert.equal(h.notes.at(-1).level, "error")
    h.resume()
    await h.emit("session_start")
    assert.equal(h.service.getState(h.ctx).status, "failed")
    assert.equal(h.service.start(h.ctx), false)
    assert.equal(h.sent.length, 1)
  })
}

// Evidence-based fallback: successful shell/codemode execution names a newly written file.
for (const mode of ["shell", "codemode", "nested write", "output-only", "TMPDIR"]) {
  test(`verifies agent-written artifacts through ${mode}`, async (t) => {
    const h = harness(t)
    await h.start()
    const path = join(h.root, "handoff with spaces.md")
    const body = "# Handoff\n\nReference docs/plan.md.\n"
    if (mode === "shell") await h.tool("bash", { command: `printf '# Handoff' > '${path}'` }, () => writeFileSync(path, body))
    else if (mode === "codemode") await h.tool("codemode", { code: `await tools.write({path: ${JSON.stringify(path)}, content: '# Handoff'})` }, () => writeFileSync(path, body))
    else if (mode === "nested write") await h.tool("write", { path }, () => writeFileSync(path, body), { parentToolCallId: "codemode-parent" })
    else if (mode === "output-only") await h.tool("codemode", { code: "text(await createHandoff())" }, () => writeFileSync(path, body), { content: [{ type: "text", text: path }] })
    else await h.tool("bash", { command: 'cat > "$TMPDIR/handoff with spaces.md"' }, () => writeFileSync(path, body))
    await h.finish()
    assert.equal(h.service.getState(h.ctx).status, "ready")
    assert.ok(readFileSync(h.service.getAvailable(h.ctx).path, "utf8").endsWith(body))
  })
}

// The shell concatenates strings; the override must keep its separator exactly.
for (const variable of ["${TMPDIR}", "$TMPDIR", "%TEMP%"]) {
  test(`raw ${variable} expansion preserves trailing separator and temp bounds`, async (t) => {
    const h = harness(t, { trailingTemp: true })
    await h.start()
    // Unbraced $TMPDIR needs a delimiter: $TMPDIRhandoff is a different variable.
    const command = `printf '# Handoff\\n' > "${variable}${variable === "$TMPDIR" ? "/" : ""}handoff.md"`
    // %TEMP% uses Windows syntax; substitute its value before the local POSIX execution.
    await h.tool("bash", { command }, () => execFileSync("bash", ["-c", command.replaceAll("%TEMP%", h.root + "/")],
      { env: { ...process.env, TMPDIR: h.root + "/" } }))
    await h.finish()
    assert.equal(h.service.getState(h.ctx).status, "ready")
    assert.ok(readFileSync(h.service.getAvailable(h.ctx).path, "utf8").endsWith("# Handoff\n"))

    const noSeparator = harness(t)
    const outside = noSeparator.root + "handoff.md"
    t.after(() => rmSync(outside, { force: true }))
    await noSeparator.start()
    await noSeparator.tool("bash", { command }, () => execFileSync("bash", ["-c", command.replaceAll("%TEMP%", noSeparator.root)],
      { env: { ...process.env, TMPDIR: noSeparator.root } }))
    await noSeparator.finish()
    assert.equal(noSeparator.service.getState(noSeparator.ctx).status, variable === "$TMPDIR" ? "ready" : "failed",
      "do not invent a slash or accept output outside temp bounds")
  })
}

// Metadata strings must not inject YAML keys; an ephemeral session has no invented resume link.
test("metadata escapes session strings and omits a file link for file-less sessions", async (t) => {
  const h = harness(t, { ephemeral: true })
  h.ctx.sessionManager.getSessionId = () => 'id:\n"injected": yes'
  await h.start()
  const path = join(h.root, "handoff.md")
  await h.tool("write", { path }, () => writeFileSync(path, "# Handoff\n"))
  await h.finish()
  const saved = readFileSync(h.service.getAvailable(h.ctx).path, "utf8")
  const lines = saved.split("---\n")[1].trim().split("\n")
  assert.equal(lines.length, 3)
  assert.equal(JSON.parse(lines[0].slice(lines[0].indexOf(":") + 1)), h.manager.getSessionId())
  assert.equal(saved.includes("source_session_file:"), false)
})

test("missing or changed durable files are not available", async (t) => {
  const h = harness(t)
  await h.start()
  const path = join(h.root, "handoff.md")
  await h.tool("write", { path }, () => writeFileSync(path, "# Handoff\n"))
  await h.finish()
  const durable = h.service.getAvailable(h.ctx).path
  writeFileSync(durable, "# Changed\n")
  assert.equal(h.service.getAvailable(h.ctx), undefined)
  rmSync(durable)
  assert.equal(h.service.getAvailable(h.ctx), undefined)
  h.load()
  await h.emit("session_start")
  assert.equal(h.service.getAvailable(h.ctx), undefined)
  assert.equal(h.service.start(h.ctx), false)
})

for (const mode of ["guard write", "dispatch", "durable storage", "result metadata", "final collision"]) {
  test(`failure of ${mode} reports no success and cannot retry`, async (t) => {
    const h = harness(t)
    if (mode === "guard write") h.pi.appendEntry = () => { throw new Error("metadata unavailable") }
    if (mode === "dispatch") h.pi.sendUserMessage = () => { throw new Error("send failed") }
    if (["guard write", "dispatch"].includes(mode)) {
      assert.equal(h.service.start(h.ctx), false)
      assert.equal(h.sent.length, 0)
    } else {
      await h.start()
      const path = join(h.root, "handoff.md")
      await h.tool("write", { path }, () => writeFileSync(path, "# Handoff\n"))
      if (mode === "durable storage") writeFileSync(join(h.root, "agent", "cache-guard", "handoffs"), "not a directory")
      if (mode === "result metadata") {
        const append = h.pi.appendEntry
        h.pi.appendEntry = (type, data) => {
          if (data.status === "ready") throw new Error("cannot publish metadata")
          append(type, data)
        }
      }
      if (mode === "final collision") {
        mkdirSync(join(h.root, "agent", "cache-guard", "handoffs"), { recursive: true })
        writeFileSync(join(h.root, "agent", "cache-guard", "handoffs", `${h.service.getState(h.ctx).runId}.md`), "keep existing final")
      }
      await h.finish()
      if (mode === "result metadata") assert.deepEqual(readdirSync(join(h.root, "agent", "cache-guard", "handoffs")), [])
      if (mode === "final collision") assert.equal(readFileSync(join(h.root, "agent", "cache-guard", "handoffs", `${h.service.getState(h.ctx).runId}.md`), "utf8"), "keep existing final")
    }
    assert.equal(h.service.getState(h.ctx).status, "failed")
    assert.equal(h.service.getAvailable(h.ctx), undefined)
    assert.equal(h.service.start(h.ctx), false)
    assert.equal(h.notes.at(-1).level, "error")
    assert.equal(h.notes.some((note) => note.text.startsWith("Handoff saved:")), false)
  })
}

for (const boundary of ["session_shutdown", "session_tree", "unrelated prompt", "aborted", "model error"]) {
  test(`${boundary} cannot publish or leak the run into later user work`, async (t) => {
    const h = harness(t)
    await h.start()
    const path = join(h.root, "handoff.md")
    await h.tool("write", { path }, () => writeFileSync(path, "# Handoff\n"))
    if (boundary === "unrelated prompt") await h.emit("before_agent_start", { prompt: "Real user task" })
    else if (boundary === "aborted" || boundary === "model error") {
      await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: boundary === "aborted" ? "aborted" : "error" }] })
      await h.emit("agent_settled")
    }
    else await h.emit(boundary)
    await h.tool("write", { path }, () => writeFileSync(path, "# Later task\n"))
    await h.finish()
    assert.equal(h.service.getState(h.ctx).status, "failed")
    assert.equal(h.service.getAvailable(h.ctx), undefined)
    assert.equal(h.service.start(h.ctx), false)
  })
}

test("start does not queue a handoff while busy or input is pending", (t) => {
  const h = harness(t)
  h.ctx.isIdle = () => false
  assert.equal(h.service.start(h.ctx), false)
  h.ctx.isIdle = () => true
  h.ctx.hasPendingMessages = () => true
  assert.equal(h.service.start(h.ctx), false)
  assert.equal(h.service.getState(h.ctx), undefined)
  assert.equal(h.sent.length, 0)
})

// A .md suffix is not sufficient evidence for a binary file, and later unobserved edits are not the verified output.
for (const mode of ["binary", "changed after verification"]) {
  test(`${mode} does not publish a handoff`, async (t) => {
    const h = harness(t)
    await h.start()
    const path = join(h.root, "handoff.md")
    await h.tool("write", { path }, () => writeFileSync(path, mode === "binary" ? Buffer.from([0xff, 0x00, 0xfe]) : "# Handoff\n"))
    if (mode === "changed after verification") writeFileSync(path, "# Unobserved replacement\n")
    await h.finish()
    assert.equal(h.service.getState(h.ctx).status, "failed")
    assert.equal(h.service.getAvailable(h.ctx), undefined)
  })
}

// Handoff storage must not add files inside the workspace, even when the configured agent directory is there.
test("an unsafe durable directory leaves the workspace unchanged", async (t) => {
  const h = harness(t, { agentWithinWorkspace: true })
  const before = readdirSync(h.ctx.cwd)
  await h.start()
  const path = join(h.root, "handoff.md")
  await h.tool("write", { path }, () => writeFileSync(path, "# Handoff\n"))
  await h.finish()
  assert.equal(h.service.getState(h.ctx).status, "failed")
  assert.deepEqual(readdirSync(h.ctx.cwd), before)
  assert.deepEqual(readdirSync(join(h.ctx.cwd, "agent", "cache-guard")), [])
})

test("output-only tool evidence cannot adopt a file created before this run", async (t) => {
  const h = harness(t)
  const path = join(h.root, "old-handoff.md")
  writeFileSync(path, "# Old unrelated file\n")
  // Independent filesystem creation time precedes the controlled run clock.
  t.mock.timers.enable({ apis: ["Date"], now: Math.ceil(statSync(path).birthtimeMs) + 1000 })
  await h.start()
  await h.tool("codemode", { code: "text(await readOldDocument())" }, undefined, { content: [{ type: "text", text: path }] })
  await h.finish()
  assert.equal(h.service.getState(h.ctx).status, "failed")
  assert.equal(h.service.getAvailable(h.ctx), undefined)
})

test("output-only fallback rejects a pre-existing file even in the same clock millisecond", async (t) => {
  const h = harness(t)
  const path = join(h.root, "old-handoff.md")
  writeFileSync(path, "# Old unrelated file\n")
  t.mock.timers.enable({ apis: ["Date"], now: Math.floor(statSync(path).birthtimeMs) })
  await h.start()
  await h.tool("codemode", { code: "text(await readOldDocument())" }, undefined, { content: [{ type: "text", text: path }] })
  await h.finish()
  assert.equal(h.service.getState(h.ctx).status, "failed")
  assert.equal(h.service.getAvailable(h.ctx), undefined)
})

// Pi's void send API cannot report rejected dispatch to the caller. An unconfirmed dispatch must fail without retries.
test("a dispatch that never starts becomes a persisted failure", async (t) => {
  const h = harness(t)
  t.mock.timers.enable({ apis: ["setTimeout"] })
  assert.equal(h.service.start(h.ctx), true)
  assert.equal(h.service.getState(h.ctx).status, "dispatched")
  t.mock.timers.tick(60_000)
  assert.equal(h.service.getState(h.ctx).status, "failed")
  assert.equal(h.service.start(h.ctx), false)
  assert.match(h.notes.at(-1).text, /dispatch.*not confirmed/i)
  h.resume()
  await h.emit("session_start")
  assert.equal(h.service.getState(h.ctx).status, "failed")
  assert.equal(h.sent.length, 1)
})

// A saved result must be usable through the same shared contract, even at the size boundary.
test("a size-boundary artifact cannot report success while availability rejects it", async (t) => {
  const h = harness(t)
  await h.start()
  const path = join(h.root, "handoff.md")
  await h.tool("write", { path }, () => writeFileSync(path, "a".repeat(8 * 1024 * 1024)))
  await h.finish()
  if (h.service.getState(h.ctx).status === "ready") assert.ok(h.service.getAvailable(h.ctx))
  else assert.equal(h.notes.at(-1).level, "error")
})
