# Optional automatic handoff before prompt-cache expiry

## Current acceptance amendments

The user's latest instructions replace the original session-total policy and
cheaper-only chooser policy below. The remaining original requirements still apply.

- Pi's valid `model.promptCache[active retention tier]` declaration is the countdown
  baseline, including model overrides and custom providers. Keep local duration
  evidence independent; use it for the countdown only without a declaration.
- Native `cacheWarming: "idle"` owns background cache work. Pause automatic
  handoff without changing the saved preference, even after a native cost-based
  stop, missing lifetime, refresh failure, or safety-limit stop. Do not override
  Pi's warming decision or replicate its scheduler. Native `off` and `streaming`
  retain the existing idle handoff policy. Respect global-only warming settings;
  unreadable/invalid warming settings fail closed for unattended generation.
  Native refresh usage counts toward session totals and updates the countdown,
  but does not enter model context or train a normal assistant-turn sample.
- Automatic handoff is **on by default** when no on/off preference is saved.
  Preserve valid explicit on/off choices. Malformed settings fail closed rather
  than enable unattended spending. Generation and tools can incur costs.
- Eligibility uses the existing **estimated cold prompt/cache cost of the current
  context**, current model, and retention setting. The default threshold is
  **$0.50 USD**, with a strict `cost > threshold` comparison. Lifetime spending,
  output costs, abandoned-branch usage, and historical compaction costs are not
  part of this estimate. A small post-compaction context must not dispatch merely
  because earlier session spending was high.
- Reuse `inspect()` and `coldCost()`; keep the separate cold-send warning budget.
  Require known, finite positive **current** context size and a finite nonnegative
  cost. Historical cache-token fallback may inform the old warning, but must not
  authorize unattended generation when current context usage is unknown. Recompute
  current context cost during the final dispatch recheck. Preserve the positive
  remaining cache lifetime of at most 60 seconds, idle/pending checks, current
  model route, unchanged prompt, once-per-session guard, and no cold catch-up.
- Persist the new estimate threshold as `handoffColdCostThresholdUsd`. The old
  `handoffThresholdUsd` was lifetime spending and must not be reinterpreted.
  Legacy configurations use the new $0.50 default unless a valid new threshold
  is saved; preserve explicit `autoHandoff`, budget, and placement. Settings
  labels, notifications, and completions must describe current-context cost.
- The chooser shows **all scoped models**, with cost estimates and context-limit
  reasons. The current model is represented by Continue. Selecting a context-
  ineligible model must not switch/send and must reopen the chooser.
- The user prefers a concise handoff status/completion message instead of raw
  generation chat. Full run hiding is currently unavailable through supported
  Pi extension APIs. Keep full history and the original generation route; use
  only supported display improvements, and report this limitation honestly.
  Set `Preparing handoff…` as the working label during generation and retain the
  configured label across continuations. Pi may show its own retry indicator
  during retry delays. Reset the label after success, failure, or interruption.
  Failed display updates or completion notifications must not remove verified
  durable output or change ready metadata.
- `/cache-guard` opens one flat settings menu: cold-send budget, handoff on/off,
  handoff threshold, and all countdown placements. Toggle handoff directly; edit
  amounts through an input, not a preferences submenu. A selection applies one
  change and returns. `/cache-guard handoff` without arguments is an alias for
  the same menu. Preserve direct argument commands and existing validation.

Acceptance checks derive from these amendments: prices below, exactly at, and
above $0.50; cheap current context after expensive compaction/history; expensive
current context with negligible recorded spending; context/model/retention races;
new-install enabled default; preserved saved off and legacy settings; invalid
settings; and existing timing, one-shot, artifact, and chooser safety checks.
Use hand-calculated fixture costs as the oracle before source changes.

## Original design (historical where superseded above)

## Problem Statement

A user returns to a costly Pi session after its prompt cache has expired. Continuing the session can require an expensive cold-cache prompt write. The user wants to preserve the full conversation, but also wants a cheaper way to resume in a fresh session.

Automatic compaction is not an acceptable substitute: it changes the context available in the existing session. A handoff generated only after the user returns also misses the chance to use the warm cache.

Cache Guard already estimates cache lifetime, shows a countdown, and asks before an expensive cold-cache send. It does not prepare a handoff or offer a handoff-based new session.

## Solution

Add an optional automatic handoff. It is off by default. When recorded total session costs exceed a configurable USD threshold, default $10, start the user's handoff prompt 60 seconds before the expected cache expiry, provided the agent is idle and no messages are pending.

The current session model creates the handoff as a visible conversation turn. The original prompt remains unchanged. It instructs the agent to write to the operating system's temporary directory. The extension then verifies the output and creates a durable copy outside the workspace, adding YAML front matter that identifies the source Pi session and the source conversation state.

When the user later sends a message through the existing expensive cold-cache confirmation, offer a new session with the saved handoff alongside continuing the old session with its estimated prompt cost. The user's pending request follows them into the new session. No compaction or session switch happens without their choice.

```text
Opt-in + session total > threshold
└─ Expected expiry minus 60 seconds
   ├─ Busy, pending input, or cache already cold → no automatic send
   └─ Idle + warm cache
      └─ Original handoff prompt in current session
         └─ Verified temp artifact → durable copy + source metadata

Later expensive cold-cache input
├─ New session with handoff → handoff + pending request
├─ Continue old session → original context + pending request
├─ Existing cheaper scoped-model choices
└─ Cancel → preserve pending input
```

## User Stories

1. As a Pi user, I want automatic handoff to be off by default, so that the extension does not spend money without my consent.
2. As a Pi user, I want to enable automatic handoff through Cache Guard settings, so that I can prepare a lower-context continuation before leaving a session.
3. As a Pi user, I want to set a total session cost threshold in US dollars, so that automatic handoffs apply only to sessions I consider costly.
4. As a Pi user, I want the default threshold to be $10, so that enabling the feature has a clear initial policy.
5. As a Pi user, I want the threshold to use all recorded costs in this session, so that compaction or a branch change does not hide spending.
6. As a Pi user, I want the handoff to start 60 seconds before expected cache expiry, so that it can use the warm context.
7. As a Pi user, I want the handoff to wait for an idle agent with no pending messages, so that it does not interrupt active work.
8. As a Pi user, I want a missed warm-cache window to produce no automatic cold-cache send, so that the safety feature does not cause the cost it seeks to avoid.
9. As a Pi user, I want the current model to create the handoff, so that a model switch does not discard the existing cache advantage.
10. As a Pi user, I want my original handoff prompt to remain unchanged, so that its artifact references, redaction instructions, and suggested-skills section are retained.
11. As a Pi user, I want the handoff request and response to appear in the old session, so that I can see what happened during my absence.
12. As a Pi user, I want the original conversation to remain intact, so that I can continue with its full context.
13. As a Pi user, I want the generated handoff saved outside the workspace, so that it does not alter my project files.
14. As a Pi user, I want a durable handoff copy, so that temporary-directory cleanup does not remove my continuation option.
15. As a Pi user, I want the handoff's YAML header to identify the source Pi session, so that I can locate the original conversation.
16. As a Pi user, I want the header to identify the source conversation state and creation time, so that I can judge which work the handoff covers.
17. As a Pi user, I want no repeated automatic handoff caused by the handoff refreshing the cache, so that the extension cannot create a paid loop.
18. As a Pi user, I want reloads and session resumes to preserve the handoff guard, so that they do not create duplicate automatic work.
19. As a Pi user, I want a new-session option only when a real saved handoff is available, so that the extension does not offer a broken continuation.
20. As a Pi user, I want to choose a new session with the handoff when sending through the cold-cache warning, so that I can reduce the context carried forward.
21. As a Pi user, I want to continue the old session without using the handoff, so that I retain the complete conversation when needed.
22. As a Pi user, I want the old-session option to show estimated prompt cost in USD, so that I can make an informed choice.
23. As a Pi user, I want my pending text and images preserved during a session switch, so that I do not have to recreate my request.
24. As a Pi user, I want cancel or a failed session switch to preserve my pending input, so that I do not lose work.
25. As a Pi user, I want an older handoff marked as such if I continued working after it was created, so that I do not mistake it for the latest state.
26. As a Pi user, I want existing cheaper scoped-model options to remain available, so that the new feature does not remove current choices.
27. As a Pi user, I want handoff failures reported without automatic retries, so that failure does not cause more unexpected spending.
28. As a Pi user, I want hiding the countdown to leave enabled handoff scheduling active, so that display placement does not change the feature's policy.

## Implementation Decisions

- Extend the existing settings command and persisted settings with an explicit enabled flag and a separate session-total threshold. Do not reuse the cold-send budget: it controls the estimated cost of one prompt, not accumulated spending. Accept finite, nonnegative USD amounts and preserve unrelated settings.
- Use the existing cache-state and provider-retention logic. Do not add independent TTL or price tables. Cache expiry remains a conservative estimate, not a provider guarantee.
- Sum recorded usage costs across all entries in the current session, including abandoned branches and usage attached to assistant messages, tool results, compactions, branch summaries, and standalone usage entries. Follow Pi's session-total semantics and avoid double counting. Do not aggregate parent sessions. Missing recorded usage cannot be reconstructed as actual billed cost.
- Separate scheduling from countdown rendering. Support the interactive-session workflow; hiding the widget must not disable scheduling. Start and stop resources at session lifecycle boundaries.
- Start at the first eligible timer observation with positive remaining cache lifetime of at most 60 seconds. Recheck session identity, enabled state, total cost, idle state, pending messages, and warm-cache status immediately before dispatch. Never dispatch a missed job once the cache is cold.
- Use the current model and the normal session message route. Do not replace the existing context or change models for generation. Send the original supplied prompt verbatim. Do not append a YAML instruction to it; metadata is the extension's responsibility.
- The prompt requires agent file output and can involve normal tools. This is not the earlier proposed tool-free Markdown response. Do not temporarily remove tools or rewrite the system prompt to force output, since this changes the request prefix and may lose cache reuse.
- Identify the actual output artifact from the handoff run, including an evidence-based fallback when the write occurs through a shell or another tool. Verify a real, nonempty Markdown artifact in the expected temporary location. Never infer success solely from assistant prose or copy arbitrary nearby temp files.
- After verification, create a durable copy in an agent-owned handoff directory outside the workspace. Preserve the generated body and add valid YAML front matter with source session ID, source session file when available, source conversation leaf ID, and creation time. Escape metadata correctly. A file-less session has an ID but no resumable file link; do not invent one.
- Publish the durable artifact and its session metadata atomically enough that a failed write cannot expose a usable handoff choice. Use restrictive local file permissions where supported. Keep unrelated files untouched.
- Persist handoff state as extension session metadata excluded from model context. Reconstruct it across reloads and resumes, accounting for branches. Persist the dispatch guard before sending to prevent duplicate dispatch; a failed dispatch must not start an unattended retry loop.
- Working interpretation: allow at most one automatic handoff dispatch per session, including failed attempts. This conservatively implements the user's request for one handoff and no further one. The last assistant message explicitly broadened this to a lifetime session guard; the user invoked spec synthesis rather than separately confirming that wording. Record this as an interpretation, not a separately confirmed requirement.
- Preserve the existing cold-send budget gate and input eligibility rules. Add the handoff choice when a verified durable handoff is available. Retain Send/Continue, cheaper scoped models with their thinking levels, and Cancel. Label the estimate as prompt input/cache cost, not a guaranteed whole-turn total or savings claim.
- Starting a linked new session requires Pi's command-context session replacement boundary; ordinary input handlers cannot replace sessions directly. Use a supported command boundary and a fresh replacement context, not a retained stale command context. Preserve the pending text and images and avoid sending an internal command to the model as plain text.
- Link the replacement session to the source session using Pi's parent-session support. Supply the verified handoff content and the original pending request to the fresh session once. Confirm the handoff file is still available before replacement; on cancellation or failure, preserve the original session and pending input.
- Determine freshness from meaningful conversation changes after handoff creation, not from the handoff's own turns or metadata. Show the creation time and an older-state warning without silently generating another handoff.
- Keep the original prompt's instructions to redact sensitive information and reference existing artifacts. Do not claim that model redaction is guaranteed. A source session link can still lead to sensitive material.
- Verify minimum Pi API compatibility during implementation. The repository supports Pi 1.0.0 and later, while the explored session-replacement APIs were verified in installed Pi 1.1.0. If the APIs are unavailable on the declared minimum, adjust the supported version or provide a supported fallback rather than relying on runtime failure.

## Testing Decisions

- Preferred main seam: the existing extension-level harness. Load the real extension factory, exercise registered commands and lifecycle/input handlers, and observe outgoing prompts, dialogs, persisted settings, session metadata, durable files, and session transitions. This is higher than testing a new scheduler helper in isolation.
- Reuse the current command/input harness and Node test runner. Add a controlled clock, isolated agent directory, temporary output directory, and realistic Pi context/session fixtures. Substitute model output for deterministic scheduling tests; keep file verification and durable writes real.
- Use the existing cache-state and pricing tests as regression protection rather than creating a parallel cache oracle. Test session-total accounting through extension behavior, with independent hand-calculated usage fixtures.
- Test external behavior, not internal function names, timer counts, or private state layouts. Keep one main feature seam; add lower-level checks only where the main seam cannot discriminate a failure.
- Acceptance cases and falsifiers:
  - Disabled default: an idle session over $10 reaches the deadline and sends nothing. Detect accidental default spending.
  - Strict threshold: totals of $9.99 and $10.00 do not dispatch; $10.01 dispatches under otherwise eligible conditions. Detect use of greater-than-or-equal.
  - Full-session totals: assistant $6, tool usage $1, compaction $2, and abandoned-branch usage $2 total $11 and dispatch. Detect active-branch-only or assistant-only accounting.
  - Timing: at 61 seconds remaining, no send; at 60 seconds, one send; at zero seconds or after a sleep jump beyond expiry, no automatic send. Detect early execution or cold catch-up.
  - Idle boundary: streaming, pending messages, or a changed session identity prevent dispatch. Detect races with live user work.
  - Prompt identity: compare the dispatched prompt byte-for-byte with the preserved original. Detect edits to storage or skill instructions.
  - One-shot behavior: after dispatch, cache warming, repeated ticks, user continuation, reload, branch changes, and resume produce no second automatic dispatch in that session. Detect paid loops and state leakage. A different eligible session can dispatch once.
  - Durable output: remove the generated temp file after a successful copy; the durable file still exists, preserves the body, and has parseable source metadata. Detect continued reliance on temporary storage.
  - Failure: missing, empty, unverified, or unwritable output produces no usable new-session choice and no unattended retry. Detect false success and partial artifacts.
  - Freshness: handoff generation itself does not mark the file stale; later task turns do. Detect metadata-induced false positives.
  - Choice boundary: old-session continuation retains full history; new-session choice receives handoff plus pending text/images once and links the parent; cancel/failure preserves input. Detect silent compaction, lost requests, or duplicate sends.
  - Regression: existing budget, placement, slash/shell exclusions, scope-based cheaper models, and thinking-level behavior remain intact.
- Add a real Pi interactive smoke test with a controlled provider/cache fixture and a short test-only clock strategy. Verify the visible automatic turn, saved artifact, selection dialog, and supported session-replacement boundary. This checks integration contracts that the mocked harness cannot establish.
- Derive expected behavior from this spec and the original prompt, not snapshots of current output. During implementation, show that targeted wrong variants such as repeated dispatch, threshold >=, or unverified artifact success fail the corresponding checks. Planned tests are not executed evidence.
- Seam review note: the existing extension harness is the proposed main seam. It has not been separately confirmed by the user. Spec synthesis proceeds without another interview, as requested.

## Out of Scope

- Automatic compaction, context deletion, or replacing the original session.
- Automatic switching to a cheaper model to generate the handoff.
- Background execution while Pi is closed or the computer is asleep.
- Guaranteed provider cache expiry or guaranteed cache hits.
- EUR conversion, external billing reconciliation, or prediction of the complete next turn's cost.
- Repeated automatic handoffs, automatic retry loops, or automatic refreshing of stale handoffs.
- A new general-purpose artifact or session backup system.
- Guaranteed secret detection or recovery of details already absent from the model context.
- New noninteractive mode workflows or a new mobile UI.

## Further Notes

### Original prompt: preserve verbatim

```text
Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS ($TMPDIR, else /tmp; %TEMP% on Windows) - not the current workspace.

Include a "suggested skills" section in the document, naming which skills the next agent should call the Skill tool for.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
```

The automatic run has no user-provided focus arguments in this scope. Retain the final sentence unchanged; do not invent a focus.

The agent writes a temporary artifact because the prompt explicitly requires it. The extension's durable copy resolves the user's reboot/cleanup concern without modifying that prompt.

A 60-second lead gives time to start a warm-cache request, but does not guarantee completion within that window or completion in one model request. Cache reads, output, and any tool follow-up requests still incur costs. Document this in the opt-in setting.

No domain glossary or ADR collection was found in the repository. Use the established terms: prompt cache, warm/cold cache, cache retention, cold-send budget, scoped models, session, compaction, and handoff.

Publication target: GitHub Issues for nilskluewer/pi-cache-guard, with the required ready-for-agent label. At synthesis time, that label and a configured triage vocabulary were absent. Publication is blocked pending /setup-matt-pocock-skills; this local document is not a published or triaged issue.
