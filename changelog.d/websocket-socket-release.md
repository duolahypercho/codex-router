- **Dropped Responses WebSockets no longer leak a file descriptor.** A Codex
  client that went away without a close frame (a reset, a killed process, a
  plain TCP FIN) ended only the readable side of the upgraded socket; the
  router never closed its side, so every such connection held one descriptor
  for the life of the process. A long-running router accumulated hundreds. The
  peer now releases the socket as soon as the connection is aborted.
