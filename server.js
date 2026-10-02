const express = require("express");
const { createHmac, randomBytes, randomUUID } = require("node:crypto");
const { createLyricsHandler, isLyricsGeneration } = require("./lyrics-generation");
const { createYouTubeMetadata } = require("./youtube-metadata");
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

let spotifyAccessToken = null;
let spotifyTokenExpiresAt = 0;
const trackFeatureCache = new Map();

// ─── App key check ────────────────────────────────────────────────────────────
// The iOS app sends X-App-Key with every request. Enforcement is opt-in via
// ENFORCE_APP_KEY=true so that already-shipped app versions (which don't send
// the header yet) keep working until the update is rolled out.
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET;
const ENFORCE_APP_KEY = process.env.ENFORCE_APP_KEY === "true";

function checkAppKey(req, res, next) {
  if (!APP_SHARED_SECRET) return next();
  const ok = req.get("X-App-Key") === APP_SHARED_SECRET;
  if (!ok) {
    console.warn(`[auth] Missing/bad X-App-Key on ${req.path} from ${clientIp(req)}`);
    if (ENFORCE_APP_KEY) {
      return res.status(401).json({ error: "Unauthorized." });
    }
  }
  next();
}

// ─── Per-IP rate limiting ─────────────────────────────────────────────────────
// Protects the OpenRouter/Spotify credits from abuse. Default: 60 requests
// per hour per IP (a real user generates far less).
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || "60", 10);
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const ipHits = new Map();

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (typeof fwd === "string" && fwd.split(",")[0].trim()) || req.ip;
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = clientIp(req);
  let entry = ipHits.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
  }
  entry.count += 1;
  ipHits.set(ip, entry);

  // Keep the map from growing forever.
  if (ipHits.size > 10000) {
    for (const [key, value] of ipHits) {
      if (now - value.windowStart > RATE_LIMIT_WINDOW_MS) ipHits.delete(key);
    }
  }

  if (entry.count > RATE_LIMIT_MAX) {
    console.warn(`[rate-limit] ${ip} exceeded ${RATE_LIMIT_MAX} req/h on ${req.path}`);
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }
  next();
}

app.use(["/api/generate", "/api/spotify/genre", "/api/spotify/track-features"], rateLimit, checkAppKey);

const youtube = createYouTubeMetadata({ apiKey: YOUTUBE_API_KEY, clientIp });
app.get("/api/youtube/:videoId", youtube.rateLimit, checkAppKey, youtube.handleMetadata);

// ─── Model ID remapping ───────────────────────────────────────────────────────
// OpenRouter periodically deprecates model IDs. We remap old IDs to current
// valid ones so the iOS app keeps working without forcing every user to update.
const MODEL_REMAP = {
  // Old Gemini IDs → Gemini 3.1 Flash Lite (newer, cheaper, better)
  "google/gemini-flash-1.5":      "google/gemini-3.1-flash-lite",
  "google/gemini-1.5-flash":      "google/gemini-3.1-flash-lite",
  "google/gemini-2.0-flash-001":  "google/gemini-3.1-flash-lite",
  "google/gemini-2.5-flash":      "google/gemini-3.1-flash-lite",
  // Old DeepSeek IDs → DeepSeek V4 Flash (2-3x cheaper, better quality)
  "deepseek/deepseek-chat":       "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-chat-v3.1":  "deepseek/deepseek-v4-flash",
  // Keep Sonnet 4.6 distinct: shipped PRO clients use it after Opus 4.8 fails.
  // Opus 4.8 → Sonnet 5 (cost control, 10 sept 2026: $5/$25 → $2/$10, ~60%
  // cheaper per PRO lyrics generation; Sonnet 5 quality validated in prod
  // since July via the 4.6 remap). Revert = delete this line.
  "anthropic/claude-opus-4.8":    "anthropic/claude-sonnet-5",
  "mistralai/mistral-small-3.1":  "mistralai/mistral-small-3.2-24b-instruct-2506",
};

function remapModel(modelId) {
  return MODEL_REMAP[modelId] || modelId;
}

// Mobile callers have 60–75s idle timeouts and expect one complete JSON response. Sonnet 5
// enables high-effort thinking by default; in production this spent >180s on
// reasoning while the phone retried. Retain the model but disable extended
// thinking for this synchronous endpoint and leave room for both song variants.
function prepareGenerationBody(body) {
  const prepared = { ...body, model: remapModel(body.model), stream: false };
  if (["anthropic/claude-sonnet-5", "anthropic/claude-sonnet-4.6"].includes(prepared.model)) {
    delete prepared.reasoning_effort;
    delete prepared.include_reasoning;
    delete prepared.max_completion_tokens;
    prepared.reasoning = { enabled: false };
    const requestedLimit = body.max_completion_tokens ?? body.max_tokens;
    prepared.max_tokens = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 8192)
      : 8192;
    // Prefer throughput without opting into a more expensive service tier.
    // Preserve client privacy/provider restrictions and any tighter price caps.
    const provider = body.provider || {};
    const prices = prepared.model === "anthropic/claude-sonnet-5"
      ? { prompt: 2, completion: 10 } : { prompt: 3, completion: 15 };
    const maxPrice = { ...provider.max_price };
    for (const [kind, cap] of Object.entries(prices)) {
      const requested = Number(maxPrice[kind]);
      maxPrice[kind] = Number.isFinite(requested) && requested >= 0
        ? Math.min(requested, cap) : cap;
    }
    prepared.provider = { ...provider, sort: provider.sort || "throughput", max_price: maxPrice };
  }
  return addAnthropicCacheControl(prepared);
}

// A large Romanian/Humanizer request was still producing useful output at 50s.
// Keep the connection alive below the shipped clients' idle timeouts while
// allowing a bounded 120s for a complete result. This is NOT an overall app SLA.
const GENERATION_TIMEOUT_MS = 120_000;
const GENERATION_HEARTBEAT_MS = 10_000;
const RETRY_COOLDOWN_MS = 60_000;
const failedGenerations = new Map();
const fingerprintSecret = randomBytes(32);

function canonicalJSON(value) {
  if (Array.isArray(value)) return value.map(canonicalJSON);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJSON(value[key])]));
  }
  return value;
}

function generationFingerprint(req) {
  // The shipped app re-encodes JSON and changes only model on fallback. Ignore
  // model and canonicalize key order so a timeout cannot cause six paid copies.
  // Store only a per-process HMAC, scoped to the caller; never store song text.
  const { model, ...request } = req.body;
  const scoped = [clientIp(req), req.get("X-App-Key") || "", req.get("Authorization") || "", request];
  return createHmac("sha256", fingerprintSecret).update(JSON.stringify(canonicalJSON(scoped))).digest("hex");
}

function blockImmediateRetry(key) {
  const now = Date.now();
  for (const [entry, expires] of failedGenerations) {
    if (expires <= now) failedGenerations.delete(entry);
  }
  if (failedGenerations.size >= 1000) failedGenerations.delete(failedGenerations.keys().next().value);
  failedGenerations.set(key, now + RETRY_COOLDOWN_MS);
}

function sendGenerationJSON(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  // After heartbeat bytes, HTTP status is already 200. Include an explicit
  // error/code in failures; never fabricate choices or return partial lyrics.
  // JSONDecoder/response.json accept leading JSON whitespace without changes.
  if (res.headersSent) {
    const payload = status >= 400 ? { error: body?.error || "AI provider request failed.",
      code: body?.code || "generation_failed", status, retry_after: body?.retry_after } : body;
    return res.end(JSON.stringify(payload));
  }
  return res.status(status).json(body);
}

// ─── Anthropic prompt caching ─────────────────────────────────────────────────
// The app sends huge, mostly-static instruction blocks on every call (~13k
// tokens/request on average). Anthropic bills cached input at 10% of the base
// price (cache write = 1.25x, 5-minute TTL refreshed on every hit), so marking
// the static prefix with a cache_control breakpoint makes repeated calls within
// a session much cheaper. Only applied to anthropic/* models; other providers
// receive the body untouched. Content arrays (multimodal) are left as-is.
//
// Strategy per message:
//  - system messages: cache the whole block (static per app version).
//  - user messages: the lyrics builder appends its dynamic tail after a fixed
//    "STYLE DNA" separator — split there so the big static prefix caches and
//    the per-song tail stays uncached. Other long user messages are cached as
//    a whole (a miss costs +25% on that message only, a hit saves 90%).
// Anthropic ignores breakpoints on content shorter than its minimum (1024
// tokens Sonnet/Opus, 2048 Haiku) — harmless, so we only skip tiny strings.
const CACHE_MIN_CHARS = 3000;
const LYRICS_TAIL_MARKER = "\n---\n\nSTYLE DNA";

function cacheBlock(text) {
  return { type: "text", text, cache_control: { type: "ephemeral" } };
}

function addAnthropicCacheControl(body) {
  if (!body || typeof body.model !== "string" || !body.model.startsWith("anthropic/")) return body;
  if (!Array.isArray(body.messages)) return body;

  let breakpoints = 0; // Anthropic allows max 4 per request
  const messages = body.messages.map((msg) => {
    if (breakpoints >= 3 || !msg || typeof msg.content !== "string") return msg;
    const text = msg.content;
    if (text.length < CACHE_MIN_CHARS) return msg;

    if (msg.role === "system") {
      breakpoints += 1;
      return { ...msg, content: [cacheBlock(text)] };
    }

    if (msg.role === "user") {
      const idx = text.indexOf(LYRICS_TAIL_MARKER);
      breakpoints += 1;
      if (idx > CACHE_MIN_CHARS) {
        // Static rules prefix (cached) + dynamic per-song tail (uncached)
        return { ...msg, content: [cacheBlock(text.slice(0, idx)), { type: "text", text: text.slice(idx) }] };
      }
      return { ...msg, content: [cacheBlock(text)] };
    }
    return msg;
  });

  return { ...body, messages };
}

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "Prompt Maschine proxy is running.",
    revision: process.env.RENDER_GIT_COMMIT || "local",
  });
});

// Proxy endpoint - iOS app calls this instead of OpenRouter directly
const handleLyrics = createLyricsHandler({ apiKey: OPENROUTER_API_KEY,
  prepareBody: prepareGenerationBody, blockRetry: blockImmediateRetry, sendJSON: sendGenerationJSON });
app.post("/api/generate", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: "Server misconfiguration: missing API key." });
  }

  if (typeof req.body?.model !== "string" || !req.body.model.trim()
      || !Array.isArray(req.body.messages) || req.body.messages.length === 0) {
    return res.status(400).json({ error: "A model and non-empty messages array are required." });
  }

  const fingerprint = generationFingerprint(req);
  const retryUntil = failedGenerations.get(fingerprint) || 0;
  if (retryUntil > Date.now()) {
    const retryAfter = Math.ceil((retryUntil - Date.now()) / 1000);
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "The previous identical generation did not finish. Please wait before retrying.",
      code: "generation_retry_cooldown", retry_after: retryAfter });
  }
  failedGenerations.delete(fingerprint);

  if (isLyricsGeneration(req.body)) return handleLyrics(req, res, fingerprint);

  const outboundBody = prepareGenerationBody(req.body);
  const requestId = randomUUID();
  res.set("X-Generation-Request-Id", requestId);
  const startedAt = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  // res.close fires when the caller disconnects, including after the request
  // body has been received. req.close would also fire on normal body completion.
  const onDisconnect = () => {
    if (!res.writableEnded) {
      blockImmediateRetry(fingerprint);
      controller.abort();
    }
  };
  res.on("close", onDisconnect);
  const timeout = setTimeout(() => {
    timedOut = true;
    blockImmediateRetry(fingerprint);
    controller.abort();
  }, GENERATION_TIMEOUT_MS);
  const heartbeat = setInterval(() => {
    if (controller.signal.aborted || res.destroyed || res.writableEnded) return;
    if (!res.headersSent) {
      res.status(200).set({ "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" });
    }
    // Whitespace is valid before a JSON object. A 1KB chunk also avoids tiny
    // writes being coalesced by intermediaries. This is not SSE or partial JSON.
    res.write(" ".repeat(1023) + "\n");
  }, GENERATION_HEARTBEAT_MS);
  console.log(`[generate] start id=${requestId} requested=${req.body.model} model=${outboundBody.model}`);

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(outboundBody),
      signal: controller.signal,
    });

    const data = await response.json();
    if (controller.signal.aborted) throw new Error("Generation aborted");

    if (!response.ok) {
      console.warn(`[generate] upstream_error model=${outboundBody.model} status=${response.status} elapsed_ms=${Date.now() - startedAt}`);
      return sendGenerationJSON(res, response.status, data);
    }

    // OpenRouter can return an error payload after HTTP headers are sent.
    // Never pass an empty/truncated response to the app as a successful song.
    const choice = data?.choices?.[0];
    if (data?.error || !choice?.message?.content || choice.finish_reason === "length") {
      console.warn(`[generate] incomplete model=${outboundBody.model} elapsed_ms=${Date.now() - startedAt}`);
      return sendGenerationJSON(res, 502, { error: "AI returned an incomplete response. Please try again.", code: "generation_incomplete" });
    }

    // Cache telemetry (visible in Render logs): how much of the prompt hit cache
    const u = data?.usage;
    if (u?.prompt_tokens_details) {
      const cached = u.prompt_tokens_details.cached_tokens || 0;
      const written = u.prompt_tokens_details.cache_write_tokens || 0;
      console.log(`[cache] ${outboundBody.model} prompt=${u.prompt_tokens} cached=${cached} written=${written} cost=${u.cost ?? "?"}`);
    }

    console.log(`[generate] complete id=${requestId} model=${outboundBody.model} elapsed_ms=${Date.now() - startedAt} reasoning_tokens=${u?.completion_tokens_details?.reasoning_tokens ?? 0}`);
    return sendGenerationJSON(res, 200, data);
  } catch (err) {
    if (controller.signal.aborted) {
      console.warn(`[generate] ${timedOut ? "timeout" : "client_disconnected"} id=${requestId} model=${outboundBody.model} elapsed_ms=${Date.now() - startedAt}`);
      if (res.destroyed || res.writableEnded) return;
      return sendGenerationJSON(res, 504, { error: "AI generation timed out. Please wait one minute before trying again.", code: "generation_timeout", retry_after: 60 });
    }
    console.error(`[generate] proxy_error model=${outboundBody.model} elapsed_ms=${Date.now() - startedAt}`, err.message);
    if (res.destroyed || res.writableEnded) return;
    return sendGenerationJSON(res, 500, { error: "Proxy request failed.", code: "generation_proxy_error" });
  } finally {
    clearTimeout(timeout);
    clearInterval(heartbeat);
    res.off("close", onDisconnect);
  }
});

app.post("/api/spotify/genre", async (req, res) => {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return res.status(500).json({ error: "Server misconfiguration: missing Spotify credentials." });
  }

  const youtubeTitle = String(req.body?.youtubeTitle || "").trim();
  const youtubeChannel = String(req.body?.youtubeChannel || "").trim();
  if (!youtubeTitle && !youtubeChannel) {
    return res.status(400).json({ error: "Missing youtubeTitle or youtubeChannel." });
  }

  try {
    const candidates = unique([
      cleanArtistName(youtubeChannel),
      artistFromTitle(youtubeTitle),
    ].filter(Boolean));

    for (const artist of candidates) {
      const genre = await lookupArtistGenre(artist);
      if (genre) return res.json({ genre, source: "spotify_artist", artist });
    }

    const trackGenre = await lookupTrackGenre(youtubeTitle);
    if (trackGenre) return res.json({ genre: trackGenre, source: "spotify_track" });

    return res.json({ genre: null });
  } catch (err) {
    console.error("Spotify genre error:", err);
    return res.status(500).json({ error: "Spotify genre lookup failed." });
  }
});

app.post("/api/spotify/track-features", async (req, res) => {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return res.status(500).json({ error: "Server misconfiguration: missing Spotify credentials." });
  }

  const youtubeTitle = String(req.body?.youtubeTitle || "").trim();
  const youtubeChannel = String(req.body?.youtubeChannel || "").trim();
  if (!youtubeTitle && !youtubeChannel) {
    return res.status(400).json({ error: "Missing youtubeTitle or youtubeChannel." });
  }

  const cacheKey = normalize(`${youtubeTitle} ${youtubeChannel}`);
  const cached = trackFeatureCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < 24 * 60 * 60 * 1000) {
    return res.json(cached.value);
  }

  try {
    const token = await getSpotifyAccessToken();
    const track = await searchBestTrack(youtubeTitle, youtubeChannel, token);
    if (!track?.id) {
      const empty = { trackId: null, trackName: null, artistName: null, genres: [] };
      trackFeatureCache.set(cacheKey, { savedAt: Date.now(), value: empty });
      return res.json(empty);
    }

    const genres = await lookupGenresForTrack(track);
    const artistName = (track.artists || []).map((artist) => artist.name).filter(Boolean).join(", ");
    const lastfmTags = await lookupLastFmTags(track.name || youtubeTitle, artistName || youtubeChannel);
    const responseBody = {
      trackId: track.id,
      trackName: track.name || "",
      artistName,
      genres,
    };
    if (lastfmTags.length) {
      responseBody.lastfmTags = lastfmTags;
      const lastfmGenre = mapSpotifyGenres(lastfmTags);
      if (lastfmGenre && !responseBody.genre) responseBody.genre = lastfmGenre;
    }

    const audioFeatures = await lookupAudioFeatures(track.id, token);
    if (audioFeatures) {
      responseBody.audioFeatures = audioFeatures;
    }

    trackFeatureCache.set(cacheKey, { savedAt: Date.now(), value: responseBody });
    return res.json(responseBody);
  } catch (err) {
    console.error("Spotify track-features error:", err);
    return res.status(500).json({ error: "Spotify track feature lookup failed." });
  }
});

async function getSpotifyAccessToken() {
  if (spotifyAccessToken && Date.now() < spotifyTokenExpiresAt) {
    return spotifyAccessToken;
  }

  const basic = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64");
  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Spotify token request failed: ${response.status} ${JSON.stringify(data)}`);
  }

  spotifyAccessToken = data.access_token;
  spotifyTokenExpiresAt = Date.now() + Math.max(60, (data.expires_in || 3600) - 60) * 1000;
  return spotifyAccessToken;
}

async function lookupArtistGenre(artistName) {
  const token = await getSpotifyAccessToken();
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", artistName);
  url.searchParams.set("type", "artist");
  url.searchParams.set("limit", "5");

  const data = await spotifyGet(url, token);
  const items = data?.artists?.items || [];
  const target = normalize(artistName);
  const best = items.find((item) => normalize(item.name || "") === target)
    || items.find((item) => {
      const name = normalize(item.name || "");
      return name.includes(target) || target.includes(name);
    });

  const genre = mapSpotifyGenres(best?.genres || []);
  if (genre) return genre;
  if (best?.id) return lookupArtistGenreById(best.id);
  return null;
}

async function lookupTrackGenre(title) {
  const cleanedTitle = cleanTrackQuery(title);
  if (!cleanedTitle) return null;

  const token = await getSpotifyAccessToken();
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", cleanedTitle);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", "3");

  const data = await spotifyGet(url, token);
  const tracks = data?.tracks?.items || [];
  for (const track of tracks) {
    for (const artist of track.artists || []) {
      if (!artist.id) continue;
      const genre = await lookupArtistGenreById(artist.id);
      if (genre) return genre;
    }
  }
  return null;
}

async function searchBestTrack(youtubeTitle, youtubeChannel, token) {
  const cleanedArtist = cleanArtistName(youtubeChannel);
  const titleArtist = artistFromTitle(youtubeTitle);
  const cleanedTitle = cleanTrackQuery(youtubeTitle, cleanedArtist || titleArtist);
  const queries = unique([
    cleanedTitle && cleanedArtist ? `${cleanedTitle} ${cleanedArtist}` : "",
    cleanedTitle && cleanedArtist ? `track:${cleanedTitle} artist:${cleanedArtist}` : "",
    cleanedTitle,
    youtubeTitle,
  ].filter(Boolean));

  const targetArtist = normalize(cleanedArtist || titleArtist);
  const targetTitle = normalize(cleanedTitle);
  let bestTrack = null;
  let bestScore = -1;

  for (const query of queries) {
    const url = new URL("https://api.spotify.com/v1/search");
    url.searchParams.set("q", query);
    url.searchParams.set("type", "track");
    url.searchParams.set("limit", "5");

    const data = await spotifyGet(url, token);
    const tracks = data?.tracks?.items || [];
    if (!tracks.length) continue;

    for (const track of tracks) {
      const score = scoreTrackMatch(track, targetTitle, targetArtist);
      if (score > bestScore) {
        bestTrack = track;
        bestScore = score;
      }
    }

    if (bestScore >= 80) return bestTrack;
  }

  return bestTrack;
}

function scoreTrackMatch(track, targetTitle, targetArtist) {
  let score = 0;
  const trackTitle = normalize(track.name || "");
  if (targetTitle && trackTitle === targetTitle) score += 60;
  else if (targetTitle && (trackTitle.includes(targetTitle) || targetTitle.includes(trackTitle))) score += 40;

  if (targetArtist) {
      const artistNames = (track.artists || []).map((artist) => normalize(artist.name || ""));
    if (artistNames.some((name) => name === targetArtist)) score += 60;
    else if (artistNames.some((name) => name.includes(targetArtist) || targetArtist.includes(name))) score += 35;
    else score -= 25;
  }

  return score;
}

async function lookupGenresForTrack(track) {
  const genres = [];
  for (const artist of track.artists || []) {
    if (!artist.id) continue;
    try {
      const token = await getSpotifyAccessToken();
      const data = await spotifyGet(`https://api.spotify.com/v1/artists/${artist.id}`, token);
      for (const genre of data?.genres || []) {
        if (genre && !genres.includes(genre)) genres.push(genre);
      }
    } catch (err) {
      console.warn(`Spotify artist genre skipped for ${artist.id}: ${err.message}`);
    }
  }
  return genres;
}

async function lookupAudioFeatures(trackId, token) {
  const response = await fetch(`https://api.spotify.com/v1/audio-features/${trackId}`, {
    headers: { "Authorization": `Bearer ${token}` },
  });

  if (response.status === 401 || response.status === 403) {
    console.warn(`Spotify audio-features unavailable: ${response.status}`);
    return null;
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Spotify audio-features failed: ${response.status} ${JSON.stringify(data)}`);
  }

  return {
    tempo: data.tempo,
    energy: data.energy,
    valence: data.valence,
    danceability: data.danceability,
    acousticness: data.acousticness,
    instrumentalness: data.instrumentalness,
    liveness: data.liveness,
    loudness: data.loudness,
    speechiness: data.speechiness,
    key: data.key,
    mode: data.mode,
    timeSignature: data.time_signature,
    durationMs: data.duration_ms,
  };
}

async function lookupLastFmTags(trackName, artistName) {
  if (!LASTFM_API_KEY || !trackName || !artistName) return [];

  const primaryArtist = String(artistName).split(",")[0].trim();
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  url.searchParams.set("method", "track.gettoptags");
  url.searchParams.set("artist", primaryArtist);
  url.searchParams.set("track", trackName);
  url.searchParams.set("api_key", LASTFM_API_KEY);
  url.searchParams.set("format", "json");
  url.searchParams.set("autocorrect", "1");

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) {
      console.warn(`Last.fm tags unavailable: ${response.status} ${JSON.stringify(data)}`);
      return [];
    }

    const tags = data?.toptags?.tag || [];
    return tags
      .map((tag) => String(tag.name || "").trim())
      .filter(Boolean)
      .slice(0, 12);
  } catch (err) {
    console.warn(`Last.fm tags failed: ${err.message}`);
    return [];
  }
}

async function lookupArtistGenreById(artistId) {
  const token = await getSpotifyAccessToken();
  const data = await spotifyGet(`https://api.spotify.com/v1/artists/${artistId}`, token);
  return mapSpotifyGenres(data?.genres || []);
}

async function spotifyGet(url, token) {
  const response = await fetch(url, {
    headers: { "Authorization": `Bearer ${token}` },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Spotify request failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

function mapSpotifyGenres(genres) {
  const joined = genres.join(" ").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (!joined) return null;

  if (joined.includes("manele") || joined.includes("manea")) return "Manele";
  if (joined.includes("romanian folk") || joined.includes("folclor") || joined.includes("muzica populara")) return "Romanian Folklore";
  if (joined.includes("romanian pop") || joined.includes("ro-pop")) return "Romanian Pop";
  if (joined.includes("k-rock") || joined.includes("korean rock") || joined.includes("korean indie") || joined.includes("korean pop rock")) return "K-Rock / Pop Rock";
  if (joined.includes("k-pop") || joined.includes("kpop") || joined.includes("korean pop")) return "K-Pop";
  if (joined.includes("country")) return "Country";
  if (joined.includes("trap")) return "Trap";
  if (joined.includes("hip hop") || joined.includes("hip-hop") || joined.includes("rap")) return "Hip-Hop / Rap";
  if (joined.includes("r&b") || joined.includes("rnb") || joined.includes("soul")) return "R&B / Soul";
  if (joined.includes("metal")) return "Metal";
  if (joined.includes("progressive rock")) return "Progressive Rock";
  if (joined.includes("classic rock") || joined.includes("rock and roll")) return "Classic Rock";
  if (joined.includes("indie rock") || joined.includes("alternative rock") || joined.includes("pop rock") || joined.includes("rock")) return "Rock";
  if (joined.includes("folk")) return "Folk";
  if (joined.includes("reggaeton") || joined.includes("latin trap")) return "Reggaeton / Latin";
  if (joined.includes("latin")) return "Latin Pop";
  if (joined.includes("reggae")) return "Reggae";
  if (joined.includes("edm") || joined.includes("dance")) return "EDM / Dance";
  if (joined.includes("electronic") || joined.includes("house") || joined.includes("techno")) return "Electronic / House";
  if (joined.includes("pop")) return "Pop";
  if (joined.includes("jazz")) return "Jazz";
  if (joined.includes("blues")) return "Blues";
  if (joined.includes("classical") || joined.includes("orchestral")) return "Cinematic / Classical";
  return null;
}

function cleanArtistName(channel) {
  return channel
    .replace(/ - Topic/gi, "")
    .replace(/VEVO/gi, "")
    .replace(/Official/gi, "")
    .trim();
}

function artistFromTitle(title) {
  const index = title.indexOf(" - ");
  return index >= 0 ? title.slice(0, index).trim() : "";
}

function cleanTrackQuery(title, artistName = "") {
  let cleaned = String(title || "")
    .replace(/\(official video\)|\[official video\]|\(official music video\)|official video|official music video|\(lyrics\)|\[lyrics\]|lyrics|\(visualizer\)|visualizer|\(audio\)|audio/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  const dashArtist = artistFromTitle(cleaned);
  if (dashArtist) {
    cleaned = cleaned.slice(cleaned.indexOf(" - ") + 3).trim();
  }

  const normalizedArtist = normalize(artistName || dashArtist);
  if (normalizedArtist && normalize(cleaned).startsWith(normalizedArtist)) {
    cleaned = cleaned.slice(String(artistName || dashArtist).length).trim();
  }

  return cleaned.replace(/^[-–:|]+|[-–:|]+$/g, "").trim();
}

function normalize(text) {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[ \-_.''’()[\]]/g, "");
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = normalize(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Privacy Policy page — linked from the app's paywall (App Review 3.1.2(c)
// requires a FUNCTIONAL privacy policy link inside the app).
app.get("/privacy", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Prompt Maschine — Privacy Policy</title>
<style>body{font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}h1{font-size:1.6em}h2{font-size:1.15em;margin-top:1.6em}</style>
</head><body>
<h1>Prompt Maschine — Privacy Policy</h1>
<p><em>Last updated: August 6, 2026</em></p>
<p>Prompt Maschine ("the app") is developed by Traian Arion. This policy explains what data the app handles and how.</p>
<h2>What we collect</h2>
<p><b>Account data.</b> If you sign in (Apple or Google), we receive your name and email address, used only to identify your account. You may also use the app as a guest.</p>
<p><b>Usage analytics.</b> We collect anonymous usage data via Firebase Analytics (screens viewed, feature usage, subscription tier, device identifier for analytics). This data is not linked to your identity and is used solely to improve the app.</p>
<p><b>Content you submit.</b> Song ideas, YouTube links or audio you analyze are sent to our server and to AI providers strictly to generate your prompts and lyrics. They are processed transiently and are not used to train models by us, sold, or shared for advertising.</p>
<h2>What we do NOT do</h2>
<p>We do not sell your data. We do not show ads. We do not share personal data with third parties except the processors needed to run the service (Apple, Google/Firebase, our hosting provider Render, and AI model providers via OpenRouter).</p>
<h2>Subscriptions</h2>
<p>Payments are processed entirely by Apple through your Apple ID. We never see your payment details. Manage or cancel anytime in Settings → Apple ID → Subscriptions.</p>
<h2>Data retention & deletion</h2>
<p>Saved prompts and lyrics are stored locally on your device. Account data is retained while your account exists. To delete your account and associated data, use "Delete Account" in the app's Settings or contact us.</p>
<h2>Children</h2>
<p>The app is rated 4+ and does not knowingly collect personal data from children.</p>
<h2>Contact</h2>
<p>Questions or data requests: <a href="mailto:nickarion2002@yahoo.com">nickarion2002@yahoo.com</a></p>
<h2>Terms of Use</h2>
<p>The app uses Apple's standard <a href="https://www.apple.com/legal/internet-services/itunes/dev/stdeula/">Terms of Use (EULA)</a>.</p>
</body></html>`);
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Proxy running on port ${PORT}`);
  });
}

module.exports = { app, prepareGenerationBody, GENERATION_TIMEOUT_MS, GENERATION_HEARTBEAT_MS };
