const express = require("express");
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let spotifyAccessToken = null;
let spotifyTokenExpiresAt = 0;

// ─── Model ID remapping ───────────────────────────────────────────────────────
// OpenRouter periodically deprecates model IDs. We remap old IDs to current
// valid ones so the iOS app keeps working without forcing every user to update.
const MODEL_REMAP = {
  "google/gemini-flash-1.5":      "google/gemini-2.5-flash",
  "google/gemini-1.5-flash":      "google/gemini-2.5-flash",
  "mistralai/mistral-small-3.1":  "mistralai/mistral-small-3.2-24b-instruct-2506",
  "deepseek/deepseek-chat":       "deepseek/deepseek-chat-v3.1",
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

function cleanTrackQuery(title) {
  return title
    .replace(/\(official video\)|\[official video\]|\(official music video\)|\(lyrics\)|\[lyrics\]|\(visualizer\)|\(audio\)/gi, "")
    .trim();
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
