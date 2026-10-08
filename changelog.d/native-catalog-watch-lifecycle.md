- **Native catalog maintenance follows the supervisor's lifetime.** Shutdown
  clears the background timer and prevents queued checks or a late import from
  starting new work. The startup check shares the periodic single-flight guard,
  and the timer no longer keeps an otherwise finished process alive.
