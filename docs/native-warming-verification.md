# Native cache-warming coordination verification

## Scope and policy

Verified with installed `@earendil-works/pi-coding-agent` **1.4.0**.

```text
Normal Pi request
├─ model.promptCache[active tier] → declared countdown baseline
├─ Raw usage → independent local evidence
└─ Background work
   ├─ Native idle warming → automatic handoff paused
   │  ├─ Native warm → usage totals + refreshed countdown, no model-context message
   │  └─ Native stop/failure/safety limit → no paid handoff fallback
   └─ Native off/streaming → existing idle handoff policy
```

A declared lifetime is best-effort, not proof of cache availability. Without a declaration for the active tier, supported local seeds and learned durations remain a fallback. Local evidence never changes a declaration or enables native warming.

The extension cannot inspect `AgentSession.cacheWarmingStatus` through `ExtensionContext`. It therefore pauses automatic handoff for the whole native idle mode instead of predicting or copying Pi's scheduler. It observes `cache_warming_decision` without returning an action. This does not bypass Pi's $0.05 savings threshold or safety limits.

Global warming settings take priority over project settings when the global file exists. Missing global files use supplied settings for SDK support; an idle value conservatively pauses generation. Invalid or unreadable warming settings also pause generation. External configuration edits require reload/restart so both components use the same settings.

## Oracle and falsifiers

Requirements were recorded in `tests/cache-warming-pi.test.mjs` before implementation. The tests initially reproduced **10 relevant failures and 3 passing controls** on the old extension. Failures included handoff dispatch at 240 seconds before a native refresh scheduled for 270 seconds, ignored short/long declarations, ignored custom-model declarations, and learned durations replacing a declared baseline.

Sources:

- [Pi settings](https://pi.dev/docs/latest/settings): warming modes, global-only setting, savings threshold, usage/context separation.
- [Pi prompt-cache lifetimes](https://pi.dev/docs/latest/models#prompt-cache-lifetimes): active-tier `promptCache` and model overrides.
- Installed `dist/core/cache-warmer.js`: timing, economic calculation, lifecycle, and usage persistence.
- Installed `dist/core/agent-session.js`: session statistics and model-context accounting.

| Claim | Plausible error | Discriminating check | Result |
|---|---|---|---|
| Declarations are authoritative | Always use 5m/60m seeds | Short 120s, long 600s, custom model 420s; expect 2m/10m/7m | Pass |
| Learned evidence stays separate | Three 6m hits extend declared 5m to 10m | Real Pi normal prompts train the learner, but countdown remains 5m | Pass |
| Idle warming is not preempted | Handoff runs at T−60s before native T−30s refresh | Real native scheduler at 240s and 270s | Pass |
| Native warm is not forced | Extension overrides the savings threshold | Read-only handler; high/low economic cases | Pass |
| No paid fallback after native stop | Handoff starts after a declined/failed warm or idle cap | Economic decline, failed refresh, absent TTL, 30m safety limit | Pass |
| Global mode wins | Merged project settings authorize competing generation | Global idle/project off and inverse | Pass |
| Native usage stays outside context | Refresh adds an assistant/user turn or changes context estimate | Compare real session messages, context usage, and totals | Pass |
| Refresh does not pollute learning | Refresh counters attach to a normal assistant sample | Observation count unchanged by refresh; next normal sample starts a fresh comparison | Pass |
| Existing handoff still works | Pause all modes | Off and streaming still create a verified handoff once | Pass |

Independent fixture economics, with 150,000 prompt tokens, cache write $6.25/M, cache read $0.50/M, and output $25/M:

- Avoided miss cost: `0.15 × (6.25 − 0.50) = $0.8625` (0.15 million tokens).
- Refresh cost: `0.15 × 0.50 + 25 / 1,000,000 = $0.075025`.
- Idle expected savings: `0.15 × 0.8625 − 0.075025 = $0.05435` → native warm.
- At 81,600 tokens, expected savings are `$0.029555` → native stop, despite a $0.51 cold-context estimate above the handoff threshold.

The native-warm test first reached an invalid harness assertion that treated `getSessionStats().cost` as an object. The installed SDK returns a number. The assertion was corrected to compare that scalar against the independently calculated total; the economic expectation was not changed.

## Automated checks

Executed after implementation:

```bash
npm test
npm run smoke
git diff --check
node --check scripts/verify-native-warming.mjs
```

- **259 tests passed**, no failures or skipped tests.
- The 18 focused policy/native-runtime tests passed in three repeated runs.
- The packed tarball loaded in an isolated real Pi CLI process. This smoke check makes no provider request.
- Runtime tests use real Pi sessions, its native cache warmer, real session storage and tools. Only the provider network boundary is controlled, and time is advanced for long windows.

Learning-only fixtures now omit a declaration so that they continue to test fallback learning. New declaration tests exercise the changed policy explicitly rather than preserving the old incorrect expectation.

## Live-provider verification

Executed:

```bash
PI_PROVIDER=github-copilot PI_MODEL=gpt-6.1-sol \
  node --experimental-strip-types scripts/verify-native-warming.mjs --paid
```

The script used real Pi SDK sessions, real provider requests, synthetic prompts, isolated settings and session files, normal local authentication, no tools, automatic handoff enabled with a zero threshold, and a conservative 30-second declared lifetime. The shorter declaration accelerates the scheduler check; it is not a measurement of provider expiry. Normal Pi settings were not changed.

Latest complete run:

| Case | Requests | Native baseline decision | Refresh usage | Handoffs | Context |
|---|---:|---|---|---:|---|
| Native cost stop | 1 | stop; expected savings $0.00090078 | None | 0 | Unchanged |
| Refresh path with probe-only override | 2 | stop; overridden once by the probe | 3,501 cache-read tokens, 3 uncached input tokens, 5 output tokens | 0 | Unchanged |

The refresh case recorded **$0.0004061** of refresh usage in session totals. The countdown reset to **0:29** after the refresh. Total catalog-calculated cost for the complete three-request run was **$0.0180206**.

The probe-only override is explicit in the persisted usage entry (`note: "extension override"`). It avoids buying a very large live prompt merely to cross the native economic threshold. Production Cache Guard never returns this override. The unforced positive economic decision is verified separately through the real native warmer with controlled provider usage.

A preliminary live check found an incorrect probe assumption: native Pi asks for `maxTokens: 1`, but the real OpenAI Responses adapter raises the wire cap to **16**, the API minimum. Source: installed `pi-ai/dist/api/openai-responses.js`, `OPENAI_RESPONSES_MIN_OUTPUT_TOKENS`. The live criterion was corrected to the adapter's minimum; the final run passed with wire caps `[16, 16]` for prime and refresh. Preliminary Anthropic checks were blocked by provider model/thinking compatibility responses; no production provider code or compatibility flags were changed to bypass them.

Local evidence:

- `.scratch/native-warming-live.json`: summary and exact isolated session paths.
- `.scratch/native-warming-live.log`: live result records.
- `.scratch/tests-warming.log`: full test output.
- `.scratch/warming-repeat-1.log` through `warming-repeat-3.log`: repeated focused checks.

These files stay local and are not package contents. Raw session files use synthetic prompts; do not generalize this permission to share ordinary user sessions.

## Boundary of confidence

Verified: declared lifetimes and fallback learning, automatic-handoff coordination, native economic acceptance/rejection, real live cache reuse, usage accounting without context growth, and packed CLI loading.

Not claimed: guaranteed provider cache lifetime, guaranteed monetary savings, an unforced paid live warm on a large context, a live refresh for every provider, or a manual visual TUI inspection. No long-term provider-expiry experiment was needed for the coordination policy. Existing real Pi TUI compositor tests cover responsive countdown rendering.

**TLDR:** Pi owns idle cache refreshes; Cache Guard does not compete with them. Declarations control the baseline, learning remains separate evidence, and both automated real-runtime tests and bounded live-provider sessions support the checked behavior.
