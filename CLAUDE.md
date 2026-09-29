# Project

## Prompt rewriting

Apply the `prompt-rewriter` skill to **every user message, before any work, in every session**: rewrite the natural-language prompt into a precise, context-grounded `Rewritten prompt:` block and execute that rewrite. Keep the rewrite to a few lines and spend no extra tool calls on it — it must not cost more context than it saves. If an attached image cannot be read (image input unsupported), do not call Read on it or stall: say so in one line, mark screenshot facts as unknown, ask the user to paste the visible text, and continue with the rewrite. Never let a failed image read stop the `Rewritten prompt:` block.

## Releases

Every push to `main` publishes a new version to GitHub Releases automatically
(`.github/workflows/release.yml`: CI checks, then the next minor after the newest
`v*` tag). The user requires a new release on every push: never push in a way
that skips it, and after pushing, confirm the Release run went green and the
release is listed. Documentation-only pushes are the one exception. To choose a
number instead, `npm run release -- <patch|major|X.Y.Z> --push`.
