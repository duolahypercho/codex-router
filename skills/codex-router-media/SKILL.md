---
name: codex-router-media
description: Generate images, video, music, or speech with the codex-router media CLI (MiniMax Token Plan). Use only when the user explicitly asks to create media; not for reading or editing existing media.
---

# MiniMax media generation (codex-router)

The router stores the operator's MiniMax Token Plan API key. The `media`
command resolves that key itself — you never see or handle the credential.
Each call spends the operator's paid MiniMax quota, so generate only what the
user explicitly asked for, once, and reuse the downloaded file for retries of
later steps.

## How to call it

Run the router CLI through the shell tool. Locate it once per session: the
install root is the `current.sourceRoot` field of
`~/.codex/codex-router/install-manifest.json` (`%USERPROFILE%` on Windows),
and the command is `<sourceRoot>/bin/media` (`<sourceRoot>\model-router.ps1
codex media` on Windows). Quote the path; it may contain spaces. If the
manifest is missing, try `~/.local/share/codex-router/bin/media`.

Always pass `--json` so the result is machine-readable, and `--out` so the
file lands where the user wants it (default: the current directory).

## Actions

```
media video  --prompt "TEXT" [--duration 6] [--resolution 768P|1080P] [--image PATH_OR_URL] [--out clip.mp4] --json
media music  --prompt "style, mood, scenario" (--lyrics "[verse]..." | --instrumental) [--out track.mp3] --json
media speech --text "TEXT" [--voice male-qn-qingse] [--speed 1.0] [--out voice.mp3] --json
media image  --prompt "TEXT" [--ratio 16:9] [--count 1] [--out picture.jpeg] --json
media status --task-id ID --json
```

- **video** is asynchronous upstream: the command submits a task and polls
  until the clip is rendered (typically 1–3 minutes; it blocks until done and
  downloads the mp4). If it exits saying the task is still rendering, wait and
  run `media status --task-id ID` — never resubmit the same prompt.
- **video model**: the default `MiniMax-Hailuo-02` is the one the Token Plan
  serves. `MiniMax-H3` is refused on this subscription; the command already
  explains that, so do not retry with H3.
- **music** needs either `--lyrics` (use section tags like `[verse]`,
  `[chorus]`) or `--instrumental`.
- `--image` turns video generation into image-to-video from a first frame
  (local file path or URL).

## Rules

1. Generate only on an explicit user request, and only once per request.
   Ask before regenerating a result the user has not rejected.
2. Report the saved file path back to the user. The download URLs expire, so
   the file is the deliverable, not the URL.
3. If the command reports a missing credential or an insufficient balance,
   relay that message and stop; do not hunt for keys or edit configuration.
4. Do not pipe the key, the command's environment, or credential files
   anywhere. The CLI handles authentication internally.
