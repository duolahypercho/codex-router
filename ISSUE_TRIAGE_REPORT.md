# Issue Triage Report

## Issues Investigated

### ✅ Fixed Issues (PRs Created)

#### #1189: Collaboration v2 threads fail with 400 invalid_responses_request
- **Status**: Fixed on branch `cursor/fix-collaboration-v2-call-id-49e3`
- **Root Cause**: The OpenAI Responses adapter was rejecting `function_call_output` items without `call_id`, but Codex's native collaboration v2 legitimately omits it on child-agent tool results
- **Fix**: Modified validation to make `call_id` optional while still validating it when present
- **Testing**: All tests pass, including new test cases for collaboration v2 items
- **Files Changed**:
  - `src/openai-adapters.mjs` - Updated validation logic
  - `test/openai-adapters.test.mjs` - Added tests for new behavior
  - `changelog.d/collaboration-v2-call-id.md` - Changelog fragment

#### #1195: Tray update fails with "npm is required but was not found on PATH"
- **Status**: Fixed on branch `cursor/fix-npm-discovery-beside-node-49e3`
- **Root Cause**: When `node` is a symlink in a PATH prefix pointing to a real installation elsewhere, `npm` might be in the real installation directory not in the candidate list
- **Fix**: After finding `node`, resolve its symlink and look for `npm` in the same directory
- **Impact**: Fixes macOS tray "Update & Verify" failures for symlinked node installations
- **Files Changed**:
  - `bin/install` - Added npm-beside-node discovery for shell script
  - `install.ps1` - Added npm-beside-node discovery for PowerShell
  - `changelog.d/npm-discovery-beside-node.md` - Changelog fragment

#### #1175: Tray uninstall fails with "task exists or is unreadable"
- **Status**: Fixed on branch `cursor/fix-tray-uninstall-error-state-49e3`
- **Root Cause**: When both PowerShell hosts fail to query the scheduled task, `taskExists()` returns "error", which was treated the same as "exists"
- **Fix**: Only refuse uninstall when `taskExists()` returns "exists"; treat both "missing" and "error" as "nothing to uninstall"
- **Testing**: The error state is now handled gracefully
- **Files Changed**:
  - `src/tray-service-windows.mjs` - Updated uninstall logic
  - `changelog.d/tray-uninstall-error-state.md` - Changelog fragment

---

### 🔍 Needs Further Investigation

#### #1176: install.ps1 deletes itself after installing Codex CLI
- **Status**: Needs reproduction and deeper investigation
- **Complexity**: High - involves interaction between router, Codex CLI, and Windows file system
- **Issue Description**: 
  - User reports `install.ps1` disappears between runs after installing Codex CLI
  - Other router processes also started failing
  - Windows Defender was ruled out (no detection/quarantine)
  - Error logs show `SERVICE_STOP_UNVERIFIED` and service-related failures
- **Suggested Approach**:
  1. Try to reproduce on a Windows machine with both desktop app and CLI
  2. Add logging to track when `install.ps1` is accessed/deleted
  3. Check if Codex CLI installation triggers any cleanup scripts
  4. Investigate service startup/stop failure connection
  5. Check if the launcher script has any file deletion logic
- **Comment to Leave**: "This requires Windows-specific reproduction and debugging. The symptoms (install.ps1 disappearing, service failures) suggest a process cleanup or file locking issue, but without being able to reproduce it, it's hard to identify the exact cause. Recommend adding instrumentation to track file operations on install.ps1 and monitoring the service lifecycle during CLI installation."

#### #1185: Command Code DeepSeek V4.1 Flash repeatedly auto-compacts
- **Status**: Needs design discussion and testing
- **Complexity**: High - involves search tool support, token estimation, and provider-specific behavior
- **Issue Description**:
  - Model repeatedly auto-compacts within a single turn due to tool schemas exceeding 850K threshold
  - The 2.9MB tool schema alone accounts for ~901K estimated tokens
  - Compaction succeeds but next response recreates the above-threshold count
  - User provided exact-route probe evidence showing search tool relay works
- **Analysis**:
  - The route lacks `searchTool` declaration
  - Tool schemas are sent eagerly, not deferred
  - Estimated input tokens include full tool schemas, triggering compaction threshold
  - Similar to issues #297 and #846
- **Suggested Approach**:
  1. Add `searchTool: { mode: "standalone" }` to the registry entry for this route
  2. Test with Codex's client-side search execution
  3. Verify the tool count drops and compaction loop stops
  4. Confirm catalog publication doesn't break
  5. Consider if other DeepSeek routes need the same treatment
- **Comment to Leave**: "The analysis points to missing `searchTool` declaration causing eager tool schema delivery. The fix would be adding `searchTool: { mode: 'standalone' }` to the registry entry, similar to precedents in #297 and #846. However, this needs live testing with Codex's search execution to verify it eliminates the compaction loop without breaking the catalog or streaming. The exact-route probe evidence is helpful but doesn't cover the full production flow with real connector tools."

---

### 📋 Roadmap Item

#### #1099: Search sidecar: Keenable as an opt-in second adapter
- **Status**: Roadmap item - needs design discussion
- **Category**: Feature request / Enhancement
- **Issue Description**: 
  - Request to add Keenable Search as a second trusted search-sidecar adapter
  - Contributor has implementation on a branch with tests and docs
  - Only policy change is allowing keyless operation for Keenable's public API
- **Suggested Approach**:
  1. This is a policy decision about trusted search adapters
  2. Needs maintainer review of the security/trust model
  3. Review the existing branch implementation
  4. Consider if allowing keyless operation sets a precedent
  5. Needs design discussion before acceptance
- **Comment to Leave**: "Thank you for the detailed proposal and implementation. This is a roadmap item (P07) that requires design discussion about the trust model for search adapters and the precedent of allowing keyless operation. The implementation looks well thought out with tests and docs, but the policy change needs maintainer review. I've tagged this as 'needs design discussion' and recommend bringing it up with the maintainers to discuss the trust and security implications."

---

## Summary

- **3 issues fixed** with PRs created (#1189, #1195, #1175)
- **2 issues need further investigation** (#1176, #1185)
- **1 roadmap item** acknowledged (#1099)

All fixed issues include:
- Root cause analysis
- Code fixes with appropriate safety checks
- Tests (where applicable)
- Changelog fragments following the repository's convention
- Detailed commit messages

The fixes are small, safe, and focused on specific failure modes without changing broader behavior.
