- **Registry and curated-model JSON saved with a UTF-8 byte-order mark now
  loads.** PowerShell's `Set-Content` and Notepad on Windows write UTF-8 with
  a leading BOM, which made the registry loader fail with `Unexpected token`
  and made `user-models.json` silently read as empty, hiding every curated
  model. Both loaders now skip a leading BOM (#887).
