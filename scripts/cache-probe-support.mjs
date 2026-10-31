// Offline telemetry helpers. Never retain provider content, credentials, or IDs.
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const count = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0
const own = (value, key) => object(value) && Object.hasOwn(value, key)

// Usage is numeric telemetry, not an arbitrary provider object. Bound traversal so
// malformed/cyclic input cannot make an observer expensive or recursive forever.
function usageSnapshot(value, depth = 0) {
  if (!object(value) || depth > 8) return null
  const result = {}
  for (const key of Object.keys(value).slice(0, 128)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) continue
    const field = value[key]
    if (field === null || (typeof field === "number" && Number.isFinite(field))) result[key] = field
    else if (object(field)) {
      const nested = usageSnapshot(field, depth + 1)
      if (nested && Object.keys(nested).length) result[key] = nested
    }
  }
  return result
}

function mergeUsage(previous, next) {
  const result = { ...previous }
  for (const [key, value] of Object.entries(next)) {
    result[key] = object(value) ? mergeUsage(object(result[key]) ? result[key] : {}, value) : value
  }
  return result
}

export function createUsageCollector(api) {
  let rawUsage = null, responseModel = null
  const rawEvents = []
  return {
    observe(event) {
      try {
        if (!object(event)) return
        let usage, model
        if (api === "anthropic-messages") {
          if (event.type === "message_start") {
            usage = event.message?.usage
            model = event.message?.model
          } else if (event.type === "message_delta") usage = event.usage
        } else if (api === "openai-completions") {
          usage = object(event.usage) ? event.usage : event.choices?.[0]?.usage
          model = event.model
        } else if (api === "openai-responses") {
          usage = event.response?.usage
          model = event.response?.model
        } else return
        if (typeof model === "string") responseModel = model
        const snapshot = usageSnapshot(usage)
        if (!snapshot) return
        rawUsage = api === "anthropic-messages" ? mergeUsage(rawUsage ?? {}, snapshot) : snapshot
        rawEvents.push({ type: typeof event.type === "string" ? event.type : null, usage: snapshot })
      } catch {
        // Instrumentation must not interfere with a paid request.
      }
    },
    snapshot() {
      return structuredClone({ rawUsage, rawEvents, responseModel })
    },
  }
}

export function rawCounters(api, rawUsage) {
  const u = object(rawUsage) ? rawUsage : {}
  let input, output, read, write, longWrite
  if (api === "anthropic-messages") {
    input = u.input_tokens
    output = u.output_tokens
    read = u.cache_read_input_tokens
    write = u.cache_creation_input_tokens
    longWrite = u.cache_creation?.ephemeral_1h_input_tokens
  } else if (api === "openai-completions" || api === "openai-responses") {
    const details = api === "openai-completions" ? u.prompt_tokens_details : u.input_tokens_details
    input = api === "openai-completions" ? u.prompt_tokens : u.input_tokens
    output = api === "openai-completions" ? u.completion_tokens : u.output_tokens
    read = details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens
    write = details?.cache_write_tokens
    longWrite = details?.cache_write_1h_tokens
    input = count(input) && count(read) && (write == null || count(write))
      && input >= read + (write ?? 0) ? input - read - (write ?? 0) : null
  }
  return {
    input: count(input) ? input : null,
    output: count(output) ? output : null,
    cacheRead: count(read) ? read : null,
    cacheWrite: count(write) ? write : null,
    cacheWrite1h: count(longWrite) ? longWrite : null,
    cacheReadReported: count(read),
    cacheWriteReported: count(write),
  }
}

/** Cache controls are collected at any depth; prompt cache settings are payload-level. */
export function inspectCacheSettings(payload) {
  const result = {
    cacheControls: [],
    prompt_cache_retention: null,
    prompt_cache_options: null,
    prompt_cache_key: null,
  }
  if (!object(payload)) return result
  // Only copy configuration, never the parent message or its prompt text.
  for (const key of ["prompt_cache_retention", "prompt_cache_options", "prompt_cache_key"]) {
    if (own(payload, key) && payload[key] !== undefined) result[key] = structuredClone(payload[key])
  }
  const seen = new WeakSet()
  function visit(value) {
    if (value === null || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    if (object(value.cache_control)) result.cacheControls.push(structuredClone(value.cache_control))
    for (const [key, child] of Object.entries(value)) {
      if (key !== "cache_control") visit(child)
    }
  }
  visit(payload)
  return result
}

function requireCount(value, label) {
  if (!count(value)) throw new RangeError(`${label} must be a finite nonnegative number`)
  return value
}

export function computeCost(model, usage) {
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) requireCount(usage?.[key], key)
  const longWrite = usage.cacheWrite1h === undefined ? 0 : requireCount(usage.cacheWrite1h, "cacheWrite1h")
  if (longWrite > usage.cacheWrite) throw new RangeError("cacheWrite1h exceeds cacheWrite")
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite
  requireCount(promptTokens, "prompt token total")
  let rates = model?.cost, threshold = -1
  for (const tier of rates?.tiers ?? []) {
    requireCount(tier.inputTokensAbove, "inputTokensAbove")
    if (promptTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      threshold = tier.inputTokensAbove
      rates = tier
    }
  }
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) requireCount(rates?.[key], `cost.${key}`)
  const input = usage.input * rates.input / 1e6
  const output = usage.output * rates.output / 1e6
  const cacheRead = usage.cacheRead * rates.cacheRead / 1e6
  const cacheWrite = ((usage.cacheWrite - longWrite) * rates.cacheWrite + longWrite * 2 * rates.input) / 1e6
  const promptTotal = input + cacheRead + cacheWrite
  const total = promptTotal + output
  requireCount(total, "total cost")
  return { input, output, cacheRead, cacheWrite, total, promptTotal }
}

export function classifyReuse(control, timed) {
  for (const [name, usage] of [["control", control], ["timed", timed]]) {
    for (const key of ["input", "cacheRead", "cacheWrite"]) requireCount(usage?.[key], `${name}.${key}`)
  }
  if (control.cacheRead === 0) throw new RangeError("Control must have positive cache reads")
  if (timed.cacheRead === 0) return "miss"
  return timed.cacheRead >= control.cacheRead * 0.95 ? "retained" : "partial"
}
