- **A failed child spawn runs the supervisor's normal cleanup.** If a gateway
  executable disappears or cannot be started, the service now reports the spawn
  error and stops the forwarders it already launched before exiting nonzero.
  Previously an unhandled child-process error bypassed cleanup, leaving those
  listeners behind and interfering with the next service start.
