const { randomUUID } = require("node:crypto");

// The shipped iOS lyrics request has a 75s idle deadline. Keep the entire
// single attempt below it, without committing HTTP 200 early.
const LYRICS_TOTAL_MS = 70_000;

function isLyricsGeneration(body) {
  // Recognize the existing app contract; no app update or client tier claim is
  // needed. In particular, YouTube analysis mentions lyrics but is not this flow.
  return body.messages.some(message => {
    const text = typeof message?.content === "string" ? message.content : "";
    return (message?.role === "system" && /expert songwriter and lyric architect/i.test(text))
      || (/"titleSuggestion2"\s*:/.test(text) && /"lyrics2"\s*:/.test(text));
  });
}

class GenerationTimeout extends Error {}
class ClientDisconnected extends Error {}

async function attempt(body, limit, operation, apiKey) {
  const controller = new AbortController();
  let timer;
  let onAbort;
  const deadline = new Promise((_, reject) => {
    const cancel = reason => { reject(reason); controller.abort(); };
    onAbort = () => cancel(operation.reason);
    operation.addEventListener("abort", onAbort, { once: true });
    if (operation.aborted) onAbort();
    timer = setTimeout(() => cancel(new GenerationTimeout("Attempt timed out")), limit);
  });
  try {
    // Race the body read too. Even a transport that fails to settle after abort
    // cannot keep the client waiting or retain the in-flight lease indefinitely.
    return await Promise.race([deadline, (async () => {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if ([408, 504, 524].includes(response.status)) {
        // Timeout pages may be HTML. Status is enough; discard their body.
        response.body?.cancel().catch(() => {});
        return { response, data: null };
      }
      const data = await response.json();
      return { response, data };
    })()]);
  } finally {
    clearTimeout(timer);
    operation.removeEventListener("abort", onAbort);
  }
}

function createLyricsHandler({ apiKey, prepareBody, blockRetry, sendJSON }) {
  const active = new Map();
  return async function handleLyrics(req, res, fingerprint) {
    const existing = active.get(fingerprint);
    if (existing && existing.expires > performance.now()) {
      const retryAfter = Math.max(1, Math.ceil((existing.expires - performance.now()) / 1000));
      res.set("Retry-After", String(retryAfter));
      return sendJSON(res, 409, { code: "generation_in_progress",
        error: "This generation is already in progress.", retry_after: retryAfter });
    }
    // Defensive TTL: an expired lease cannot prevent a new request. Abort its
    // operation first; the owner's finally must not delete a newer lease.
    if (existing) existing.controller.abort(new GenerationTimeout("Lease expired"));
    const controller = new AbortController();
    const lease = { controller, expires: performance.now() + LYRICS_TOTAL_MS };
    active.set(fingerprint, lease);
    const requestId = randomUUID();
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    const requested = req.body.model;
    const proRoute = requested === "anthropic/claude-opus-4.8";
    const body = prepareBody(req.body);
    const model = body.model;
    let attempts = 0;
    // Route is inferred from the requested model, NOT a verified subscription.
    const context = () => `id=${requestId} requested=${requested} model=${model} kind=lyrics tier=unknown route=${proRoute ? "pro_primary" : "other"} attempts=${attempts}`;
    res.set({ "X-Generation-Request-Id": requestId, "Cache-Control": "no-store, no-transform" });
    const onClose = () => {
      if (!res.writableEnded) controller.abort(new ClientDisconnected("Client disconnected"));
    };
    res.on("close", onClose);
    const totalTimer = setTimeout(() => controller.abort(new GenerationTimeout("Operation timed out")), LYRICS_TOTAL_MS);
    console.log(`[generate] start ${context()}`);
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      attempts++;
      const { response, data } = await attempt(body, LYRICS_TOTAL_MS, controller.signal, apiKey);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok) {
        // A provider/CDN timeout gets the same terminal JSON contract as our
        // own deadline. Never return an HTML 524 or an ambiguous HTTP 200.
        if ([408, 504, 524].includes(response.status)) {
          throw new GenerationTimeout("Upstream timed out");
        }
        console.warn(`[generate] upstream_error ${context()} status=${response.status} elapsed_ms=${elapsed()}`);
        return sendJSON(res, response.status, { error: data?.error || "AI provider request failed.", code: "generation_failed" });
      }
      const choice = data?.choices?.[0];
      if (data?.error || !choice?.message?.content || choice.finish_reason === "length") {
        console.warn(`[generate] incomplete ${context()} elapsed_ms=${elapsed()}`);
        return sendJSON(res, 502, { error: "AI returned an incomplete response. Please try again.", code: "generation_incomplete" });
      }
      const usage = data?.usage;
      if (usage?.prompt_tokens_details) {
        console.log(`[cache] ${model} prompt=${usage.prompt_tokens} cached=${usage.prompt_tokens_details.cached_tokens || 0} written=${usage.prompt_tokens_details.cache_write_tokens || 0} cost=${usage.cost ?? "?"}`);
      }
      console.log(`[generate] complete ${context()} elapsed_ms=${elapsed()} reasoning_tokens=${usage?.completion_tokens_details?.reasoning_tokens ?? 0}`);
      return sendJSON(res, 200, data);
    } catch (error) {
      if (error instanceof GenerationTimeout || error instanceof ClientDisconnected) {
        if (active.get(fingerprint) === lease) blockRetry(fingerprint);
        console.warn(`[generate] ${error instanceof ClientDisconnected ? "client_disconnected" : "timeout"} ${context()} elapsed_ms=${elapsed()}`);
        return sendJSON(res, 504, { code: "generation_timeout", error: "AI generation timed out. Please wait one minute before trying again.", retry_after: 60 });
      }
      console.error(`[generate] proxy_error ${context()} elapsed_ms=${elapsed()}`);
      return sendJSON(res, 502, { code: "generation_proxy_error", error: "AI provider request failed." });
    } finally {
      clearTimeout(totalTimer);
      res.off("close", onClose);
      if (active.get(fingerprint) === lease) active.delete(fingerprint);
    }
  };
}

module.exports = { createLyricsHandler, isLyricsGeneration, LYRICS_TOTAL_MS };
