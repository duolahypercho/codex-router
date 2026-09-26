- **A model can now stay selectable while opting out of automatic failover.**
  `"failoverCandidate": false` on a `user-models.json` entry keeps the model in
  the picker and routable by slug, but removes it from quota failover,
  compaction attempts and compaction overflow, even when a named chain lists it.
  A non-boolean value is refused at load time. Models without the field rank
  exactly as before.
