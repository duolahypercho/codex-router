- **A released router lock ignores its pending heartbeat stat callbacks.**
  Catalog, service, credential-pool, and Kimi refresh operations no longer crash
  when a stat callback arrives after release, and that callback cannot start a
  heartbeat write into a reacquired lock. Active compromise and genuine release
  failures remain visible. Already-dispatched writes and unreleased stale-lock
  filesystem races remain limitations of the lock dependency.
