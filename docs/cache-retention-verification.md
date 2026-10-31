# Copilot cache retention: measurement and documentation review

## Scope

This review concerns Pi requests through a GitHub Copilot subscription, not direct paid OpenAI, Anthropic, or Google API access. The current narrowed test scope is Claude Sonnet 5.5, GPT-6.1 Sol, Gemini 3.8 Flash, and Gemini 4 Argon. Earlier results for other models remain in local evidence; further Opus and Haiku tests were stopped at the user's request.

The research, completed paid run, and final offline audit below are dated 2026-10-21 in the experiment artifacts. The focused run has finished; no paid probes remain active. Some refinement trials were rejected for timing deviations. These observations are not provider lifetime guarantees.

```text
Fixed synthetic prompt
└─ Pi provider adapter → Copilot inference gateway
   ├─ Raw API counters → Pi normalized token usage
   └─ Catalog prices → calculated cost
      └─ Offline audit checks counters, timing, identity, hashes, and arithmetic
```

## What was verified

Run the offline audit with:

```bash
node scripts/verify-cache-results.mjs
```

It does not authenticate or send model requests. It follows the active run's evidence chain and writes `verification.json` in that run directory.

At the final reviewed snapshot:

- 666 request records were checked, including two provider failures.
- 2,706 reported raw token counters were checked against Pi's normalized counters.
- All 666 recorded costs were recalculated from the stored per-run model prices.
- 452 within-trial payload/model checks passed.
- 452 wall-clock timing checks passed; the largest difference between recorded idle time and wall timestamps was approximately 5.83 ms.
- The cost ledger matched recalculated request costs plus the separately carried initial experiment cost, within floating-point precision.
- No audit mismatches were found.

The final ledger totals **$9.838279** at Pi catalog prices, including the separately carried initial experiment. Conservative budget accounting reserves **$10.313927** against the $20 cap. Neither value is a verified invoice.

This establishes consistency of the recorded evidence. It does not independently prove physical KV-cache reuse, an upstream eviction event, GitHub invoice prices, or a universal provider guarantee. Cache counters describe what the gateway reports for that request; they are the relevant evidence for reported cached-token usage, rather than response speed or our local countdown.

### Completed findings in the requested model scope

| Model / requested long retention | Observed results | Limit of the conclusion |
|---|---|---|
| Claude Sonnet 5.5 | Reproduced hits after approximately 60 idle minutes; reproduced misses from approximately 61.04 minutes, followed by recovery hits | Consistent with about one hour. The 60.5-minute refinement was timing-deviated and cannot narrow the boundary. |
| GPT-6.1 Sol | Two hits after approximately 29.5 minutes; two misses after approximately 30 minutes, followed by recovery hits | Observed boundary bracket about 29.50–30.18 minutes, including timing uncertainty. Not evidence for 24 hours. |
| Gemini 4 Argon | Reproduced hits at approximately 15 minutes; reproduced misses from approximately 18.62 minutes | The 16.75-minute refinement was timing-deviated. A conservative 15-minute starting estimate is justified; an exact expiry is not. |
| Gemini 3.8 Flash | Partial reuse at some short intervals, full reuse in other longer trials, and mixed partial/miss results at 65 minutes | These trials do not support one deterministic expiry time for the entire prefix. |

Each idle interval uses a separate synthetic prefix, with a successful immediate-repeat control before the wait. Earlier interval probes therefore do not refresh later interval entries. Payload hashes and returned model identifiers are checked within each trial. The runner records actual measured idle times, preserves missing counters as unknown, and checks for clock/sleep discontinuities.

## Official documentation: what exists and what it covers

### GitHub Copilot: broad product guidance exists

GitHub's [Optimizing your AI usage, “Preserve the cache”](https://docs.github.com/en/enterprise-cloud@latest/copilot/tutorials/optimize-ai-usage#4-preserve-the-cache) states:

> Caches expire after a period of inactivity (24 hours for OpenAI models and 1 hour for most others).

The same page warns about model switches and changes to reasoning, context size, or enabled tools. It is product-level guidance. It does not specify a model-by-model TTL contract, accepted cache-retention fields, or an expiration timestamp for Pi's direct requests to the Copilot inference gateway.

The research did not identify a public per-model TTL contract for the specific subscription gateway routes used by this probe. That is a search limitation, not proof that no internal or other documentation exists. GitHub Models inference documentation concerns a different product and must not be substituted for a Copilot-subscription guarantee.

We cannot establish GitHub's reason for this documentation gap. We can establish that the broad statement alone is insufficient to configure this extension accurately for the tested route.

### OpenAI: newer models have different cache controls

The current official [OpenAI prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) separates GPT-5.6 and later from earlier models. Its model-comparison table documents:

- For GPT-5.6 and later, `prompt_cache_options.ttl` controls the requested lifetime.
- `"30m"` is the default; the current Responses API documentation also lists `"12h"`.
- Earlier models use `prompt_cache_retention`, with model-specific rules.
- Older extended retention is described as **up to** 24 hours, not a universal full-24-hour guarantee.
- The migration instructions say to replace `prompt_cache_retention` with `prompt_cache_options.ttl` for newer models.

The guide also distinguishes cache-read pricing eligibility from guaranteed physical KV reuse or reduced latency. A reported cached-token count should not be used as proof of a particular internal storage implementation.

**Local implementation evidence:** the installed Pi adapter selects the older `prompt_cache_retention: "24h"` path unless model compatibility metadata enables `supportsExplicitPromptCacheMode`. The recorded Copilot Sol model did not enable that flag, and the probe recorded the older field being sent. The measured approximately 30-minute boundary is consistent with the newer model's documented default.

This identifies a likely integration/metadata mismatch, not definitive proof that Copilot ignored the older field. The experiment did not compare the newer lifetime field on Copilot. Native OpenAI documentation does not establish that Copilot accepts or honors every native option. In particular, this review does not claim that 12-hour retention is available through the subscription gateway.

### Anthropic: five-minute and one-hour controls are documented

The official [Anthropic prompt caching guide](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) documents a five-minute default and optional one-hour retention using:

```json
{ "cache_control": { "type": "ephemeral", "ttl": "1h" } }
```

It documents refresh on cache reads, exact-prefix matching, and the `cache_read_input_tokens`, `cache_creation_input_tokens`, and one-hour cache-creation counters. The probe records the actual outgoing cache controls and the returned usage.

The guide measures lifetime from the start of a request that writes or reads the entry, not the end of a long generated response. Thus time spent generating a response can consume part of the window before a user becomes idle. Our synthetic requests generate very little output; the same measured idle interval after a long working response need not represent the same cache age.

The Sonnet results align with the documented one-hour behavior. They do not guarantee a hit when a real session changes its cached prefix, tools, model, or other relevant settings.

### Google: implicit caching is not a fixed-lifetime resource

Google's official [Gemini context caching guide](https://ai.google.dev/gemini-api/docs/caching) describes automatic implicit caching and advises similar prefixes in a short period to increase hit chances. It does not give one fixed implicit-cache TTL for every request. It also distinguishes implicit caching from explicitly managed cache resources.

The [Google cached-content resource reference](https://ai.google.dev/api/caching) documents expiration metadata for explicit cache objects. Those named resources are not created by our Copilot Chat Completions requests. Their TTL documentation therefore cannot be used as an implicit Copilot Gemini guarantee.

The observed partial and non-monotonic Flash reuse is consistent with a system where reuse is opportunistic. It does not establish the gateway's internal eviction algorithm or prove one fixed Gemini TTL.

## Consequences for Cache Guard

1. Keep advertised retention, requested retention, and measured reuse separate.
2. An outgoing `"24h"` field is not proof of 24-hour retention.
3. A countdown is a local estimate; it cannot establish the provider's current cache state before sending.
4. Prefer model/route metadata with clear provenance to broad protocol-wide lifetime assumptions.
5. Where no dependable TTL exists, show uncertainty rather than “cache cold” as a confirmed state.
6. A future fix for newer OpenAI cache controls needs a payload regression test and a separately approved Copilot compatibility probe. This review did not silently change live retention settings or run 12-hour experiments.

## Implementation and two-day normal-use trial

Version 0.5.0 uses explicit model/route starting estimates, then learns from normal requests' raw cached-token counters. It does not start new probes or change outgoing retention controls. Three comparable substantial hits can extend a five-minute bucket; repeated qualifying explicit-zero misses can reduce it. Missing counters stay unknown, and partial reuse alone does not prove survival of the full prior prefix.

Native Anthropic and OpenAI Codex subscription routes now have offline real-Pi coverage. Their starting values are marked as family estimates, not measurements of those subscriptions. Provider, API, endpoint, model, settings, and retention profiles remain separate: Copilot measurements cannot train a native subscription profile. Gemini Flash remains unknown/variable initially; Opus starts from Sonnet's family estimate rather than a successful Opus 5.5 probe.

Local observations and derived estimates are private, bounded files in Pi's configured agent directory. Learned durations survive log rotation and reload. Before publication, use the local build for two days and review comparable evidence per route; do not publish raw observations or assume this offline audit validates native subscription retention. See the README for activation and automatic-handoff controls.

## Evidence pointers

- `scripts/probe-cache-sweep.mjs`: paid runner and scheduling/budget checks.
- `scripts/cache-probe-support.mjs`: telemetry normalization and cost helpers.
- `tests/cache-probe-support.test.mjs`: offline helper contracts.
- `scripts/verify-cache-results.mjs`: offline evidence audit.
- `.scratch/cache-probe/latest-sweep.json`: current run location; avoid stale PID assumptions.
- The run directory's `summary.json`, `requests.jsonl`, `events.jsonl`, and `verification.json`: measured evidence.

Local evidence is ignored by Git and must be retained separately if the checkout is moved. This report intentionally omits credentials, personal home paths, account identities, and raw provider response IDs.
