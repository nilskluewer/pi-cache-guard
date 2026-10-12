# 01: Create and durably save a handoff in the current session

**What to build:** One controlled handoff run sends the user's original prompt unchanged in the current session, verifies the agent-written temporary artifact, and creates a durable copy with YAML source-session metadata. The result and path are visible. Generation state and failure status survive reload and resume. This ticket establishes the shared handoff service; it needs no new public command.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Use the current model, original prompt verbatim, and normal session tools without compaction.
- [ ] Verify the actual generated Markdown temp file, including writes through shell/codemode or a defensible fallback.
- [ ] Save a durable copy outside the workspace with source session ID, source session file when available, source leaf ID, and timestamp.
- [ ] Persist dispatch and result state as non-context session metadata, guarding once per session across reload and branches.
- [ ] Report generation/storage failures without unattended retries or false success.
- [ ] Prove external behavior with extension-level tests and real temporary/durable files.
- [ ] Expose narrow shared contracts for scheduling and later session replacement. Document those contracts in your completion summary.
