const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
process.env.OPENROUTER_API_KEY = "unit-test-only";
process.env.APP_SHARED_SECRET = "unit-test-app-key";
process.env.ENFORCE_APP_KEY = "true";
const { app } = require("../server");
const { isLyricsGeneration, LYRICS_TOTAL_MS } = require("../lyrics-generation");
const clientFetch = global.fetch;
const realSetTimeout = global.setTimeout;
const song = { choices: [{ finish_reason: "stop", message: { content: '{"lyrics":"test"}' } }] };
let server, base;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
function body(idea, model = "anthropic/claude-opus-4.8") {
  return { model, messages: [{ role: "system", content: "You are an expert songwriter and lyric architect." },
    { role: "user", content: idea }], temperature: 0.85, response_format: { type: "json_object" } };
}
function post(payload) {
  return clientFetch(`${base}/api/generate`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-App-Key": "unit-test-app-key", Connection: "close",
  }, body: JSON.stringify(payload) });
}
function fastTimers(t) {
  t.mock.method(global, "setTimeout", (fn, delay, ...args) => realSetTimeout(fn,
    // Scale the former split deadlines too, so restoring 45+25 would fail the
    // slow-primary regression rather than silently leaving a 45s real timer.
    [25_000, 45_000, LYRICS_TOTAL_MS].includes(delay) ? delay / 700 : delay, ...args));
}
test("shipped lyrics contract is recognized without misclassifying YouTube analysis", () => {
  assert.equal(isLyricsGeneration(body("An original song")), true);
  assert.equal(isLyricsGeneration({ messages: [{ role: "user", content: 'Return {"titleSuggestion2":"B", "lyrics2":"text"}' }] }), true);
  assert.equal(isLyricsGeneration({ messages: [{ role: "user", content: "Analyze this YouTube video. Do not copy lyrics." }] }), false);
  assert.equal(isLyricsGeneration({ messages: [null, {}, { role: "user", content: [] }] }), false);
  assert.equal(LYRICS_TOTAL_MS, 70000);
  assert.ok(LYRICS_TOTAL_MS < 75000);
});
test("successful lyrics serve requested Opus and do not invoke fallback", async t => {
  const mock = t.mock.method(global, "fetch", async (url, options) => {
    assert.equal(JSON.parse(options.body).model, "anthropic/claude-opus-4.8");
    return Response.json(song);
  });
  const r = await post(body("successful generation"));
  assert.equal(r.status, 200);
  assert.ok(r.headers.get("x-generation-request-id"));
  assert.deepEqual(await r.json(), song);
  assert.equal(mock.mock.callCount(), 1);
});
test("PRO primary can finish after the old 45s cutoff without fallback; restrictions survive", async t => {
  fastTimers(t);
  const payload = { ...body("slow primary success"), provider: { only: ["anthropic"], zdr: true, max_price: { prompt: 1, completion: 9 } } };
  const seen = [];
  t.mock.method(global, "fetch", async (url, options) => {
    const outbound = JSON.parse(options.body); seen.push(outbound);
    // 80% of the accelerated 70s deadline exceeds the former 45/70 cutoff.
    await new Promise(resolve => realSetTimeout(resolve, 80));
    assert.equal(options.signal.aborted, false);
    return Response.json(song);
  });
  const r = await post(payload);
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), song);
  assert.deepEqual(seen.map(x => x.model), ["anthropic/claude-opus-4.8"]);
  assert.deepEqual(seen[0].messages, payload.messages);
  assert.deepEqual(seen[0].provider.max_price, payload.provider.max_price);
  assert.deepEqual(seen[0].provider.only, ["anthropic"]);
  assert.equal(seen[0].provider.zdr, true);
});
test("stalled fetch or response body yields real HTTP 504 JSON without a second attempt", async t => {
  fastTimers(t);
  for (const stallBody of [false, true]) {
    const signals = [];
    const mock = t.mock.method(global, "fetch", async (url, options) => {
      signals.push(options.signal);
      if (stallBody) return { ok: true, json: () => new Promise(() => {}) };
      return new Promise(() => {});
    });
    const r = await post(body(`noncooperative upstream ${stallBody}`));
    assert.equal(r.status, 504);
    const text = await r.text(); assert.equal(text[0], "{", "no HTTP 200 heartbeat before error");
    assert.equal(JSON.parse(text).code, "generation_timeout");
    assert.equal(signals.length, 1); assert.ok(signals.every(s => s.aborted));
    mock.mock.restore();
  }
});
test("Haiku timeout does not start a paid PRO fallback", async t => {
  fastTimers(t);
  const mock = t.mock.method(global, "fetch", () => new Promise(() => {}));
  const r = await post(body("haiku timeout", "anthropic/claude-haiku-4.5"));
  assert.equal(r.status, 504); assert.equal((await r.json()).code, "generation_timeout");
  assert.equal(mock.mock.callCount(), 1);
});
test("HTML 524 and HTTP 504 return immediate terminal timeout JSON without fallback", async t => {
  for (const status of [524, 504]) {
    const mock = t.mock.method(global, "fetch", async () => new Response("<html>Timeout</html>", { status }));
    const r = await post(body(`html timeout ${status}`));
    assert.equal(r.status, 504); assert.equal((await r.json()).code, "generation_timeout");
    assert.equal(mock.mock.callCount(), 1); mock.mock.restore();
  }
});
test("concurrent identical requests are blocked across models; success releases the lease", async t => {
  let finish, started;
  const start = new Promise(resolve => { started = resolve; });
  t.mock.method(global, "fetch", () => { started(); return new Promise(resolve => { finish = resolve; }); });
  const payload = body("concurrent song"); const pending = post(payload);
  await start;
  const duplicate = await post({ ...payload, model: "anthropic/claude-sonnet-4.6" });
  assert.equal(duplicate.status, 409);
  assert.ok(Number(duplicate.headers.get("retry-after")) <= 70);
  assert.equal((await duplicate.json()).code, "generation_in_progress");
  finish(Response.json(song)); assert.equal((await pending).status, 200);
  t.mock.method(global, "fetch", async () => Response.json(song));
  assert.equal((await post(payload)).status, 200);
});
test("timeout releases in-flight lease, keeps only 60s cooldown, and allows retry after expiry", async t => {
  fastTimers(t);
  t.mock.method(global, "fetch", () => new Promise(() => {}));
  const payload = body("retry after expired cooldown");
  assert.equal((await post(payload)).status, 504);
  const cooled = await post(payload); assert.equal(cooled.status, 429);
  assert.equal((await cooled.json()).code, "generation_retry_cooldown");
  const future = Date.now() + 61000; t.mock.method(Date, "now", () => future);
  t.mock.method(global, "fetch", async () => Response.json(song));
  assert.equal((await post(payload)).status, 200);
});
test("expired lease aborts its owner and its cleanup cannot remove the replacement", async t => {
  let now = 1000;
  t.mock.method(performance, "now", () => now);
  const calls = [];
  let started;
  t.mock.method(global, "fetch", (url, { signal }) => {
    return new Promise(resolve => { calls.push({ signal, resolve }); started?.(); });
  });
  const payload = body("lease TTL recovery");
  let ready = new Promise(resolve => { started = resolve; });
  const first = post(payload); await ready;
  now += LYRICS_TOTAL_MS + 1;
  ready = new Promise(resolve => { started = resolve; });
  const second = post(payload); await ready;
  assert.equal(calls[0].signal.aborted, true);
  assert.equal((await first).status, 504);
  const third = await post(payload);
  assert.equal(third.status, 409, "old owner's finally preserved the newer lease and did not add cooldown");
  assert.equal((await third.json()).code, "generation_in_progress");
  calls[1].resolve(Response.json(song)); assert.equal((await second).status, 200);
});
test("JSON parse failure, provider error and incomplete output release the lease", async t => {
  for (const kind of ["parse", "provider", "incomplete"]) {
    const payload = body(`error cleanup ${kind}`);
    const mock = t.mock.method(global, "fetch", async () => kind === "parse"
      ? new Response("not json") : kind === "provider" ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json({ choices: [] }));
    assert.equal((await post(payload)).status, kind === "provider" ? 503 : 502);
    mock.mock.restore();
    const success = t.mock.method(global, "fetch", async () => Response.json(song));
    assert.equal((await post(payload)).status, 200); success.mock.restore();
  }
});
test("phone disconnect aborts upstream and never starts fallback", async t => {
  let request, notify;
  const aborted = new Promise(resolve => { notify = resolve; });
  const mock = t.mock.method(global, "fetch", (url, { signal }) => {
    signal.addEventListener("abort", notify, { once: true });
    request.destroy(); return new Promise(() => {});
  });
  request = http.request(`${base}/api/generate`, { method: "POST", headers: {
    "Content-Type": "application/json", "X-App-Key": "unit-test-app-key",
  } });
  request.on("error", () => {}); request.end(JSON.stringify(body("disconnect lyrics")));
  let timer;
  try { await Promise.race([aborted, new Promise((_, reject) => { timer = realSetTimeout(() => reject(Error("not aborted")), 1000); })]); }
  finally { clearTimeout(timer); request.destroy(); }
  assert.equal(mock.mock.callCount(), 1);
});
