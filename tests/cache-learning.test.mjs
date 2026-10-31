import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, rmSync, realpathSync, readFileSync, writeFileSync, statSync, chmodSync, symlinkSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CacheLearner, OBSERVATION_RETENTION_MS, getSeedEstimate, isSupportedCacheModel } from "../extensions/cache-learning.ts"

const M = 60_000
const model = (id = "gpt-6-luna", api = "openai-responses") => ({ provider: "github-copilot", id, api })
const claude = model("claude-sonnet-5.5", "anthropic-messages")
const payload = (tail = [], extra = {}) => ({ tools: [{ name: "tool", description: "PRIVATE TOOL" }], instructions: "PRIVATE SYSTEM", input: [{ role: "user", content: "PRIVATE PROMPT" }, ...tail], ...extra })
const append = [{ role: "assistant", content: "PRIVATE ANSWER" }, { role: "user", content: "new tail" }]
function fixture(t) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "cache-learning-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, learner: new CacheLearner(dir) }
}
function event(m, read, write) {
  const usage = m.api === "anthropic-messages"
    ? { ...(read !== undefined ? { cache_read_input_tokens: read } : {}), ...(write !== undefined ? { cache_creation_input_tokens: write } : {}) }
    : m.api === "openai-completions"
      ? { prompt_tokens_details: { ...(read !== undefined ? { cached_tokens: read } : {}), ...(write !== undefined ? { cache_write_tokens: write } : {}) } }
      : { input_tokens_details: { ...(read !== undefined ? { cached_tokens: read } : {}), ...(write !== undefined ? { cache_write_tokens: write } : {}) } }
  return m.api === "anthropic-messages"
    ? { type: "message_start", message: { usage } }
    : m.api === "openai-completions"
      ? { usage }
      : { response: { usage } }
}
function finish(l, m, stopReason = "stop") {
  l.finish({ role: "assistant", provider: m.provider, model: m.id, api: m.api, timestamp: 999_999_999, stopReason,
    // Deliberately misleading normalized usage: it is not raw telemetry.
    usage: { cacheRead: 0, cacheWrite: 999_999 } })
}
function run(l, { m = model(), at = 0, read, write, p = payload(), retention = "short", stop = "stop" } = {}) {
  l.begin(p, m, retention, at)
  l.observe(m.api, event(m, read, write))
  finish(l, m, stop)
}
function records(dir) {
  return ["observations.jsonl.1", "observations.jsonl"].flatMap(name => {
    try { return readFileSync(join(dir, name), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) } catch { return [] }
  })
}

// Oracle: task allowlist and literal seed durations, not model catalog metadata.
test("exact route allowlist and provisional/family seed labels", () => {
  assert.deepEqual(getSeedEstimate(model("claude-opus-5.5", "anthropic-messages"), "short"), { ttlMs: 5 * M, source: "family" })
  assert.equal(getSeedEstimate(claude, "long").ttlMs, 60 * M)
  assert.equal(getSeedEstimate({ ...claude, compat: { supportsLongCacheRetention: false } }, "long").ttlMs, 5 * M)
  assert.equal(getSeedEstimate(model("claude-haiku-5.5", "anthropic-messages"), "short").source, "measured")
  assert.deepEqual(getSeedEstimate(model("gpt-6.1-sol"), "long"), { ttlMs: 30 * M, source: "measured" })
  assert.deepEqual(getSeedEstimate(model("gemini-4-argon", "openai-completions"), "short"), { ttlMs: 15 * M, source: "measured" })
  assert.deepEqual(getSeedEstimate(model("gemini-3.8-flash", "openai-completions"), "short"), { source: "unknown", variable: true })
  for (const m of [{ ...claude, provider: "anthropic" }, { ...claude, api: "openai-responses" }, { ...claude, id: "claude-sonnet-5.5-extra" }, model("toString")]) {
    assert.equal(isSupportedCacheModel(m), false)
    assert.deepEqual(getSeedEstimate({ ...m, promptCache: { short: 500 } }, "short"), { source: "unknown" })
  }
})

test("native subscription model IDs are exact, with family seeds rather than Copilot measurements", () => {
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
    const native = { provider: "anthropic", id, api: "anthropic-messages" }
    assert.equal(isSupportedCacheModel(native), true)
    assert.deepEqual(getSeedEstimate(native, "long"), { ttlMs: 60 * M, source: "family" })
  }
  const codex = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses" }
  assert.deepEqual(getSeedEstimate(codex, "long"), { ttlMs: 30 * M, source: "family" })
  assert.deepEqual(getSeedEstimate({ ...codex, id: "gpt-6-luna" }, "long"), { source: "unknown" })
  assert.equal(isSupportedCacheModel({ ...codex, api: "openai-responses" }), false)
  assert.equal(isSupportedCacheModel({ provider: "anthropic", id: "claude-sonnet-5.5", api: "anthropic-messages" }), false)
})

test("Copilot, Codex, and Anthropic observations remain isolated and survive reload", t => {
  const { learner: l, dir } = fixture(t)
  const copilot = model("gpt-6.1-sol")
  run(l, { m: copilot, read: 1000 })
  for (let i = 1; i <= 3; i++) run(l, { m: copilot, at: i * 36 * M, read: 1000 })
  assert.equal(l.estimate(copilot, "short").ttlMs, 40 * M)
  const codex = { provider: "openai-codex", id: "gpt-6.1-sol", api: "openai-codex-responses" }
  assert.deepEqual(l.estimate(codex, "short"), { ttlMs: 30 * M, source: "family" })
  run(l, { m: codex, at: 200 * M, read: 1000 })
  for (let i = 1; i <= 3; i++) run(l, { m: codex, at: (200 + i * 41) * M, read: 1000 })
  assert.equal(l.estimate(codex, "short").ttlMs, 45 * M)
  const anthropic = { provider: "anthropic", id: "claude-sonnet-5-5", api: "anthropic-messages" }
  assert.deepEqual(l.estimate(anthropic, "short"), { ttlMs: 5 * M, source: "family" })
  run(l, { m: anthropic, at: 400 * M, read: 1000 })
  for (let i = 1; i <= 3; i++) run(l, { m: anthropic, at: (400 + i * 6) * M, read: 1000 })
  const restored = new CacheLearner(dir)
  assert.equal(restored.estimate(copilot, "short").ttlMs, 40 * M)
  assert.equal(restored.estimate(codex, "short").ttlMs, 45 * M)
  assert.equal(restored.estimate(anthropic, "short").ttlMs, 10 * M)
  assert.deepEqual([...new Set(records(dir).map(r => r.provider))].sort(), ["anthropic", "github-copilot", "openai-codex"])
})

test("current epoch milliseconds are accepted and persisted", t => {
  const { learner: l, dir } = fixture(t)
  const at = Date.now()
  assert(at > 1e12)
  run(l, { at, read: 1000 })
  assert.equal(records(dir).length, 1)
  assert.equal(records(dir)[0].at, at)
})

test("independent sessions accumulate comparable evidence without logging affinity keys", t => {
  const { learner: l, dir } = fixture(t)
  for (let session = 0; session < 3; session++) {
    l.reset()
    const p = payload([], { prompt_cache_key: `PRIVATE SESSION KEY ${session}` })
    run(l, { at: session * 60 * M, read: 1000, p })
    run(l, { at: (session * 60 + 6) * M, read: 1000, p })
  }
  assert.equal(l.estimate(model(), "short").ttlMs, 10 * M)
  assert.equal(new Set(records(dir).map(r => r.profile)).size, 1)
  assert.doesNotMatch(JSON.stringify(records(dir)), /PRIVATE SESSION/)
  const restored = new CacheLearner(dir)
  assert.equal(restored.estimate(model(), "short").ttlMs, 10 * M)
  assert.equal(restored.estimate({ ...model(), baseUrl: "https://another.example" }, "short").ttlMs, undefined)
})

test("changing cache affinity invalidates the interval, not the model-level profile", t => {
  const { learner: l, dir } = fixture(t)
  run(l, { at: 0, read: 1000, p: payload([], { prompt_cache_key: "a" }) })
  run(l, { at: 6 * M, read: 1000, p: payload([], { prompt_cache_key: "b" }) })
  assert.equal(records(dir).at(-1).qualified, false)
  run(l, { at: 12 * M, read: 1000, p: payload([], { prompt_cache_key: "b" }) })
  assert.equal(records(dir).at(-1).qualified, true)
  assert.equal(new Set(records(dir).map(r => r.profile)).size, 1)
})

test("raw explicit zero is a miss; absent counters remain unknown, including normalized zero", t => {
  const { learner: l, dir } = fixture(t)
  run(l, { read: undefined })
  run(l, { at: M, read: 0 })
  run(l, { at: 2 * M, read: 1 })
  assert.deepEqual(records(dir).map(r => r.outcome), ["unknown", "miss", "hit"])
  assert.equal(records(dir)[0].qualified, false)
  assert.deepEqual(l.estimate(model(), "short"), { source: "unknown" })
})

test("Anthropic cumulative start/delta counters merge without double-summing", t => {
  const { learner: l, dir } = fixture(t)
  l.begin({ system: "x", messages: [{ role: "user", content: "a" }] }, claude, "short", 0)
  l.observe(claude.api, { type: "message_start", message: { usage: { cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } } })
  l.observe(claude.api, { type: "message_delta", usage: { cache_read_input_tokens: 100, output_tokens: 20 } })
  l.observe(claude.api, { type: "message_delta", usage: { output_tokens: 30 } })
  finish(l, claude)
  assert.equal(records(dir)[0].read, 100)
  assert.equal(records(dir)[0].write, 50)
})

test("OpenAI response and chat native usage, choices[0].usage and explicit zeros", t => {
  const { learner: l, dir } = fixture(t)
  const chat = model("gemini-4-argon", "openai-completions")
  for (const e of [
    { usage: { prompt_tokens_details: { cached_tokens: 123 } } },
    { choices: [{ usage: { prompt_cache_hit_tokens: 0 } }] },
    { usage: { cached_tokens: 50 } },
  ]) {
    l.begin({ messages: [{ role: "user", content: "x" }] }, chat, "short", 0)
    l.observe(chat.api, e)
    finish(l, chat)
  }
  assert.deepEqual(records(dir).map(r => [r.outcome, r.read]), [["hit", 123], ["miss", 0], ["hit", 50]])
})

test("invalid counters stay unknown; conflicting positive telemetry is never a raw miss", t => {
  const { learner: l, dir } = fixture(t)
  for (const read of [null, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0"]) run(l, { read })
  assert.ok(records(dir).every(r => r.outcome === "unknown"))
  run(l, { read: 1000 })
  l.begin(payload(), model(), "short", 6 * M)
  l.observe(model().api, event(model(), 1000))
  l.observe(model().api, event(model(), 0))
  finish(l, model())
  assert.equal(records(dir).at(-1).outcome, "hit")
  assert.equal(records(dir).at(-1).qualified, false)
  l.begin(payload(), model(), "short", 12 * M)
  l.observe(model().api, { response: { usage: { input_tokens_details: { cached_tokens: 0 }, prompt_cache_hit_tokens: 1000 } } })
  finish(l, model())
  assert.equal(records(dir).at(-1).outcome, "hit")
  assert.equal(records(dir).at(-1).qualified, false)
})

test("Responses string input supports exact prefix reuse", t => {
  const { learner: l, dir } = fixture(t)
  run(l, { p: { instructions: "x", input: "hello" }, read: 1000 })
  run(l, { p: { instructions: "x", input: "hello" }, read: 1000, at: M })
  assert.equal(records(dir).at(-1).qualified, true)
})

test("three five-minute-bucket hits required; new tail is not the read denominator", t => {
  const { learner: l } = fixture(t)
  run(l, { read: 1000 })
  // Current prompt has a huge uncached tail. It still retains the previous prefix.
  const p = payload([{ role: "user", content: "z".repeat(100_000) }])
  run(l, { at: 6 * M, read: 1000, p })
  assert.equal(l.estimate(model(), "short").ttlMs, undefined)
  run(l, { at: 12 * M, read: 1000, p })
  assert.equal(l.estimate(model(), "short").ttlMs, undefined)
  run(l, { at: 18 * M, read: 1000, p })
  assert.deepEqual(l.estimate(model(), "short"), { ttlMs: 10 * M, source: "learned", lastHitAfterMs: 6 * M })
})

test("partial read is a hit but cannot learn duration", t => {
  const { learner: l, dir } = fixture(t)
  run(l, { read: 1000, write: 1000 })
  run(l, { at: 9 * M, read: 1000, p: payload(append) })
  const r = records(dir).at(-1)
  assert.equal(r.outcome, "hit")
  assert.equal(r.qualified, true)
  assert.equal(r.substantial, false)
  assert.equal(l.estimate(model(), "short").lastHitAfterMs, undefined)
})

test("promotion extends seeds only after three substantial comparable hits", t => {
  const { learner: l } = fixture(t)
  run(l, { m: claude, read: 1000 })
  for (let i = 1; i <= 3; i++) {
    run(l, { m: claude, at: i * 6 * M, read: 1000 })
    assert.equal(l.estimate(claude, "short").ttlMs, (i < 3 ? 5 : 10) * M)
  }
})

test("three qualified zeros lower an earlier window; unqualified zeros do not", t => {
  const { learner: l } = fixture(t)
  const m = model("gpt-6.1-sol")
  run(l, { m, read: 1000 })
  for (let i = 1; i <= 3; i++) {
    run(l, { m, at: i * 12 * M, read: 0, write: 1000 })
    assert.equal(l.estimate(m, "short").ttlMs, (i < 3 ? 30 : 10) * M)
  }
  assert.equal(l.estimate(m, "short").source, "learned")
})

test("contradictory shorter miss and longer hit marks variable/unknown", t => {
  const { learner: l } = fixture(t)
  run(l, { read: 1000 })
  run(l, { at: 10 * M, read: 1000 })
  run(l, { at: 12 * M, read: 0, write: 1000 })
  const estimate = l.estimate(model(), "short")
  assert.equal(estimate.variable, true)
  assert.equal(estimate.source, "unknown")
  assert.equal(estimate.ttlMs, undefined)
})

test("prefix, settings, tool, retention, model, failure, reset and clock changes invalidate evidence", t => {
  const { dir } = fixture(t)
  const cases = [
    l => run(l, { at: 6 * M, read: 1000, p: payload([], { instructions: "changed" }) }),
    l => run(l, { at: 6 * M, read: 1000, p: payload([], { tools: [{ name: "changed" }] }) }),
    l => run(l, { at: 6 * M, read: 1000, p: payload([], { temperature: 0.2 }) }),
    l => run(l, { at: 6 * M, read: 1000, p: payload([], { input: [{ role: "user", content: "edited" }] }) }),
    l => run(l, { at: 6 * M, read: 1000, retention: "long" }),
    l => run(l, { at: 6 * M, read: 1000, m: model("gpt-6.1-sol") }),
    l => { run(l, { at: M, read: 1000, stop: "error" }); run(l, { at: 6 * M, read: 1000 }) },
    l => { l.reset(); run(l, { at: 6 * M, read: 1000 }) },
    l => run(l, { at: 0, read: 1000 }),
  ]
  for (let i = 0; i < cases.length; i++) {
    const child = join(dir, String(i)); mkdirSync(child)
    const l = new CacheLearner(child)
    run(l, { at: M, read: 1000 })
    cases[i](l)
    assert.equal(records(child).at(-1).qualified, false, `case ${i}`)
  }
})

test("cache_control alone is stripped from prefix, but retention controls change settings", t => {
  const { learner: l, dir } = fixture(t)
  const a = { messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }] }
  const b = { messages: [{ role: "user", content: [{ type: "text", text: "x" }] }, { role: "user", content: [{ type: "text", text: "tail", cache_control: { type: "ephemeral" } }] }] }
  run(l, { m: claude, p: a, read: 1000 })
  run(l, { m: claude, p: b, at: 6 * M, read: 1000 })
  assert.equal(records(dir).at(-1).qualified, true)
  b.messages[1].content[0].cache_control.ttl = "1h"
  run(l, { m: claude, p: b, at: 12 * M, read: 1000 })
  assert.equal(records(dir).at(-1).qualified, false)
})

test("reload preserves learned estimates without persisting prompts, paths, or native objects", t => {
  const { learner: l, dir } = fixture(t)
  run(l, { read: 1000 })
  for (let i = 1; i <= 3; i++) run(l, { at: i * 6 * M, read: 1000 })
  const loaded = new CacheLearner(dir)
  assert.deepEqual(loaded.estimate(model(), "short"), l.estimate(model(), "short"))
  for (const name of ["observations.jsonl", "estimates.json"]) {
    const text = readFileSync(join(dir, name), "utf8")
    assert.doesNotMatch(text, /PRIVATE|input_tokens|cacheRead|instructions|\/Users|credentials/)
    assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600)
  }
  run(loaded, { at: 50 * M, read: 1000 })
  assert.equal(records(dir).at(-1).qualified, false, "anchors do not survive process/session reload")
})

test("learned duration survives log rotation and reload instead of dropping back after a busy day", t => {
  const { learner: l, dir } = fixture(t)
  run(l, { read: 1000 })
  for (let i = 1; i <= 3; i++) run(l, { at: i * 6 * M, read: 1000 })
  assert.equal(l.estimate(model(), "short").ttlMs, 10 * M)
  for (let i = 1; i <= 520; i++) run(l, { at: (18 + i) * M, read: 1000 })
  assert.equal(l.estimate(model(), "short").ttlMs, 10 * M, "routine short turns must not erase the longer learned window")
  const restored = new CacheLearner(dir)
  assert.equal(restored.estimate(model(), "short").ttlMs, 10 * M)
})

test("bounded rotation, damaged records and permissive old file modes", t => {
  const { learner: l, dir } = fixture(t)
  for (let i = 0; i < 520; i++) run(l, { at: i * M, read: 1000 })
  assert.equal(records(dir).length, 512)
  assert.ok(statSync(join(dir, "observations.jsonl.1")).size < 1_000_000)
  const log = join(dir, "observations.jsonl")
  writeFileSync(log, readFileSync(log, "utf8") + '{"prompt":"PRIVATE"}\ncorrupt\n')
  chmodSync(log, 0o666)
  const restored = new CacheLearner(dir)
  assert.equal(restored.estimate(model(), "short").source, "learned")
  run(restored, { at: 600 * M, read: 1000 })
  assert.equal(statSync(log).mode & 0o777, 0o600)
  writeFileSync(join(dir, "estimates.json"), "broken")
  assert.doesNotThrow(() => new CacheLearner(dir))
})

test("nonfatal I/O, symlink refusal, lock contention and concurrent writer merge", t => {
  const { dir } = fixture(t)
  const target = join(dir, "target")
  writeFileSync(target, "untouched")
  const linked = join(dir, "linked"); mkdirSync(linked)
  symlinkSync(target, join(linked, "observations.jsonl"))
  assert.doesNotThrow(() => run(new CacheLearner(linked), { read: 1000 }))
  assert.equal(readFileSync(target, "utf8"), "untouched")
  assert.doesNotThrow(() => run(new CacheLearner(target), { read: 1000 }))
  const outside = join(dir, "outside"); mkdirSync(outside)
  symlinkSync(outside, join(dir, "alias"))
  assert.doesNotThrow(() => run(new CacheLearner(join(dir, "alias", "must-not-create")), { read: 1000 }))
  assert.throws(() => statSync(join(outside, "must-not-create")), { code: "ENOENT" })
  const shared = join(dir, "shared"); mkdirSync(shared)
  const first = new CacheLearner(shared)
  run(first, { read: 1000 })
  const second = new CacheLearner(shared)
  run(first, { at: 6 * M, read: 1000 })
  run(second, { at: 7 * M, read: 1000 })
  assert.equal(records(shared).length, 3)
  writeFileSync(join(shared, "observations.lock"), "locked")
  assert.doesNotThrow(() => run(second, { at: 13 * M, read: 1000 }))
  assert.equal(records(shared).length, 3)
})

test("Gemini implicit cache fill without write counters qualifies subsequent positive reads and tracks unobserved writes", t => {
  const { learner: l, dir } = fixture(t)
  const argon = model("gemini-4-argon", "openai-completions")
  // Cold turn: read=0, write omitted ($0 implicit cache fill).
  run(l, { m: argon, at: 0, read: 0 })
  // Warm turn 6m later: positive read proves prior cold turn populated the cache.
  run(l, { m: argon, at: 6 * M, read: 1000 })
  assert.equal(records(dir).at(-1).qualified, true)
  assert.equal(records(dir).at(-1).substantial, true)
  assert.equal(records(dir).at(-1).elapsed, 6 * M)

  // Two more 6m hits after cold or warm turns without write counters.
  run(l, { m: argon, at: 12 * M, read: 1000 })
  run(l, { m: argon, at: 18 * M, read: 1000 })
  // Isolated early miss at 20s and late misses at 16m (each preceded by a warm hit anchor without write counters).
  run(l, { m: argon, at: 18 * M + 20_000, read: 0 })
  run(l, { m: argon, at: 19 * M, read: 1000 })
  run(l, { m: argon, at: 35 * M, read: 0 })
  run(l, { m: argon, at: 36 * M, read: 1000 })
  run(l, { m: argon, at: 52 * M, read: 0 })

  const est = l.estimate(argon, "short")
  assert.equal(est.ttlMs, 10 * M)
  assert.equal(est.source, "learned")
  assert.equal(est.unobservedWrites, true)
  assert.equal(est.earlyMisses, 1)
  assert.equal(est.maxHitAfterMs, 6 * M)
  assert.notEqual(est.variable, true)

  const reloaded = new CacheLearner(dir)
  assert.deepEqual(reloaded.estimate(argon, "short"), est)
})

test("isolated early misses in a hit-supported bucket do not collapse Argon into unknown/variable", t => {
  const { learner: l } = fixture(t)
  const argon = model("gemini-4-argon", "openai-completions")
  let now = 0
  run(l, { m: argon, at: now, read: 1000 })
  // 10 hits in the 5m bucket (at 3m) + 1 hit in the 10m bucket (at 5m06s)
  for (let i = 0; i < 10; i++) {
    now += 3 * M
    run(l, { m: argon, at: now, read: 1000 })
  }
  now += 5 * M + 6_000
  run(l, { m: argon, at: now, read: 1000 })
  // 3 early opportunistic misses (6s, 20s, 4m) interleaved with hits, plus 3 misses at 15m+
  for (const gap of [6_000, 20_000, 4 * M]) {
    run(l, { m: argon, at: now + gap, read: 0 })
    now += gap + M
    run(l, { m: argon, at: now, read: 1000 })
  }
  for (let i = 0; i < 3; i++) {
    now += 16 * M
    run(l, { m: argon, at: now, read: 0 })
    now += M
    run(l, { m: argon, at: now, read: 1000 })
  }
  const est = l.estimate(argon, "short")
  assert.equal(est.ttlMs, 10 * M)
  assert.equal(est.source, "learned")
  assert.equal(est.unobservedWrites, true)
  assert.equal(est.earlyMisses, 3)
  assert.notEqual(est.variable, true)
})

test("observations and stale saved estimates older than 30 days are pruned on persist and reload", t => {
  const { learner: l, dir } = fixture(t)
  const oldBase = 1_700_000_000_000
  const claudeShort = model("claude-haiku-5.5", "anthropic-messages")
  const sol = model("gpt-6.1-sol")

  // Learn 10m on claude-haiku-5.5 at t = oldBase
  run(l, { m: claudeShort, at: oldBase, read: 1000 })
  for (let i = 1; i <= 3; i++) run(l, { m: claudeShort, at: oldBase + i * 6 * M, read: 1000 })
  assert.equal(l.estimate(claudeShort, "short").ttlMs, 10 * M)

  // 31 days later, record observations on sol; claude-haiku-5.5 observations (>30d old) must be pruned.
  const freshBase = oldBase + OBSERVATION_RETENTION_MS + 24 * 60 * M
  run(l, { m: sol, at: freshBase, read: 1000 })
  run(l, { m: sol, at: freshBase + 6 * M, read: 1000 })

  const persisted = records(dir)
  assert.ok(persisted.length > 0)
  assert.ok(persisted.every(r => r.at >= freshBase - OBSERVATION_RETENTION_MS))
  assert.ok(persisted.every(r => r.model !== "claude-haiku-5.5"))

  const restored = new CacheLearner(dir)
  // Stale learned estimate (>30d old) was pruned, reverting claude-haiku-5.5 to its 5m seed.
  assert.deepEqual(restored.estimate(claudeShort, "short"), { ttlMs: 5 * M, source: "measured" })
})
