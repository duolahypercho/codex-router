- **The Windows service no longer refuses to start when a busy host is slow
  to answer its process-identity probe.** Right after a reboot, every
  `powershell.exe` spawn can take longer than the 5-second budget the
  service-process record used to allow, so `start.mjs` could not prove its own
  identity, exited, and the logon task relaunched it into the same failure for
  minutes. Only that record now waits up to 45 seconds, retrying once if the
  first probe timed out. Every other identity check keeps the 5-second budget
  so bounded stop and restart deadlines still hold. A Windows ACL-hardening
  failure on that record is logged as a warning instead of stopping the
  service; credential files still fail closed.
