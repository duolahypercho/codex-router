- **Devin CLI 3000.x model discovery works again.** The router presented
  itself to Cascade as `windsurf` with no IDE or extension version, and Devin
  3000.x answers that `GetCliModelConfigs` request with HTTP 400
  `invalid_argument`, so no Devin model could be listed. Discovery and the
  probe now send the shipped CLI's own metadata (`chisel`, `0.0.0-dev`), and
  turns send `darwin` rather than `mac` for macOS. Unnamed tool-argument
  deltas extend the active call instead of being dropped, so streamed tool
  calls reach Codex intact; complete restatements emit only their new argument
  suffix. The probe uses the same accumulator. Cascade still rejects the
  descriptions of Codex's
  `exec_command`, `write_stdin`, and `apply_patch` tools; that refusal is
  upstream and is reported as a permission denial.
