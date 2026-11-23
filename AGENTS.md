# Project

## Prompt rewriting

Before working on a message, decide whether to rewrite it. Full reference: `/Users/adkhex/.claude/skills/prompt-rewriting/SKILL.md`. Read it only after the block below is written, and only if you need detail.
- **Rewrite** task messages the human user typed: requests for a change, fix, feature, investigation, document or decision. Casual, vague or misspelled wording is the normal case.
- **Don't rewrite** prompts written by AI agents or automations (including your own input as a subagent), short replies or confirmations such as "yes, push it", slash commands, simple questions, or prompts that already say exactly what to change. Handle those as written, without mentioning this rule.
- **Show it first:** your reply opens with a visible **Rewritten prompt** block (Goal, Context, Requirements, Constraints, Done when, Assumptions; drop empty sections), written as text before any tool call. Don't load a skill or explore the project first. A plan in your thinking doesn't count, because the user can't see it.
- **Keep everything, add nothing:** copy code, paths, errors and names exactly. Keep scope words like "only" and "don't touch" exactly as narrow as the user made them. If they mention users, "live" or production, the result has to reach those users, so keep any push or release step. Requirements and Constraints hold only what the user said or clearly implied. Your guesses and suggestions go under Assumptions.
- **Screenshots:** say what the attached image shows that matters, and copy its visible text exactly. If you can't view it, say so in one line and continue. **Failure follow-ups** ("failed again"): include the exact error and what was already tried.
- **Prompts for image generators:** be creative and add detail freely. Write one prompt in the target tool's style instead of the sections above.
- After the block, ask first if an open question would change the outcome a lot. Otherwise do the work from the block. Where it conflicts with the user's words, the user's words win.

## Releases

Every push to `main` publishes a new version to GitHub Releases automatically
(`.github/workflows/release.yml`: CI checks, then the next minor after the newest
`v*` tag). The user requires a new release on every push: never push in a way
that skips it, and after pushing, confirm the Release run went green and the
release is listed. Documentation-only pushes are the one exception. To choose a
number instead, `npm run release -- <patch|major|X.Y.Z> --push`.
