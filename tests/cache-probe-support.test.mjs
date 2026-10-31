import assert from "node:assert/strict"
import test from "node:test"
import {
  classifyReuse, computeCost, createUsageCollector, inspectCacheSettings, rawCounters,
} from "../scripts/cache-probe-support.mjs"

// Oracles: task contract, Pi's disjoint usage pools, and calculateCost's strict
// inputTokensAbove threshold. Exact boundary cases reject sum-vs-replace,
// unknown-as-zero, inclusive-input double counting, and tier >= mutations.
test("Anthropic usage updates are cumulative, preserve missing fields, and merge nested cache creation", () => {
  const collector = createUsageCollector("anthropic-messages")
  const start = { type: "message_start", message: {
    id: "secret-id", model: "claude-test", content: [{ text: "private prompt" }],
    usage: { input_tokens: 7, output_tokens: 1, cache_read_input_tokens: null,
      cache_creation_input_tokens: 30,
      cache_creation: { ephemeral_1h_input_tokens: 20, ephemeral_5m_input_tokens: 10 } },
  } }
  collector.observe(start)
  collector.observe({ type: "message_delta", usage: { output_tokens: 5,
    cache_creation: { ephemeral_5m_input_tokens: 0 } }, delta: { text: "private response" } })
  const result = collector.snapshot()
  assert.deepEqual(result.rawUsage, {
    input_tokens: 7, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: 30,
    cache_creation: { ephemeral_1h_input_tokens: 20, ephemeral_5m_input_tokens: 0 },
  })
  assert.equal(result.responseModel, "claude-test")
  assert.deepEqual(result.rawEvents, [
    { type: "message_start", usage: start.message.usage },
    { type: "message_delta", usage: { output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 0 } } },
  ])
  assert.doesNotMatch(JSON.stringify(result), /secret-id|private prompt|private response/)
  // Mutating either source events or returned snapshots must not change history.
  start.message.usage.input_tokens = 900
  result.rawUsage.input_tokens = 800
  result.rawEvents[0].usage.cache_creation.ephemeral_1h_input_tokens = 700
  assert.equal(collector.snapshot().rawUsage.input_tokens, 7)
  assert.equal(collector.snapshot().rawEvents[0].usage.cache_creation.ephemeral_1h_input_tokens, 20)
})

test("Anthropic null explicitly replaces a previous value, but absent fields do not", () => {
  const c = createUsageCollector("anthropic-messages")
  c.observe({ type: "message_start", message: { usage: { input_tokens: 0, output_tokens: 1,
    cache_creation: { ephemeral_1h_input_tokens: 4 } } } })
  c.observe({ type: "message_delta", usage: { output_tokens: null, cache_creation: {} } })
  assert.deepEqual(c.snapshot().rawUsage, { input_tokens: 0, output_tokens: null,
    cache_creation: { ephemeral_1h_input_tokens: 4 } })
})

test("OpenAI completions accepts top-level and choice usage and replaces snapshots", () => {
  const c = createUsageCollector("openai-completions")
  c.observe({ model: "copilot-model", choices: [{ usage: { prompt_tokens: 20, completion_tokens: 4 } }] })
  c.observe({ type: "chunk", usage: { prompt_tokens: 21, completion_tokens: 0 },
    choices: [{ usage: { prompt_tokens: 999 } }] })
  c.observe({ choices: [{ usage: { completion_tokens: 5 } }] })
  assert.deepEqual(c.snapshot(), {
    rawUsage: { completion_tokens: 5 }, responseModel: "copilot-model",
    rawEvents: [
      { type: null, usage: { prompt_tokens: 20, completion_tokens: 4 } },
      { type: "chunk", usage: { prompt_tokens: 21, completion_tokens: 0 } },
      { type: null, usage: { completion_tokens: 5 } },
    ],
  })
})

test("Responses captures response usage only and omits all content/auth/IDs", () => {
  const c = createUsageCollector("openai-responses")
  c.observe({ type: "response.created", response: { model: "gpt-test", id: "private-id", output: ["secret"] } })
  c.observe({ type: "response.completed", authorization: "secret-token", response: {
    id: "private-id", model: "gpt-test", output: ["secret"], usage: {
      input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 80 },
      private_text: "secret", nonfinite: Infinity,
    },
  } })
  assert.deepEqual(c.snapshot(), {
    rawUsage: { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 80 } },
    responseModel: "gpt-test",
    rawEvents: [{ type: "response.completed", usage: {
      input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 80 },
    } }],
  })
})

test("observers tolerate malformed, cyclic, and throwing objects without affecting streams", () => {
  for (const api of ["anthropic-messages", "openai-completions", "openai-responses", "unsupported"]) {
    const c = createUsageCollector(api)
    const throwing = new Proxy({}, { get() { throw Error("bad getter") } })
    for (const value of [null, undefined, 1, "text", [], {}, throwing]) assert.doesNotThrow(() => c.observe(value))
  }
  const usage = { input_tokens: 2 }
  usage.cycle = usage
  const c = createUsageCollector("openai-responses")
  assert.doesNotThrow(() => c.observe({ response: { usage } }))
  assert.equal(c.snapshot().rawUsage.input_tokens, 2)
  assert.deepEqual(createUsageCollector("unsupported").snapshot(), { rawUsage: null, rawEvents: [], responseModel: null })
})

test("raw Anthropic counters are exclusive and preserve explicit zero and long writes", () => {
  assert.deepEqual(rawCounters("anthropic-messages", {
    input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 20,
    cache_creation: { ephemeral_1h_input_tokens: 15 },
  }), { input: 10, output: 0, cacheRead: 30, cacheWrite: 20, cacheWrite1h: 15,
    cacheReadReported: true, cacheWriteReported: true })
  assert.equal(rawCounters("anthropic-messages", { input_tokens: 0 }).input, 0)
})

test("raw OpenAI counters subtract reads and writes exactly once", () => {
  for (const [api, usage] of [
    ["openai-completions", { prompt_tokens: 100, completion_tokens: 2,
      prompt_tokens_details: { cached_tokens: 70, cache_write_tokens: 20 } }],
    ["openai-responses", { input_tokens: 100, output_tokens: 2,
      input_tokens_details: { cached_tokens: 70, cache_write_tokens: 20 } }],
  ]) {
    assert.deepEqual(rawCounters(api, usage), { input: 10, output: 2, cacheRead: 70, cacheWrite: 20,
      cacheWrite1h: null, cacheReadReported: true, cacheWriteReported: true })
  }
  for (const raw of [
    { prompt_tokens: 50, prompt_cache_hit_tokens: 50 },
    { prompt_tokens: 50, cached_tokens: 50 },
    { prompt_tokens: 50, prompt_tokens_details: { cached_tokens: 50 } },
  ]) assert.equal(rawCounters("openai-completions", raw).input, 0)
  const zero = rawCounters("openai-responses", { input_tokens: 10, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } })
  assert.equal(zero.input, 10)
  assert.equal(zero.cacheRead, 0)
  assert.equal(zero.cacheReadReported, true)
  assert.equal(zero.cacheWriteReported, true)
})

test("missing or invalid cache reads are unknown, not a cache miss", () => {
  for (const cached_tokens of [undefined, null, -1, NaN, Infinity, "0"]) {
    const raw = rawCounters("openai-responses", { input_tokens: 100, input_tokens_details: { cached_tokens } })
    assert.equal(raw.cacheRead, null)
    assert.equal(raw.cacheReadReported, false)
    assert.equal(raw.input, null)
  }
  assert.equal(rawCounters("openai-responses", { input_tokens_details: { cached_tokens: 1 } }).input, null)
  assert.equal(rawCounters("openai-responses", { input_tokens: 1, input_tokens_details: { cached_tokens: 2 } }).input, null)
  assert.deepEqual(rawCounters("unknown", null), { input: null, output: null, cacheRead: null,
    cacheWrite: null, cacheWrite1h: null, cacheReadReported: false, cacheWriteReported: false })
})

test("cache inspection collects nested controls but never parent prompt text", () => {
  const payload = {
    prompt_cache_retention: "24h", prompt_cache_options: { ttl: 3600 }, prompt_cache_key: "probe-key",
    system: [{ text: "private system", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ content: [{ text: "private user", cache_control: { type: "ephemeral" } }] }],
    tools: [{ description: "private tool", cache_control: { type: "ephemeral", ttl: "5m" } }],
  }
  const settings = inspectCacheSettings(payload)
  assert.deepEqual(settings, {
    cacheControls: [{ type: "ephemeral", ttl: "1h" }, { type: "ephemeral" }, { type: "ephemeral", ttl: "5m" }],
    prompt_cache_retention: "24h", prompt_cache_options: { ttl: 3600 }, prompt_cache_key: "probe-key",
  })
  assert.doesNotMatch(JSON.stringify(settings), /private/)
  settings.cacheControls[0].ttl = "changed"
  settings.prompt_cache_options.ttl = 1
  assert.equal(payload.system[0].cache_control.ttl, "1h")
  assert.equal(payload.prompt_cache_options.ttl, 3600)
  payload.cycle = payload
  assert.doesNotThrow(() => inspectCacheSettings(payload))
  assert.deepEqual(inspectCacheSettings(null), { cacheControls: [], prompt_cache_retention: null,
    prompt_cache_options: null, prompt_cache_key: null })
})

const model = { cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } }
const usage = { input: 1000, output: 100, cacheRead: 2000, cacheWrite: 4000, cacheWrite1h: 1000 }

test("independent costs price each pool and count 1h writes only as a subset", () => {
  // Hand calculation in dollars: 1000*2, 100*10, 2000*.2,
  // 3000*2.5 + 1000*4, each divided by one million.
  const result = computeCost(model, usage)
  assert.deepEqual(result, { input: 0.002, output: 0.001, cacheRead: 0.0004,
    cacheWrite: 0.0115, promptTotal: 0.0139, total: 0.0149 })
  assert.equal(usage.cost, undefined)
  assert.equal(computeCost(model, { ...usage, cacheWrite1h: undefined }).cacheWrite, 0.01)
  assert.deepEqual(computeCost(model, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, promptTotal: 0,
  })
})

test("tiers use total prompt tokens, strict thresholds, and the highest matching tier", () => {
  const priced = { cost: { ...model.cost, tiers: [
    { inputTokensAbove: 200, input: 8, output: 40, cacheRead: 0.8, cacheWrite: 10 },
    { inputTokensAbove: 100, input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  ] } }
  const u = { input: 0, output: 10, cacheRead: 60, cacheWrite: 40, cacheWrite1h: 10 }
  assert.equal(computeCost(priced, u).output, 0.0001) // exactly 100: base rates
  assert.equal(computeCost(priced, { ...u, input: 1 }).output, 0.0002)
  assert.equal(computeCost(priced, { ...u, input: 100 }).output, 0.0002) // exactly 200
  const highest = computeCost(priced, { ...u, input: 101 })
  assert.equal(highest.output, 0.0004)
  assert.equal(highest.cacheWrite, (30 * 10 + 10 * 16) / 1e6)
})

test("cost rejects invalid counts and inconsistent 1h subset", () => {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"]) {
    for (const invalid of [null, -1, NaN, Infinity, "1"]) {
      assert.throws(() => computeCost(model, { ...usage, [key]: invalid }), RangeError)
    }
  }
  assert.throws(() => computeCost(model, { ...usage, cacheWrite1h: 4001 }), /exceeds/)
  assert.throws(() => computeCost({}, usage), RangeError)
  assert.throws(() => computeCost(model, { ...usage, input: Number.MAX_VALUE, cacheRead: Number.MAX_VALUE }), RangeError)
})

test("reuse has an inclusive 95% boundary and rejects a zero or unknown control", () => {
  const c = { input: 10, cacheRead: 100, cacheWrite: 0 }
  const timed = (cacheRead) => ({ input: 10, cacheRead, cacheWrite: 0 })
  assert.equal(classifyReuse(c, timed(95)), "retained")
  assert.equal(classifyReuse(c, timed(200)), "retained")
  assert.equal(classifyReuse(c, timed(94)), "partial")
  assert.equal(classifyReuse(c, timed(1)), "partial")
  assert.equal(classifyReuse(c, timed(0)), "miss")
  assert.throws(() => classifyReuse(timed(0), timed(0)), /positive/)
  assert.throws(() => classifyReuse({ ...c, cacheRead: null }, timed(0)), RangeError)
  assert.throws(() => classifyReuse(c, timed(NaN)), RangeError)
})
