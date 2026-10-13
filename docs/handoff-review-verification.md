# Handoff review fixes: verification

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
