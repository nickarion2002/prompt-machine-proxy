const express = require("express");
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;

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
  "mistralai/mistral-small-3.1":  "mistralai/mistral-small-3.2-24b-instruct-2506",
};

function remapModel(modelId) {
  return MODEL_REMAP[modelId] || modelId;
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Prompt Maschine proxy is running." });
});

// Proxy endpoint - iOS app calls this instead of OpenRouter directly
app.post("/api/generate", async (req, res) => {
  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: "Server misconfiguration: missing API key." });
  }

  // Remap deprecated model IDs to current valid ones
  const remappedBody = { ...req.body };
  if (remappedBody.model) {
    const remapped = remapModel(remappedBody.model);
    if (remapped !== remappedBody.model) {
      console.log(`[generate] Remapped ${remappedBody.model} -> ${remapped}`);
      remappedBody.model = remapped;
    }
  }

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(remappedBody),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.json(data);
  } catch (err) {
    console.error("Proxy error:", err);
    return res.status(500).json({ error: "Proxy request failed." });
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

app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});
