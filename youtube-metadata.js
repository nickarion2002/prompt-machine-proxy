const YOUTUBE_TIMEOUT_MS = 8_000;
const YOUTUBE_CACHE_MS = 24 * 60 * 60 * 1000;
const YOUTUBE_EMPTY_CACHE_MS = 60 * 60 * 1000;
const YOUTUBE_RATE_LIMIT_MAX = 120;
const YOUTUBE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;

function createYouTubeMetadata({ apiKey, clientIp }) {
  // These counters are deliberately separate from generation and Spotify.
  const ipHits = new Map();
  const cache = new Map();

  function rateLimit(req, res, next) {
    const now = Date.now();
    const ip = clientIp(req);
    let entry = ipHits.get(ip);
    if (!entry || now - entry.windowStart >= YOUTUBE_RATE_LIMIT_WINDOW_MS) {
      entry = { windowStart: now, count: 0 };
    }
    entry.count += 1;
    ipHits.set(ip, entry);
    if (ipHits.size > 10000) {
      for (const [key, value] of ipHits) {
        if (now - value.windowStart >= YOUTUBE_RATE_LIMIT_WINDOW_MS) ipHits.delete(key);
      }
    }
    if (entry.count > YOUTUBE_RATE_LIMIT_MAX) {
      return res.status(429).json({ error: "Too many requests. Try again later." });
    }
    next();
  }

  async function lookup(videoId) {
    if (!apiKey) return { items: [] };
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("id", videoId);
    url.searchParams.set("key", apiKey);
    const controller = new AbortController();
    let timer;
    try {
      // Include the body read in the deadline, even if transport ignores abort.
      // Neither this URL nor upstream errors may be logged: they can contain the key.
      return await Promise.race([
        new Promise(resolve => {
          timer = setTimeout(() => {
            resolve({ items: [] });
            controller.abort();
          }, YOUTUBE_TIMEOUT_MS);
        }),
        (async () => {
          const response = await fetch(url, { signal: controller.signal });
          if (!response.ok) {
            response.body?.cancel().catch(() => {});
            return { items: [] };
          }
          const data = await response.json();
          if (data?.error || !Array.isArray(data?.items) || !data.items.length) {
            return { items: [] };
          }
          // A provider or intermediary must never reflect the credential to callers.
          if (JSON.stringify(data).includes(apiKey)) return { items: [] };
          return data;
        })(),
      ]);
    } catch {
      return { items: [] };
    } finally {
      clearTimeout(timer);
    }
  }

  async function handleMetadata(req, res) {
    const videoId = req.params.videoId;
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ error: "Invalid video ID." });
    }
    const cached = cache.get(videoId);
    if (cached && cached.expiresAt > Date.now()) return res.json(cached.data);
    cache.delete(videoId);

    const data = await lookup(videoId);
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(key);
    }
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    // Only the winning result is cached; a late response cannot replace a timeout.
    cache.set(videoId, {
      data,
      expiresAt: now + (data.items.length ? YOUTUBE_CACHE_MS : YOUTUBE_EMPTY_CACHE_MS),
    });
    if (!res.destroyed && !res.writableEnded) return res.json(data);
  }

  return { rateLimit, handleMetadata };
}

module.exports = {
  createYouTubeMetadata, YOUTUBE_TIMEOUT_MS, YOUTUBE_CACHE_MS, YOUTUBE_EMPTY_CACHE_MS,
  YOUTUBE_RATE_LIMIT_MAX, YOUTUBE_RATE_LIMIT_WINDOW_MS,
};
