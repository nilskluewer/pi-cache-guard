import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { createHash } from "node:crypto"
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { migrateCacheGuardStorage } from "../extensions/cache-storage.ts"
import { createHandoffService } from "../extensions/handoff.ts"

// Oracle: user-approved storage layout and migration guarantees, not current output.
// Claim                     | Plausible error                | Pass criterion
// Fresh Pi migrates state   | helper never called at startup | real CLI loads command; all old state moves byte-for-byte
// No overwrite              | rename replaces new settings   | current state unchanged; legacy bytes in private backup
// Retry after interruption  | link/unlink or alias gap loses data | next start completes; old artifact path stays readable
// Own files only            | generic handoffs adopted       | mixed/unowned handoffs and other extension files unchanged
// Private state             | moved files retain public mode | directory 0700, settings/telemetry 0600 on POSIX
// Concurrent starts         | other process steals lock      | held lock refuses migration and is not removed
// Scope: local filesystem + actual Pi RPC startup, no model calls or live agent state.

const runId = "12345678-1234-4234-8234-123456789abc"
const handoffBody = '---\nsource_session_id: "old-session"\nsource_leaf_id: null\ncreated_at: "2026-01-01T00:00:00.000Z"\n---\n# Keep this handoff\n'
const files = [
  ["cache-guard.json", "settings.json", '{"budgetUsd":0.42,"autoHandoff":false,"placement":"off"}\n'],
  ["cache-guard-estimates.json", "estimates.json", JSON.stringify({ v: 1, salt: "a".repeat(64), estimates: [] }) + "\n"],
  ["cache-guard-observations.jsonl", "observations.jsonl", '{"fixture":"latest"}\n'],
  ["cache-guard-observations.jsonl.1", "observations.jsonl.1", '{"fixture":"rotated"}\n'],
]
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "cache-guard-storage-"))
  const agentDir = join(root, "agent"), dir = join(agentDir, "cache-guard")
  mkdirSync(agentDir)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, agentDir, dir }
}
function seed(h) {
  for (const [oldName, , contents] of files) writeFileSync(join(h.agentDir, oldName), contents)
  mkdirSync(join(h.agentDir, "cache-guard-drafts"))
  writeFileSync(join(h.agentDir, "cache-guard-drafts", "saved.json"), '{"pending":{"text":"keep request","images":[{"data":"keep image"}]}}\n')
  mkdirSync(join(h.agentDir, "handoffs"))
  writeFileSync(join(h.agentDir, "handoffs", `${runId}.md`), handoffBody)
  writeFileSync(join(h.agentDir, "other-extension.json"), "not ours")
}
function assertMigrated(h) {
  for (const [oldName, newName, contents] of files) {
    assert.equal(existsSync(join(h.agentDir, oldName)), false, `${oldName} must not stay at agent root`)
    assert.equal(readFileSync(join(h.dir, newName), "utf8"), contents)
    if (process.platform !== "win32") assert.equal(statSync(join(h.dir, newName)).mode & 0o777, 0o600)
  }
  assert.equal(existsSync(join(h.agentDir, "cache-guard-drafts")), false)
  assert.match(readFileSync(join(h.dir, "drafts", "saved.json"), "utf8"), /keep image/)
  assert.equal(readFileSync(join(h.dir, "handoffs", `${runId}.md`), "utf8"), handoffBody)
  assert.equal(readFileSync(join(h.agentDir, "handoffs", `${runId}.md`), "utf8"), handoffBody, "saved absolute paths must keep working")
  assert.equal(lstatSync(join(h.agentDir, "handoffs")).isSymbolicLink(), true)
  assert.equal(readFileSync(join(h.agentDir, "other-extension.json"), "utf8"), "not ours")
  assert.equal(existsSync(join(h.dir, ".migration.lock")), false)
  if (process.platform !== "win32") assert.equal(statSync(h.dir).mode & 0o777, 0o700)
}

test("migration gathers state, preserves saved artifact paths and is repeatable", t => {
  const h = fixture(t); seed(h)
  assert.equal(migrateCacheGuardStorage(h.agentDir), h.dir)
  assertMigrated(h)
  migrateCacheGuardStorage(h.agentDir)
  assertMigrated(h)
  const pi = { on() {} }
  const artifact = { path: join(h.agentDir, "handoffs", `${runId}.md`), sha256: createHash("sha256").update(handoffBody).digest("hex") }
  const state = { version: 1, runId, source: { sessionId: "old-session" }, status: "ready", artifact }
  const service = createHandoffService(pi, { agentDir: h.agentDir })
  assert.equal(service.getAvailable({ cwd: join(h.root, "workspace"), sessionManager: {
    getSessionId: () => "old-session", getEntries: () => [{ type: "custom", customType: "cache-guard.handoff", data: state }],
  } }), artifact, "real handoff validator must accept the preserved old path")
})

test("fresh installation creates only its namespaced storage, without a legacy link", t => {
  const h = fixture(t)
  migrateCacheGuardStorage(h.agentDir)
  assert.deepEqual(readdirSync(h.agentDir), ["cache-guard"])
  assert.deepEqual(readdirSync(h.dir), [])
})

test("conflicting settings are gathered into a private backup without overwriting current settings", t => {
  const h = fixture(t)
  mkdirSync(h.dir)
  writeFileSync(join(h.agentDir, "cache-guard.json"), "old settings")
  writeFileSync(join(h.dir, "settings.json"), "new settings")
  const backups = []
  migrateCacheGuardStorage(h.agentDir, path => backups.push(path))
  assert.equal(backups.length, 1)
  assert.equal(readFileSync(join(backups[0], "cache-guard.json"), "utf8"), "old settings")
  assert.equal(existsSync(join(h.agentDir, "cache-guard.json")), false)
  assert.equal(readFileSync(join(h.dir, "settings.json"), "utf8"), "new settings")
  if (process.platform !== "win32") {
    assert.equal(statSync(backups[0]).mode & 0o777, 0o700)
    assert.equal(statSync(join(backups[0], "cache-guard.json")).mode & 0o777, 0o600)
  }
  assert.equal(existsSync(join(h.dir, ".migration.lock")), false)
})

for (const [currentName, oldName] of [
  ["estimates.json", "cache-guard-observations.jsonl"],
  ["observations.jsonl", "cache-guard-estimates.json"],
]) test(`incomplete generations never mix ${currentName} with incoming ${oldName}`, t => {
  const h = fixture(t)
  mkdirSync(h.dir)
  writeFileSync(join(h.dir, currentName), "current salt domain")
  writeFileSync(join(h.agentDir, oldName), "legacy salt domain")
  const backups = []
  migrateCacheGuardStorage(h.agentDir, path => backups.push(path))
  const newName = files.find(([name]) => name === oldName)[1]
  assert.equal(existsSync(join(h.dir, newName)), false, "other generation must not be added to active telemetry")
  assert.equal(readFileSync(join(h.dir, currentName), "utf8"), "current salt domain")
  assert.equal(readFileSync(join(backups[0], oldName), "utf8"), "legacy salt domain")
})

test("collects prefixed files left inside the namespace by an intermediate version", t => {
  const h = fixture(t)
  mkdirSync(h.dir)
  writeFileSync(join(h.dir, "estimates.json"), "current salt")
  writeFileSync(join(h.dir, "cache-guard-estimates.json"), "old salt")
  writeFileSync(join(h.dir, "cache-guard-observations.jsonl"), "old observations")
  const backups = []
  migrateCacheGuardStorage(h.agentDir, path => backups.push(path))
  assert.equal(readFileSync(join(h.dir, "estimates.json"), "utf8"), "current salt")
  assert.equal(readFileSync(join(backups[0], "cache-guard-estimates.json"), "utf8"), "old salt")
  assert.equal(readFileSync(join(backups[0], "cache-guard-observations.jsonl"), "utf8"), "old observations")
  assert.equal(existsSync(join(h.dir, "cache-guard-estimates.json")), false)
  assert.equal(existsSync(join(h.dir, "cache-guard-observations.jsonl")), false)
})

test("an interrupted archive move is retryable without unsafe hardlinks or lost bytes", t => {
  const h = fixture(t)
  mkdirSync(h.dir)
  for (const [oldName, name, contents] of files) {
    writeFileSync(join(h.agentDir, oldName), contents)
    writeFileSync(join(h.dir, name), "keep current")
  }
  const rename = fs.renameSync
  const fault = t.mock.method(fs, "renameSync", (source, target) => {
    for (const root of [h.agentDir, h.dir]) {
      assert.throws(() => fs.openSync(join(root, "cache-guard-observations.lock"), "wx"), { code: "EEXIST" }, "legacy writers must be locked out during the move")
    }
    rename(source, target)
    if (target.includes(join("legacy", "import-"))) throw new Error("injected interruption after archive rename")
  })
  syncBuiltinESMExports()
  try { assert.throws(() => migrateCacheGuardStorage(h.agentDir), /injected interruption/) }
  finally { fault.mock.restore(); syncBuiltinESMExports() }
  migrateCacheGuardStorage(h.agentDir)
  const backups = readdirSync(join(h.dir, "legacy")).map(name => join(h.dir, "legacy", name))
  for (const [oldName, name, contents] of files) {
    assert.equal(readFileSync(join(h.dir, name), "utf8"), "keep current")
    const archived = backups.map(path => join(path, oldName)).find(existsSync)
    assert.equal(readFileSync(archived, "utf8"), contents)
    assert.equal(statSync(archived).nlink, 1)
    assert.equal(existsSync(join(h.agentDir, oldName)), false)
  }
})

test("migration completes an interrupted exclusive file move", t => {
  const h = fixture(t)
  mkdirSync(h.dir)
  const old = join(h.agentDir, "cache-guard.json"), next = join(h.dir, "settings.json")
  writeFileSync(old, "keep bytes")
  linkSync(old, next) // Crash immediately after link, before unlink.
  migrateCacheGuardStorage(h.agentDir)
  assert.equal(existsSync(old), false)
  assert.equal(readFileSync(next, "utf8"), "keep bytes")
  assert.equal(statSync(next).nlink, 1)
})

test("migration recreates the legacy alias after an interrupted directory move", t => {
  const h = fixture(t); seed(h)
  mkdirSync(h.dir)
  writeFileSync(join(h.dir, ".legacy-handoffs"), "")
  renameSync(join(h.agentDir, "handoffs"), join(h.dir, "handoffs"))
  migrateCacheGuardStorage(h.agentDir)
  assertMigrated(h)
})

test("mixed legacy handoffs are not moved or deleted", t => {
  const h = fixture(t); seed(h)
  writeFileSync(join(h.agentDir, "handoffs", "another-extension.md"), "unrelated document")
  migrateCacheGuardStorage(h.agentDir)
  assert.equal(lstatSync(join(h.agentDir, "handoffs")).isDirectory(), true)
  assert.equal(readFileSync(join(h.agentDir, "handoffs", `${runId}.md`), "utf8"), handoffBody)
  assert.equal(readFileSync(join(h.agentDir, "handoffs", "another-extension.md"), "utf8"), "unrelated document")
  assert.equal(existsSync(join(h.dir, "handoffs")), false)
})

for (const lock of ["migration", "legacy writer", "intermediate writer"]) test(`${lock} lock blocks migration without stealing it`, t => {
  const h = fixture(t); seed(h)
  mkdirSync(h.dir)
  const path = lock === "migration" ? join(h.dir, ".migration.lock") : join(lock === "legacy writer" ? h.agentDir : h.dir, "cache-guard-observations.lock")
  writeFileSync(path, "held")
  assert.throws(() => migrateCacheGuardStorage(h.agentDir), /migration failed/)
  assert.equal(readFileSync(path, "utf8"), "held")
  assert.equal(readFileSync(join(h.agentDir, "cache-guard.json"), "utf8"), files[0][2])
  rmSync(path)
  migrateCacheGuardStorage(h.agentDir)
  assertMigrated(h)
})

for (const target of ["namespace", "settings", "legacy settings"]) test(`refuses symlink ${target} without changing its target`, t => {
  const h = fixture(t)
  const outside = join(h.root, "outside")
  if (target === "namespace") {
    mkdirSync(outside)
    symlinkSync(outside, h.dir, "dir")
  } else {
    writeFileSync(outside, "never change me")
    mkdirSync(h.dir)
    if (target === "settings") writeFileSync(join(h.agentDir, "cache-guard.json"), "old")
    symlinkSync(outside, target === "settings" ? join(h.dir, "settings.json") : join(h.agentDir, "cache-guard.json"))
  }
  assert.throws(() => migrateCacheGuardStorage(h.agentDir))
  if (target === "namespace") assert.deepEqual(readdirSync(outside), [])
  else assert.equal(readFileSync(outside, "utf8"), "never change me")
})

test("fresh Pi CLI preserves current state and archives conflicting legacy state instead of failing to load", { timeout: 30000 }, async t => {
  const h = fixture(t); seed(h)
  mkdirSync(h.dir)
  for (const [, name] of files) writeFileSync(join(h.dir, name), `current ${name}\n`)
  await startPi(h)
  for (const [oldName, name, contents] of files) {
    assert.equal(readFileSync(join(h.dir, name), "utf8"), `current ${name}\n`, "current files must not be overwritten")
    assert.equal(existsSync(join(h.agentDir, oldName)), false, "old root files must be gathered")
    const snapshots = readdirSync(join(h.dir, "legacy"))
    assert.ok(snapshots.some(snapshot => readFileSync(join(h.dir, "legacy", snapshot, oldName), "utf8") === contents), "legacy bytes must be preserved in a private snapshot")
  }
  await startPi(h)
  assert.equal(readdirSync(join(h.dir, "legacy")).length, 1, "restart must not create another backup without new legacy files")
})

/** A new OS process with the same CLI flags as the tarball smoke test. */
async function startPi(h, extension = resolve("extensions/cache-guard.ts")) {
  const args = ["--mode", "rpc", "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", extension]
  const child = spawn("pi", args, { cwd: h.root, env: { ...process.env, PI_CODING_AGENT_DIR: h.agentDir }, stdio: ["pipe", "pipe", "pipe"] })
  let output = "", buffer = "", timer
  try {
    const reply = await new Promise((ok, fail) => {
      timer = setTimeout(() => fail(new Error(`Pi startup timed out: ${output}`)), 15000)
      child.on("error", fail)
      child.on("exit", code => fail(new Error(`Pi exited ${code}: ${output}`)))
      child.stderr.on("data", chunk => { output += chunk })
      child.stdout.on("data", chunk => {
        output += chunk; buffer += chunk
        while (buffer.includes("\n")) {
          const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          let message
          try { message = JSON.parse(line) } catch { continue }
          if (message.id === "storage-check" && message.type === "response") ok(message)
        }
      })
      child.stdin.on("error", fail)
      child.stdin.write(JSON.stringify({ id: "storage-check", type: "get_commands" }) + "\n")
    })
    assert.equal(reply.success, true, output)
    assert.ok(reply.data.commands.some(command => command.name === "cache-guard"), `extension must load, not just Pi itself: ${output}`)
  } finally {
    clearTimeout(timer)
    child.kill()
    if (child.exitCode === null && child.signalCode === null) await new Promise(ok => child.once("exit", ok))
  }
}

test("fresh Pi CLI startup migrates old files, preserves handoff links, and restarts cleanly", { timeout: 30000 }, async t => {
  const h = fixture(t); seed(h)
  await startPi(h)
  assertMigrated(h)
  await startPi(h)
  assertMigrated(h)
})
