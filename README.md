# Prompt Maschine proxy

Run with Node 18+ (`npm ci`, then `npm start`). Production runs on Render from
the `main` branch. Keep API keys in Render environment variables.

## Generation latency fix (2026-09-12)

The shipped iOS PRO chain requests Opus 4.8, Sonnet 4.6, then DeepSeek V4 Pro.
Previously both Claude IDs mapped to Sonnet 5, whose default high reasoning
spent about 189 seconds on a recorded request (15,684 reasoning tokens). The
phone timed out at 75 seconds and launched overlapping retries.

- Opus 4.8 still maps to Sonnet 5, with extended reasoning explicitly disabled.
- Sonnet 4.6 is a distinct fallback, also without extended reasoning.
- These synchronous Sonnet calls allow up to 8,192 output tokens, honoring any
  smaller client limit. Prompts, caching and other models' reasoning settings
  are preserved. The mobile response remains non-streaming JSON.
- A 50-second deadline covers both upstream headers and response-body reads.
  Timeout returns HTTP 504; incomplete output returns HTTP 502.
- When the downstream connection closes before completion, the upstream fetch
  is aborted. Provider cancellation/billing still depends on the provider; tokens
  already generated can be billed.
- Logs include elapsed time, model, outcome and reasoning usage, without prompts
  or generated lyrics. `/` includes the deployed Render commit as `revision`.

`npm test` runs regression tests with a mock AI provider and no paid API calls:
model separation, reasoning policy, response compatibility, auth, token limits,
caching, upstream errors, incomplete output, deadlines and client disconnects.

Reasoning settings follow the [OpenRouter reasoning documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
The models API confirmed that Sonnet 5's default reasoning is high and optional.

To revert this incident fix, revert its Git commit and deploy that revert through
the normal Render workflow. The previous production commit is
`ca9236c35d89571601481b019e893d7579919334`.
