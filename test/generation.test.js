const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// No test reaches a paid provider or depends on production credentials.
process.env.OPENROUTER_API_KEY = "unit-test-only";
process.env.APP_SHARED_SECRET = "unit-test-app-key";
process.env.ENFORCE_APP_KEY = "true";
const { app, prepareGenerationBody, GENERATION_TIMEOUT_MS, GENERATION_HEARTBEAT_MS } = require("../server");
const clientFetch = global.fetch;
const originalSetTimeout = global.setTimeout;
const originalSetInterval = global.setInterval;
const messages = [{ role: "user", content: "Write original Romanian lyrics." }];
const song = { choices: [{ finish_reason: "stop", message: { content: '{"lyrics":"test"}' } }] };
let server;
let baseURL;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  baseURL = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => {
  server.close(resolve);
  server.closeAllConnections();
}));

function post(body = { model: "anthropic/claude-opus-4.8", messages }, key = "unit-test-app-key") {
  return clientFetch(`${baseURL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-App-Key": key, Connection: "close" },
    body: JSON.stringify(body),
  });
}

test("PRO serves requested Opus with bounded reasoning; fallback remains a different model", () => {
  const input = { model: "anthropic/claude-opus-4.8", messages, stream: true,
    reasoning: { effort: "high" }, reasoning_effort: "high", include_reasoning: true };
  const primary = prepareGenerationBody(input);
  assert.equal(primary.model, "anthropic/claude-opus-4.8");
  assert.deepEqual(primary.reasoning, { enabled: false });
  assert.equal(primary.reasoning_effort, undefined);
  assert.equal(primary.include_reasoning, undefined);
  assert.equal(primary.stream, false);
  assert.equal(primary.max_tokens, 8192);
  const fallback = prepareGenerationBody({ model: "anthropic/claude-sonnet-4.6", messages });
  assert.equal(fallback.model, "anthropic/claude-sonnet-4.6");
  assert.notEqual(fallback.model, primary.model);
  assert.deepEqual(fallback.reasoning, { enabled: false });
  assert.equal(input.reasoning.effort, "high", "do not mutate the client's body");
});

test("output budget respects smaller limits and normalizes the alternate token parameter", () => {
  const make = fields => prepareGenerationBody({ model: "anthropic/claude-sonnet-5", messages, ...fields });
  assert.equal(make({ max_tokens: 2048 }).max_tokens, 2048);
  assert.equal(make({ max_tokens: 100000 }).max_tokens, 8192);
  const alternate = make({ max_tokens: 9000, max_completion_tokens: 1000 });
  assert.equal(alternate.max_tokens, 1000);
  assert.equal(alternate.max_completion_tokens, undefined);
});

test("throughput routing never opts into higher prices or discards client restrictions", () => {
  const primary = prepareGenerationBody({ model: "anthropic/claude-opus-4.8", messages });
  assert.equal(primary.provider.sort, "throughput");
  assert.deepEqual(primary.provider.max_price, { prompt: 5, completion: 25 });
  const sonnet = prepareGenerationBody({ model: "anthropic/claude-sonnet-5", messages });
  assert.equal(sonnet.model, "anthropic/claude-sonnet-5");
  assert.deepEqual(sonnet.provider.max_price, { prompt: 2, completion: 10 });
  const restricted = { sort: "latency", only: ["anthropic"], zdr: true, data_collection: "deny",
    max_price: { prompt: 1, completion: 100, request: 0.01 } };
  const fallback = prepareGenerationBody({ model: "anthropic/claude-sonnet-4.6", messages, provider: restricted });
  assert.deepEqual(fallback.provider, { ...restricted, max_price: { prompt: 1, completion: 15, request: 0.01 } });
  assert.equal(restricted.max_price.completion, 100, "do not mutate caller constraints");
});

test("preserve non-Sonnet model settings and existing prompt cache breakpoints", () => {
  const free = prepareGenerationBody({ model: "google/gemini-2.5-flash", messages, reasoning: { effort: "low" } });
  assert.equal(free.model, "google/gemini-3.1-flash-lite");
  assert.deepEqual(free.reasoning, { effort: "low" });
  assert.equal(free.max_tokens, undefined);
  const prefix = "Static lyrics instructions. ".repeat(200);
  const tail = "\n---\n\nSTYLE DNA\nAn original song about a train journey.";
  const cached = prepareGenerationBody({ model: "anthropic/claude-opus-4.8",
    messages: [{ role: "user", content: prefix + tail }] });
  assert.equal(cached.messages[0].content[0].text, prefix);
  assert.deepEqual(cached.messages[0].content[0].cache_control, { type: "ephemeral" });
  assert.equal(cached.messages[0].content[1].text, tail);
});

test("production route forwards bounded policy and preserves the response contract", async t => {
  let upstreamSignal;
  t.mock.method(global, "fetch", async (url, options) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(options.headers.Authorization, "Bearer unit-test-only");
    const body = JSON.parse(options.body);
    assert.equal(body.model, "anthropic/claude-opus-4.8");
    assert.deepEqual(body.reasoning, { enabled: false });
    upstreamSignal = options.signal;
    assert.equal(upstreamSignal.aborted, false);
    return Response.json(song);
  });
  const response = await post();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), song);
  assert.equal(upstreamSignal.aborted, false, "normal request-body completion is not a disconnect");
});

test("auth and input validation prevent invalid requests from reaching the provider", async t => {
  const mock = t.mock.method(global, "fetch", async () => { throw Error("should not be called"); });
  assert.equal((await post({ model: "anthropic/claude-sonnet-5", messages }, "wrong-key")).status, 401);
  assert.equal((await post({ messages })).status, 400);
  assert.equal((await post({ model: "x", messages: [] })).status, 400);
  assert.equal(mock.mock.callCount(), 0);
});

test("provider error status is preserved without treating it as a successful song", async t => {
  t.mock.method(global, "fetch", async () => Response.json({ error: { message: "unavailable" } }, { status: 503 }));
  const response = await post();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { message: "unavailable" } });
});

test("HTTP 200 error payloads and truncated or empty outputs trigger fallback", async t => {
  for (const body of [{ error: { message: "upstream failed" } },
    { choices: [] },
    { choices: [{ finish_reason: "length", message: { content: '{"lyrics":' } }] }]) {
    const mock = t.mock.method(global, "fetch", async () => Response.json(body));
    assert.equal((await post()).status, 502);
    mock.mock.restore();
  }
});

test("deadline aborts a stalled provider response body and returns 504", async t => {
  t.mock.method(global, "setTimeout", (fn, delay, ...args) =>
    originalSetTimeout(fn, delay === GENERATION_TIMEOUT_MS ? 30 : delay, ...args));
  let aborted = false;
  t.mock.method(global, "fetch", async (url, { signal }) => ({
    ok: true,
    json: () => new Promise((resolve, reject) => signal.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    }, { once: true })),
  }));
  const response = await post();
  assert.equal(response.status, 504);
  assert.equal(aborted, true);
  assert.match((await response.json()).error, /timed out/);
});

test("client disconnect cancels the provider even after the request body is fully received", async t => {
  let request;
  let resolveAbort;
  const aborted = new Promise(resolve => { resolveAbort = resolve; });
  t.mock.method(global, "fetch", (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      resolveAbort();
      reject(new Error("aborted"));
    }, { once: true });
    // Wait until the upstream call starts, then simulate the phone giving up.
    request.destroy();
  }));
  request = http.request(`${baseURL}/api/generate`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-App-Key": "unit-test-app-key" },
  });
  request.on("error", () => {});
  request.end(JSON.stringify({ model: "anthropic/claude-opus-4.8", messages: [{ role: "user", content: "disconnect test" }] }));
  let timer;
  try {
    await Promise.race([aborted, new Promise((resolve, reject) => {
      timer = originalSetTimeout(() => reject(new Error("disconnect was not propagated")), 1000);
    })]);
  } finally {
    clearTimeout(timer);
    request.destroy();
  }
});

test("heartbeat keeps one valid JSON response alive beyond the old 50-second cutoff", async t => {
  assert.equal(GENERATION_TIMEOUT_MS, 120000);
  assert.equal(GENERATION_HEARTBEAT_MS, 10000);
  t.mock.method(global, "setInterval", (fn, delay, ...args) =>
    originalSetInterval(fn, delay === GENERATION_HEARTBEAT_MS ? 10 : delay, ...args));
  t.mock.method(global, "setTimeout", (fn, delay, ...args) =>
    originalSetTimeout(fn, delay === GENERATION_TIMEOUT_MS ? 120 : delay, ...args));
  t.mock.method(global, "fetch", async () => {
    await new Promise(resolve => originalSetTimeout(resolve, 80));
    return Response.json(song);
  });
  const response = await post({ model: "anthropic/claude-opus-4.8",
    messages: [{ role: "user", content: "slow complete response" }] });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  assert.ok(response.headers.get("x-generation-request-id"));
  const text = await response.text();
  assert.match(text, /^ {1023}\n/);
  assert.deepEqual(JSON.parse(text), song);
});

test("late provider failures and incomplete output stay errors after heartbeat headers", async t => {
  t.mock.method(global, "setInterval", (fn, delay, ...args) =>
    originalSetInterval(fn, delay === GENERATION_HEARTBEAT_MS ? 5 : delay, ...args));
  for (const [index, payload] of [
    { error: { message: "provider unavailable" }, ...song },
    { choices: [{ finish_reason: "length", message: { content: "truncated" } }] },
  ].entries()) {
    const mock = t.mock.method(global, "fetch", async () => {
      await new Promise(resolve => originalSetTimeout(resolve, 25));
      return Response.json(payload, { status: index === 0 ? 503 : 200 });
    });
    const response = await post({ model: "anthropic/claude-opus-4.8",
      messages: [{ role: "user", content: `late-error-${index}` }] });
    assert.equal(response.status, 200, "HTTP status cannot change after heartbeat");
    const data = await response.json();
    assert.ok(data.error, "mobile decoders cannot mistake this for a song");
    assert.equal(data.choices, undefined);
    mock.mock.restore();
  }
});

test("one timed-out generation suppresses immediate retries across models and JSON key order", async t => {
  t.mock.method(global, "setInterval", (fn, delay, ...args) =>
    originalSetInterval(fn, delay === GENERATION_HEARTBEAT_MS ? 5 : delay, ...args));
  t.mock.method(global, "setTimeout", (fn, delay, ...args) =>
    originalSetTimeout(fn, delay === GENERATION_TIMEOUT_MS ? 30 : delay, ...args));
  const mock = t.mock.method(global, "fetch", async (url, { signal }) => ({
    json: () => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(Error("aborted")), { once: true })),
  }));
  const original = { model: "anthropic/claude-opus-4.8", temperature: 0.85,
    messages: [{ role: "user", content: "retry-suppression-unique" }], response_format: { type: "json_object" } };
  const timedOut = await post(original);
  assert.equal((await timedOut.json()).code, "generation_timeout");
  for (const model of ["anthropic/claude-opus-4.8", "anthropic/claude-sonnet-4.6", "deepseek/deepseek-v4-pro"]) {
    const retried = await post({ response_format: { type: "json_object" },
      messages: [{ content: "retry-suppression-unique", role: "user" }], temperature: 0.85, model });
    assert.equal(retried.status, 429);
    assert.ok(Number(retried.headers.get("retry-after")) > 0);
    assert.equal((await retried.json()).code, "generation_retry_cooldown");
  }
  assert.equal(mock.mock.callCount(), 1, "fallback IDs must not launch more paid requests after timeout");
  mock.mock.restore();
  t.mock.method(global, "fetch", async () => Response.json(song));
  const changed = await post({ ...original, messages: [{ role: "user", content: "a different song" }] });
  assert.equal(changed.status, 200, "only the identical failed operation is cooled down");
  await changed.json();
  const future = Date.now() + 61000;
  t.mock.method(Date, "now", () => future);
  const afterCooldown = await post(original);
  assert.equal(afterCooldown.status, 200);
  await afterCooldown.json();
});
