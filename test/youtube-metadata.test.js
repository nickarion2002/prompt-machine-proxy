const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

// All provider requests are mocked; these values are deliberately fake.
const API_KEY = "unit-test-youtube-key-not-a-real-credential";
const APP_KEY = "unit-test-youtube-app-key";
process.env.YOUTUBE_API_KEY = API_KEY;
process.env.OPENROUTER_API_KEY = "unit-test-only";
process.env.SPOTIFY_CLIENT_ID = "unit-test-only";
process.env.SPOTIFY_CLIENT_SECRET = "unit-test-only";
process.env.APP_SHARED_SECRET = APP_KEY;
process.env.ENFORCE_APP_KEY = "true";
process.env.RATE_LIMIT_MAX = "60";

const {
  createYouTubeMetadata, YOUTUBE_TIMEOUT_MS, YOUTUBE_CACHE_MS,
  YOUTUBE_EMPTY_CACHE_MS, YOUTUBE_RATE_LIMIT_MAX, YOUTUBE_RATE_LIMIT_WINDOW_MS,
} = require("../youtube-metadata");
const { app: productionApp } = require("../server");
const clientFetch = global.fetch;
const realSetTimeout = global.setTimeout;
const ID = "dQw4w9WgXcQ";
const SECOND_ID = "abcdefghijk";
const payload = {
  kind: "youtube#videoListResponse", etag: "public-etag",
  items: [{ id: ID, snippet: { title: "A song", description: "0:00 Intro\n0:30 Verse",
    channelTitle: "A musician", tags: ["music"] }, contentDetails: { duration: "PT3M42S" } }],
  pageInfo: { totalResults: 1, resultsPerPage: 1 },
};

async function startApp(t, app) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, options = {}) => clientFetch(`${base}${path}`, {
    ...options, headers: { Connection: "close", ...options.headers },
  });
}

async function fixture(t, apiKey = API_KEY) {
  const service = createYouTubeMetadata({ apiKey,
    clientIp: req => req.get("X-Test-IP") || "fixture-client" });
  const app = express();
  app.get("/api/youtube/:videoId", service.rateLimit, service.handleMetadata);
  const request = await startApp(t, app);
  return (id = ID, ip = "fixture-client") => request(`/api/youtube/${encodeURIComponent(id)}`,
    { headers: { "X-Test-IP": ip } });
}

function fastDeadline(t) {
  t.mock.method(global, "setTimeout", (fn, delay, ...args) => realSetTimeout(fn,
    delay === YOUTUBE_TIMEOUT_MS ? 30 : delay, ...args));
}

test("YouTube metadata contract uses an 8s deadline, independent 120/hour quota and 24h/1h cache", () => {
  assert.equal(YOUTUBE_TIMEOUT_MS, 8000);
  assert.equal(YOUTUBE_CACHE_MS, 86400000);
  assert.equal(YOUTUBE_EMPTY_CACHE_MS, 3600000);
  assert.equal(YOUTUBE_RATE_LIMIT_MAX, 120);
  assert.equal(YOUTUBE_RATE_LIMIT_WINDOW_MS, 3600000);
});

test("valid video returns unmodified Google JSON and only requests snippet/contentDetails", async t => {
  const get = await fixture(t);
  const mock = t.mock.method(global, "fetch", async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://www.googleapis.com");
    assert.equal(url.pathname, "/youtube/v3/videos");
    assert.equal(url.searchParams.get("id"), ID);
    assert.equal(url.searchParams.get("part"), "snippet,contentDetails");
    assert.equal(url.searchParams.get("key"), API_KEY);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(payload);
  });
  const response = await get();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), payload);
  assert.equal(mock.mock.callCount(), 1);
});

test("invalid IDs produce 400 without any Google request", async t => {
  const get = await fixture(t);
  const mock = t.mock.method(global, "fetch", () => { throw Error("unexpected provider request"); });
  for (const id of ["short", "abcdefghijkl", "abcdefghij!", "abc defghij", "abc/defghij"]) {
    const response = await get(id);
    assert.equal(response.status, 400, id);
    assert.equal(typeof (await response.json()).error, "string");
  }
  assert.equal(mock.mock.callCount(), 0);
});

test("missing server key safely returns empty metadata without provider access", async t => {
  const get = await fixture(t, "");
  const mock = t.mock.method(global, "fetch", () => { throw Error("unexpected provider request"); });
  const response = await get();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { items: [] });
  assert.equal(mock.mock.callCount(), 0);
});

test("Google errors, invalid bodies and network failures all yield empty JSON with HTTP 200", async t => {
  const get = await fixture(t);
  const outcomes = [
    () => Response.json({ error: { message: "quota exceeded" } }, { status: 403 }),
    () => new Response("<html>unavailable</html>", { status: 503 }),
    () => new Response("invalid JSON", { status: 200 }),
    () => Response.json({ items: "not-an-array" }),
    () => Response.json({ error: { message: "unexpected error" } }),
    () => Response.json(null),
    () => { throw new Error("transport failed"); },
  ];
  for (let index = 0; index < outcomes.length; index++) {
    const mock = t.mock.method(global, "fetch", async () => outcomes[index]());
    const id = `failure${String(index).padStart(4, "0")}`;
    const response = await get(id);
    assert.equal(response.status, 200, `case ${index}`);
    assert.deepEqual(await response.json(), { items: [] }, `case ${index}`);
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});

test("deadline covers stalled fetch and stalled JSON body even if upstream ignores abort", async t => {
  fastDeadline(t);
  const get = await fixture(t);
  for (const stallBody of [false, true]) {
    let signal;
    const mock = t.mock.method(global, "fetch", async (_url, options) => {
      signal = options.signal;
      return stallBody ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {});
    });
    const response = await get(stallBody ? SECOND_ID : ID);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [] });
    assert.equal(signal.aborted, true);
    assert.equal(mock.mock.callCount(), 1);
    mock.mock.restore();
  }
});

test("late response after timeout cannot replace the cached empty fallback", async t => {
  fastDeadline(t);
  const get = await fixture(t);
  let finish;
  const mock = t.mock.method(global, "fetch", () => new Promise(resolve => { finish = resolve; }));
  assert.deepEqual(await (await get()).json(), { items: [] });
  finish(Response.json(payload));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await (await get()).json(), { items: [] });
  assert.equal(mock.mock.callCount(), 1);
});

test("found metadata is cached by video ID for exactly 24 hours", async t => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  const get = await fixture(t);
  const mock = t.mock.method(global, "fetch", async () => Response.json(payload));
  assert.deepEqual(await (await get()).json(), payload);
  now += YOUTUBE_CACHE_MS - 1;
  assert.deepEqual(await (await get()).json(), payload);
  assert.equal(mock.mock.callCount(), 1);
  now += 1;
  assert.deepEqual(await (await get()).json(), payload);
  assert.equal(mock.mock.callCount(), 2);
  await get(SECOND_ID);
  assert.equal(mock.mock.callCount(), 3, "another video has its own cache entry");
});

test("genuine empty results use the empty metadata contract and expire after one hour", async t => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  const get = await fixture(t);
  const empty = { kind: "youtube#videoListResponse", items: [], pageInfo: { totalResults: 0 } };
  const mock = t.mock.method(global, "fetch", async () => Response.json(empty));
  assert.deepEqual(await (await get()).json(), { items: [] });
  now += YOUTUBE_EMPTY_CACHE_MS - 1;
  assert.deepEqual(await (await get()).json(), { items: [] });
  assert.equal(mock.mock.callCount(), 1);
  now += 1;
  await get();
  assert.equal(mock.mock.callCount(), 2);
});

test("upstream failure fallback is cached for one hour and then allows recovery", async t => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  const get = await fixture(t);
  let failing = true;
  const mock = t.mock.method(global, "fetch", async () => failing
    ? new Response("unavailable", { status: 503 }) : Response.json(payload));
  assert.deepEqual(await (await get()).json(), { items: [] });
  failing = false;
  now += YOUTUBE_EMPTY_CACHE_MS - 1;
  assert.deepEqual(await (await get()).json(), { items: [] });
  assert.equal(mock.mock.callCount(), 1);
  now += 1;
  assert.deepEqual(await (await get()).json(), payload);
  assert.equal(mock.mock.callCount(), 2);
});

test("120/hour limiter counts cached requests, isolates IPs, and expires independently", async t => {
  let now = 1000000;
  t.mock.method(Date, "now", () => now);
  const get = await fixture(t);
  const mock = t.mock.method(global, "fetch", async () => Response.json(payload));
  for (let index = 0; index < 120; index++) assert.equal((await get()).status, 200);
  const limited = await get();
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "Too many requests. Try again later." });
  assert.equal((await get(ID, "second-client")).status, 200);
  assert.equal(mock.mock.callCount(), 1, "cache is shared across IPs, counters are not");
  now += YOUTUBE_RATE_LIMIT_WINDOW_MS + 1;
  assert.equal((await get()).status, 200);
  assert.equal(mock.mock.callCount(), 1, "rate reset does not expire 24h video cache");
});

test("provider errors and reflected credentials never expose the server key in response or logs", async t => {
  const get = await fixture(t);
  const logs = [];
  for (const method of ["log", "warn", "error"]) t.mock.method(console, method, (...args) => logs.push(args));
  const cases = [
    () => { throw Error(`https://www.googleapis.com/youtube/v3/videos?key=${API_KEY}`); },
    () => Response.json({ error: { message: API_KEY } }, { status: 403 }),
    () => Response.json({ items: [{ snippet: { title: API_KEY } }] }),
  ];
  for (let index = 0; index < cases.length; index++) {
    const mock = t.mock.method(global, "fetch", async () => cases[index]());
    const response = await get(`secretx${String(index).padStart(4, "0")}`);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(API_KEY), false);
    assert.deepEqual(JSON.parse(text), { items: [] });
    mock.mock.restore();
  }
  assert.equal(JSON.stringify(logs).includes(API_KEY), false);
});

test("production route uses existing app-key enforcement before Google access", async t => {
  const request = await startApp(t, productionApp);
  const mock = t.mock.method(global, "fetch", async () => Response.json(payload));
  for (const key of [undefined, "wrong-key"]) {
    const response = await request(`/api/youtube/${ID}`, { headers: {
      "X-Forwarded-For": "192.0.2.1", ...(key ? { "X-App-Key": key } : {}),
    } });
    assert.equal(response.status, 401);
  }
  assert.equal(mock.mock.callCount(), 0);
  const response = await request(`/api/youtube/${ID}`, { headers: {
    "X-Forwarded-For": "192.0.2.1", "X-App-Key": APP_KEY,
  } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), payload);
  assert.equal(mock.mock.callCount(), 1);
});

test("YouTube exhaustion leaves existing generation/Spotify shared budget untouched", async t => {
  const request = await startApp(t, productionApp);
  t.mock.method(global, "fetch", async () => Response.json(payload));
  const headers = { "X-Forwarded-For": "192.0.2.2", "X-App-Key": APP_KEY, "Content-Type": "application/json" };
  for (let index = 0; index < 120; index++) {
    assert.equal((await request(`/api/youtube/${ID}`, { headers })).status, 200);
  }
  assert.equal((await request(`/api/youtube/${ID}`, { headers })).status, 429);
  for (const path of ["/api/generate", "/api/spotify/genre", "/api/spotify/track-features"]) {
    assert.equal((await request(path, { method: "POST", headers, body: "{}" })).status, 400,
      `${path} must reach its unchanged input validation`);
  }
});

test("existing shared Spotify/generation exhaustion leaves YouTube budget untouched", async t => {
  const request = await startApp(t, productionApp);
  t.mock.method(global, "fetch", async () => Response.json(payload));
  const headers = { "X-Forwarded-For": "192.0.2.3", "X-App-Key": APP_KEY, "Content-Type": "application/json" };
  for (let index = 0; index < 60; index++) {
    const path = index % 2 ? "/api/generate" : "/api/spotify/genre";
    assert.equal((await request(path, { method: "POST", headers, body: "{}" })).status, 400);
  }
  for (const path of ["/api/generate", "/api/spotify/genre", "/api/spotify/track-features"]) {
    assert.equal((await request(path, { method: "POST", headers, body: "{}" })).status, 429);
  }
  assert.equal((await request(`/api/youtube/${ID}`, { headers })).status, 200);
});
