- **Control Center snapshots stay responsive while Ollama is offline.** A
  snapshot used to call the Ollama CLI for status even when the HTTP probe had
  already failed, which on desktop could launch the app and leave the snapshot
  waiting on it. The CLI call is now skipped once the API probe fails, since it
  needs the same server, and the inventory and running-model probes carry short
  timeouts, so a snapshot is bounded whether or not a local runtime is up.
