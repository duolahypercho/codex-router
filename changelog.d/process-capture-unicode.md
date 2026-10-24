- **Captured command output preserves Unicode across pipe chunks.** Setup,
  service control, and diagnostic subprocesses now decode stdout and stderr
  independently as byte streams, so a split multibyte character no longer
  corrupts a path, diagnostic, or JSON result. Output limits still count the
  original bytes, and inherited terminal output is unchanged.
