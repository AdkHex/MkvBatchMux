# Project

## Prompt rewriting

Apply the `prompt-rewriter` skill to **every user message, before any work, in every session**: rewrite the natural-language prompt into a precise, context-grounded `Rewritten prompt:` block and execute that rewrite. Keep the rewrite to a few lines and spend no extra tool calls on it — it must not cost more context than it saves. If an attached image cannot be read (image input unsupported), do not call Read on it or stall: say so in one line, mark screenshot facts as unknown, ask the user to paste the visible text, and continue with the rewrite. Never let a failed image read stop the `Rewritten prompt:` block.
