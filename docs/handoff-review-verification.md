# Handoff review fixes: verification

## Latest follow-up: current-context cost, default on, and flat settings

Oracle: the **Current acceptance amendments** in
`docs/specs/automatic-session-handoff.md`, based on the user's approval of an
estimated current-context cold prompt/cache cost threshold of **$0.50 USD**,
default-on generation, and one settings menu. These amendments replace the
original session-total and disabled-default expectations.

The scheduler now reuses current model pricing and retention, with strict
`cost > threshold`. Known finite positive current context usage is required.
Historical cache-token fallback remains available to the existing cold warning,
but cannot authorize automatic spending. Saved on/off preferences take priority;
malformed settings fail disabled. The new saved threshold key is
`handoffColdCostThresholdUsd`; the legacy lifetime-spending key is not reused.
The unused lifetime-cost helper remains on disk: a permission gate rejected its
removal, and the deletion was not retried. Production no longer imports it.

### Executed discriminating checks

| Check | Red evidence before its production change | Green evidence |
| --- | --- | --- |
| Current cost rather than lifetime spending; new enabled default | Implementer reported 13/54 amended scheduling checks failed; offline real-Pi cases also observed missing default dispatch at $0.51 and incorrect dispatch for cheap contexts with expensive history. | Scheduler seam covers $0.49/$0.50/$0.51, token/model-price/retention races, saved off, legacy/new settings, invalid values, lifecycle and one-shot guards. Real Pi confirms unchanged prompt, built-in write, verified ready publication, and no generation for $0.01 post-compaction context despite $120 history. |
| Unknown current context cannot use old token counts | Real Pi context-usage boundary injected missing usage or null tokens with a recorded 81,600-token cache hit: 2/2 checks incorrectly appended dispatch state. | Both make no dispatch/provider request; final-check unknown-token race also passes. |
| Completion display failure cannot undo saved output | Real Pi completion-notification callback threw after built-in write: metadata incorrectly became failed instead of ready. | Ready metadata and durable content survive; no failure notification or runtime error. |
| Working label and reset | 4/5 lifecycle checks failed before the label implementation. | Callback checks cover generation, retries, continuations, exhausted retries, shutdown/branch/abort interruptions, and throwing display callbacks. Pi can display its own retry indicator during delays; callback history is not pixel evidence. |
| One flat settings menu | Real `session.prompt('/cache-guard')` checks: 14/15 failed against nested settings. | 15/15 check direct toggle, direct amount inputs, every countdown placement, cancellation, preservation of unrelated settings, and `/cache-guard handoff` opening the same menu. No model requests. |

An independent read-only review found the unknown-context and notification faults;
both were reproduced through the real offline runtime before fixes. It also
identified the host retry-indicator limitation, which is now stated explicitly.
No tool-output/thinking global preferences were changed. Full generation hiding
is still unavailable through the supported API; the original transcript remains.

Final executed checks: `npm test` (**162 passed**, zero failed/skipped),
`npm_config_offline=true npm run smoke` (passed), and `git diff --check` (passed).
Latest full-suite log: `/tmp/pi-cache-guard-context-cost-tests.log`.
Flat-menu baseline log: `/tmp/cache-guard-settings-baseline.log`.

Limits: controlled offline providers and real SDK/UI callbacks, not live-provider
or rendered-terminal acceptance. The latest changes have not been run against
Pi 1.0.0. Changes are uncommitted on `feat/automatic-session-handoff`; no personal
settings, stored handoffs, source sessions, or user-owned untracked files were
modified. No release publication was performed.

## Earlier follow-up: all scoped models and completion notice

Oracle: the user requested that the cold-cache dialog omit no scoped models and
show a reason when a model cannot fit the current context. This replaces the
previous cheaper-only selection policy. The current model remains represented
by Continue; all other scoped entries appear in scope order with estimated costs.

Before production changes, the four new checks in
`tests/scoped-selection-pi.test.mjs` failed through real Pi `session.prompt()`:
equal-price entries were absent; selecting a too-small entry did not reopen the
dialog; selecting equal-price and higher-price entries made no provider request.

After the change, all four pass. The controlled offline runtime checks every
scoped entry (including current and cross-provider models), known price estimates,
context-limit explanations, no switch/send on a blocked selection, Cancel text
preservation, and exactly one send with the selected scoped thinking level.
The selector has no disabled-row API, so selecting an unavailable row notifies
the user and reopens the dialog without consuming the pending request.

The completion notice now explains how to use the saved handoff, and remains
strictly after durable publication and ready metadata. Installed Pi has no
supported run-level visibility API: generation still appears in the old chat.
Hiding a custom input alone does not hide assistant streams or tool rows.
No stored handoff or source-session artifact was edited.

Executed after both changes: `npm test` (**111 passed**, none failed/skipped),
`npm_config_offline=true npm run smoke` (passed), and `git diff --check` (passed).
These are controlled SDK/UI-callback checks, not live-provider or rendered-terminal
acceptance. The new runtime checks have not been run against Pi 1.0.0.

At this earlier checkpoint, current-context-cost scheduling was still awaiting
threshold agreement. The latest section above records its implementation.
The original verification below describes the earlier session-total policy.

## Scope and oracle

Branch: `fix/handoff-review`, based on integration commit `d3b1a05`.
Oracle: `docs/specs/automatic-session-handoff.md`, particularly pending-input recovery,
verified durable output, and one automatic dispatch per session. Pi-owned retries are
part of that dispatch, not another Cache Guard dispatch.

Installed Pi documentation: `docs/extensions.md`, `docs/sdk.md`,
`docs/custom-provider.md`, and session/message documentation. Runtime source confirms
that extension `message_end` handlers precede message persistence and that
`agent_end` precedes retry/recovery and actionable settlement boundaries.

| Claim | Falsifier and pass criterion |
| --- | --- |
| Rejected Continue retains recovery data | Cancel an image request in real Pi, remove offline credentials, Continue with edited text. Auth rejection must leave one recovery file and make zero provider requests. |
| Image preflight is not acceptance | Inject a rejection in Pi's image-normalization method after `before_agent_start`. Recovery must remain. Restore normalization; the persisted edited user message and provider context must contain one image, not two. The next request must have no replayed image. |
| Recovery cleanup is request-specific | Unrelated persisted user message cannot clear recovery. An older accepted request cannot clear a newer cancelled draft. |
| Retry completion is final | Offline provider returns 503, then a real built-in bash tool call writes Markdown. Final state must be ready, with one original handoff request, three provider requests, one saved notification, and no failure notification. |
| Extension continuation is not final | First write a draft with the real write tool; request continuation at `agent_before_settle`; update the same file. Save only the final body, with no early saved notification. |
| Exhausted retries fail once | Three local 503 responses exhaust two retries. One dispatch guard, one final failure notification, no saved notification. |
| Raw temp expansion preserves separators | Real bash executes `printf '# Handoff\\n' > "${TMPDIR}handoff.md"` with trailing-slash TMPDIR. Durable output must end with the exact generated body. Separate override checks cover `${TMPDIR}`, `$TMPDIR/`, and `%TEMP%`, including bounds without a separator. |

## Executed red / green

Before source changes:

```sh
node --experimental-strip-types --test tests/handoff-lifecycle-pi.test.mjs
```

All three original runtime checks failed for the reported behavior: both valid-output
cases had `failed` instead of `ready`; the auth rejection removed recovery (`0`
instead of `1`). The initial harness left scheduler resources open after failure;
explicit `session_shutdown` cleanup corrected that test-harness issue.

Red was repeated to completion against untouched `d3b1a05` source in an isolated
copy, using the final regression tests:

```sh
node --experimental-strip-types --test \
  --test-name-pattern='shell TMPDIR concatenation|503 retry|auth rejection' \
  .scratch/review-red/tests/handoff-lifecycle-pi.test.mjs
```

Result: **0 pass / 3 fail**, exit 1, with the same three assertions.
Log: `/tmp/handoff-review-red-complete.log`.

Green on installed Pi coding-agent **1.1.0**:

```sh
npm test
```

Result: **100 pass / 0 fail**, including five offline real-Pi lifecycle tests and
the existing real-Pi session-replacement test.
Log: `/tmp/handoff-review-final-1.1.log`.

Compatibility run on Pi coding-agent **1.0.0**:

```sh
node --experimental-strip-types --test .scratch/review-compat/tests/*.test.mjs
```

Result: **100 pass / 0 fail**. The isolated copy used the previously extracted npm
1.0.0 package, with installed shared dependencies, including **pi-ai 1.1.0**.
This verifies the coding-agent minimum, not a fully pinned historical dependency
matrix. Log: `/tmp/handoff-review-final-1.0.log`. Temporary copies were removed.

Packed-tarball load in the real Pi RPC process, without model requests:

```sh
npm_config_offline=true npm_config_legacy_peer_deps=true npm run smoke
```

Result: `smoke ok: @nilskluewer/pi-cache-guard loads in Pi from the packed tarball`.
`legacy_peer_deps` prevents offline npm from trying to resolve host-supplied peers.
An initial offline attempt without it could not install the tarball.
A combined red/smoke command later hit the harness command timeout during smoke;
the same standalone smoke command passed again on the final source.
Final log: `/tmp/handoff-review-smoke-final.log`. `git diff --check` also passes.

## Compatibility and limits

- Keep the declared `>=1.0.0` minimum. Both versions provide `agent_settled`.
- Pi 1.0 does not supply `agent_settled.aborted`; retain the last assistant stop reason
  and use the new abort flag only when present.
- Settlement writes only non-context extension metadata and files. It does not
  append model context or request a continuation.
- Auth rejection is real runtime behavior. Image-processing rejection is a controlled
  fault at the real runtime boundary, not a claim about a particular corrupt image.
- No live provider, paid handoff, or native Windows shell was used. `%TEMP%` expansion
  was tested by substituting its override before POSIX execution, not by running cmd.exe.
- UI callbacks drive the real SDK runtime; these are not rendered terminal/pixel tests.
- The path recognizer remains evidence-based and bounded, not a general shell parser.

## Follow-up: disk persistence before draft cleanup

First merged integration tip `6d93db0` into `fix/handoff-review`, including the
previous fix and offline-smoke peer-resolution fix. This follow-up changes no spec,
ticket, credential, or user-environment configuration.

The previous acceptance check proved only branch membership. Pi's real
`SessionManager._appendEntry()` updates memory before `_persist()` can throw.
Therefore neither a matching in-memory entry nor a resolved fresh-session send
establishes that the request was saved.

### Acceptance criteria and red evidence

Oracle: the follow-up requirement to keep durable recovery until the complete
matching request, including its images, is present in the session file.

| Falsifier | Required result |
| --- | --- |
| Move the session directory before recovered-message append | Real `appendMessage()` throws ENOENT; the exact message remains in memory but not on disk. Settlement must retain one recovery file and its image. |
| File-less Continue | In-memory acceptance must not delete durable recovery. |
| Disk entry keeps the ID/text but omits the image | Settlement must retain recovery; restoring the complete line allows cleanup. |
| Fresh destination is file-less | Source recovery remains. |
| Fresh send resolves with only an in-memory user entry after a failed write | Source recovery remains. |
| Fresh disk entry omits the image | Source recovery remains. |
| Fresh input is handled without appending a user message | Source recovery remains. |

Before changing extension source, ran:

```sh
node --experimental-strip-types --test \
  --test-name-pattern='Continue retains recovery when persistence|new-session .* preserves source' \
  tests/handoff-choice.test.mjs
```

Result: **0 pass / 7 fail**, exit 1. Every case incorrectly deleted recovery
(`0` files instead of `1`). Log: `/tmp/handoff-persistence-red.log`.
The ENOENT check uses the real Pi SessionManager and a real directory move, not a
mocked persistence failure. Fresh-send outcome interception uses the same real
storage fixture, with controlled command-context callbacks.

### Implementation and green evidence

- At acceptance events, verify the session header and complete serialized entry
  lines in the actual session file. The full entry comparison includes image data.
  File-less, missing, unreadable, partial, or nonmatching files do not authorize deletion.
- No timer or tick reads the session file. Receipt checks run only for a pending
  acceptance at turn/end/settled events, or once after the replacement send.
- Replacement cleanup additionally requires newly added user and handoff-context
  entries on disk. Otherwise retain source recovery and notify the user.
- The success harness now really appends and persists fresh user/context/assistant
  entries. It no longer treats an in-memory session or a resolved stub as durable.
- After the ENOENT reproduction, restore storage, reload the saved source, recover
  its image, and persist a retry. Only that successful retry clears recovery.

Executed:

```sh
node --experimental-strip-types --test tests/handoff-choice.test.mjs
npm test
node --experimental-strip-types --test .scratch/persistence-compat/tests/*.test.mjs
npm_config_offline=true npm run smoke
git diff --check
```

Results: **21/21** choice tests; **107/107** complete tests on coding-agent 1.1.0;
**107/107** complete tests on coding-agent 1.0.0 with the installed shared
dependencies, including pi-ai 1.1.0. All original 100 tests remain. Offline packed
smoke passes. Logs: `/tmp/handoff-persistence-green.log`,
`/tmp/handoff-persistence-all.log`, `/tmp/handoff-persistence-1.0.log`, and
`/tmp/handoff-persistence-smoke.log`. The temporary compatibility copy was removed.

Compatibility minimum is unchanged. This is a complete-file-entry check, not an
fsync or power-loss guarantee, and it conservatively retains recovery when it cannot
prove persistence. No paid model request, native Windows test, environment inspection,
or credential inspection was performed for this follow-up.
