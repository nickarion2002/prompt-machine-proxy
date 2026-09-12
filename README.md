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
  are preserved. The mobile response remains one JSON document, not SSE.
- Sonnet providers are sorted by throughput, at no higher token prices than
  the observed standard rates: Sonnet 5 $2/$10 and Sonnet 4.6 $3/$15 per million
  input/output tokens. Existing privacy/provider restrictions and tighter caps
  are preserved. No premium service tier is requested.
- The first fix's **50-second deadline was a regression**: the real 26,326-token
  Romanian/Humanizer request was cancelled while generating at 25–30 tok/s.
  It is replaced by a **120-second hard deadline** covering headers and body.
  Every 10 seconds the proxy writes 1KB of valid JSON whitespace, allowing
  shipped URLSession clients with 60–75s idle timeouts to receive a complete
  result without an app update. This is not a guarantee of total app latency:
  analysis and best-effort Romanian cleanup are separate calls.
- Errors before the first heartbeat preserve HTTP status (504 for a deadline,
  502 for incomplete output). Once headers are sent, the status cannot change:
  a late failure returns an explicit `error` JSON document with no `choices`,
  never a partial song. Shipped iOS decoders reject it and move to fallback.
- After a timeout or client disconnect, an identical request from the same
  caller is cooled down for 60 seconds, including other model IDs. Responses
  are HTTP 429 with `Retry-After` and `generation_retry_cooldown`; the shipped
  iOS retry/fallback loop therefore cannot trigger six further paid copies.
  Fingerprints canonicalize JSON key order and are per-process HMACs; no prompt
  text/results are retained. The bounded 1,000-entry cooldown map is per server
  process, clears on restart, and is not a distributed quota or billing cap.
- When the downstream connection closes before completion, the upstream fetch
  is aborted. Provider cancellation/billing still depends on the provider; tokens
  already generated can be billed.
- Logs include elapsed time, model, outcome and reasoning usage, without prompts
  or generated lyrics. `/` includes the deployed Render commit as `revision`.

`npm test` runs regression tests with a mock AI provider and no paid API calls:
model separation, reasoning policy, response compatibility, auth, token limits,
caching, upstream errors (before/after headers), incomplete output, deadlines,
heartbeats, cross-model retry suppression, cooldown expiry and disconnects.

Transport behavior follows Apple's [URLSession idle-timeout documentation](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/timeoutintervalforrequest).
Provider sorting and price ceilings follow [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection).

Reasoning settings follow the [OpenRouter reasoning documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).
The models API confirmed that Sonnet 5's default reasoning is high and optional.

To revert this incident fix, revert its Git commit and deploy that revert through
the normal Render workflow. The previous production commit is
`ca9236c35d89571601481b019e893d7579919334`.
