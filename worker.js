// =============================================================================
// SPARTAN NEWS API WORKER (SUPABASE AUTHENTICATION)
// =============================================================================

const SITE_URL = "https://shsnews.live";

const GAMES = [
  {
    id: "default-coopersville-jv",
    date: "2026-10-01 18:00",
    sport: "Football",
    level: "JV",
    gender: "Boys",
    opponent: "Coopersville",
    home: true,
    location: "Spartan Stadium",
    status: "scheduled",
  },
];

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SUB_RE = /^[0-9a-fA-F-]{36}$/;
const MAX_PINS_PER_GAME = 2000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // -------------------------------------------------------------------------
    // 1. YOUTUBE LIVE STATUS AND UPCOMING STREAMS
    // -------------------------------------------------------------------------
    if (url.pathname === "/check-live" || url.pathname === "/upcoming-streams") {
      if (request.method !== "GET") return json({ error: "GET only" }, 405, corsHeaders);

      const handle = (url.searchParams.get("handle") || "SpartanNewsLive").replace(/^@/, "");
      if (handle.toLowerCase() !== "spartannewslive") {
        return json({ error: "Unsupported YouTube channel" }, 400, corsHeaders);
      }

      const apiKey = env.YOUTUBE_API_KEY || env.VITE_YOUTUBE_API_KEY;
      if (!apiKey) {
        return json({ error: "Missing YOUTUBE_API_KEY in Worker env" }, 500, corsHeaders);
      }

      try {
        const isUpcomingRequest = url.pathname === "/upcoming-streams";
        const eventType = isUpcomingRequest ? "upcoming" : "live";
        const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
        searchUrl.search = new URLSearchParams({
          part: "snippet",
          channelId: "UCMbRanNiBOBeop8qZkBAwlA",
          eventType,
          maxResults: "25",
          type: "video",
          videoEmbeddable: "true",
          key: apiKey,
        }).toString();

        const searchData = await fetchYouTubeApiJson(
          searchUrl.toString(),
          `streams-${eventType}-UCMbRanNiBOBeop8qZkBAwlA`,
          isUpcomingRequest ? 3600 : 300,
          ctx
        );
        const searchItems = searchData.items || [];

        if (!isUpcomingRequest) {
          const stream = searchItems[0];
          return json(
            {
              isLive: Boolean(stream),
              videoId: stream ? stream.id.videoId : null,
              title: stream ? stream.snippet.title : "",
            },
            200,
            { ...corsHeaders, "Cache-Control": "public, max-age=30" }
          );
        }

        const videoIds = searchItems
          .map((item) => item.id && item.id.videoId)
          .filter(Boolean);

        if (!videoIds.length) {
          return json({ items: [] }, 200, { ...corsHeaders, "Cache-Control": "public, max-age=60" });
        }

        const detailsUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
        detailsUrl.search = new URLSearchParams({
          part: "liveStreamingDetails",
          id: videoIds.join(","),
          key: apiKey,
        }).toString();
        const detailsData = await fetchYouTubeApiJson(
          detailsUrl.toString(),
          `stream-details-${videoIds.sort().join(",")}`,
          3600,
          ctx
        );
        const startTimes = new Map(
          (detailsData.items || []).map((video) => [
            video.id,
            video.liveStreamingDetails && video.liveStreamingDetails.scheduledStartTime,
          ])
        );
        const now = Date.now();
        const items = searchItems
          .map((item) => {
            const scheduledStartTime = startTimes.get(item.id.videoId);
            if (!scheduledStartTime || Date.parse(scheduledStartTime) <= now) return null;

            return {
              id: item.id.videoId,
              title: item.snippet.title,
              scheduledStartTime,
              scheduledTime: new Intl.DateTimeFormat("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                timeZone: "America/Detroit",
              }).format(new Date(scheduledStartTime)),
            };
          })
          .filter(Boolean)
          .sort((a, b) => Date.parse(a.scheduledStartTime) - Date.parse(b.scheduledStartTime));

        return json({ items }, 200, { ...corsHeaders, "Cache-Control": "public, max-age=60" });
      } catch (err) {
        console.error("YouTube live data request failed:", err);
        return json({ error: err.message || "YouTube live data request failed" }, 502, corsHeaders);
      }
    }

    // -------------------------------------------------------------------------
    // 2. YOUTUBE CHANNEL FEED PROXY (/youtube-feed)
    // -------------------------------------------------------------------------
    if (url.pathname === "/youtube-feed") {
      try {
        const handle = url.searchParams.get("handle") || "spartannewsdaily8847";
        const formattedHandle = handle.startsWith("@") ? handle : `@${handle}`;
        const apiKey = env.YOUTUBE_API_KEY || env.VITE_YOUTUBE_API_KEY;

        if (!apiKey) {
          return json({ error: "Missing YOUTUBE_API_KEY in Worker env", items: [] }, 500, corsHeaders);
        }

        const channelRes = await fetch(
          `https://www.googleapis.com/youtube/v3/channels?part=id,contentDetails&forHandle=${encodeURIComponent(formattedHandle)}&key=${apiKey}`
        );
        const channelData = await channelRes.json();

        if (!channelData.items || channelData.items.length === 0) {
          return json({ error: `Channel not found for ${formattedHandle}`, items: [] }, 404, corsHeaders);
        }

        const uploadsPlaylistId = channelData.items[0].contentDetails.relatedPlaylists.uploads;

        const playlistRes = await fetch(
          `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=20&key=${apiKey}`
        );
        const playlistData = await playlistRes.json();

        if (!playlistRes.ok) {
          return json(
            { error: "Failed to fetch YouTube playlist items", details: playlistData, items: [] },
            playlistRes.status,
            corsHeaders
          );
        }

        const items = (playlistData.items || []).map((item) => ({
          id: item.snippet.resourceId.videoId,
          title: item.snippet.title,
          description: item.snippet.description,
          thumbnail:
            item.snippet.thumbnails?.high?.url ||
            item.snippet.thumbnails?.medium?.url ||
            item.snippet.thumbnails?.default?.url,
          publishedAtRaw: item.snippet.publishedAt,
          publishedAt: new Date(item.snippet.publishedAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          }),
          channelTitle: item.snippet.channelTitle,
        }));

        return json({ items }, 200, corsHeaders);
      } catch (err) {
        return json({ error: err.message || "Internal YouTube Feed Error", items: [] }, 500, corsHeaders);
      }
    }

    // -------------------------------------------------------------------------
    // 3. SCHEDULE / SCORES (/check-scores)
    // -------------------------------------------------------------------------
    if (url.pathname === "/check-scores") {
      try {
        const source = await loadRawGames(env);
        const games = source
          .map(formatGame)
          .filter(Boolean)
          .sort((a, b) => a.startTimeMs - b.startTimeMs)
          .map(({ startTimeMs, ...game }) => game);

        return new Response(JSON.stringify({ games }), {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=10",
          },
        });
      } catch (err) {
        return json({ error: `Schedule error: ${err.message}`, games: [] }, 500, corsHeaders);
      }
    }

    // -------------------------------------------------------------------------
    // 4. ADMIN API (/admin/api/games)
    // -------------------------------------------------------------------------
    if (url.pathname === "/admin/api/games") {
      const adminHeaders = { ...corsHeaders, "Cache-Control": "no-store" };

      if (!env.ADMIN_PASSWORD && !env.ADMIN_EMAILS) {
        return json(
          { error: "Admin sign-in is not configured. Set ADMIN_EMAILS on the Worker." },
          503,
          adminHeaders
        );
      }
      if (!env.SCHEDULE_KV) {
        return json(
          { error: "KV namespace is not bound. Bind one to this Worker as SCHEDULE_KV." },
          503,
          adminHeaders
        );
      }

      const who = await authorize(request, env);
      if (!who) {
        await new Promise((r) => setTimeout(r, 500));
        return json({ error: "Your account is not approved to make changes." }, 401, adminHeaders);
      }

      try {
        if (request.method === "GET") {
          const stored = await env.SCHEDULE_KV.get("games", "json");
          return json(
            { games: sanitizeGames(Array.isArray(stored) ? stored : GAMES), source: Array.isArray(stored) ? "kv" : "defaults" },
            200,
            adminHeaders
          );
        }

        if (request.method === "PUT") {
          const body = await request.json();
          const next = sanitizeGames(body.games);

          let prev = [];
          try {
            prev = sanitizeGames(await loadRawGames(env));
          } catch (e) {
            prev = [];
          }

          await env.SCHEDULE_KV.put("games", JSON.stringify(next));
          const sent = await publishChanges(env, prev, next, body.notify === true);
          return json({ games: next, source: "kv", sent }, 200, adminHeaders);
        }

        return json({ error: "Method not allowed" }, 405, adminHeaders);
      } catch (err) {
        return json({ error: err.message || "Bad request" }, 400, adminHeaders);
      }
    }

    // -------------------------------------------------------------------------
    // 5. ANDROID PIN / UNPIN (/pin, /unpin)
    // -------------------------------------------------------------------------
    if (url.pathname === "/pin" || url.pathname === "/unpin") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405, corsHeaders);
      if (!env.SCHEDULE_KV) return json({ error: "Not configured" }, 503, corsHeaders);

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "Invalid JSON" }, 400, corsHeaders);
      }

      const gameId = String(body.gameId || "");
      const subscriptionId = String(body.subscriptionId || "");
      if (!ID_RE.test(gameId) || !SUB_RE.test(subscriptionId)) {
        return json({ error: "Bad request" }, 400, corsHeaders);
      }

      try {
        const game = sanitizeGames(await loadRawGames(env)).find((g) => g.id === gameId);
        if (!game) return json({ error: "Game not found" }, 404, corsHeaders);

        const pins = await getPins(env, gameId);

        if (url.pathname === "/pin") {
          if (game.status !== "live") {
            return json({ error: "This game is not live right now." }, 409, corsHeaders);
          }
          if (!pins.includes(subscriptionId)) pins.push(subscriptionId);
          await setPins(env, gameId, pins);
          const r = await sendAndroidLive(env, game, "start", [subscriptionId]);
          return json({ ok: true, delivered: r.ok }, 200, corsHeaders);
        }

        await setPins(env, gameId, pins.filter((id) => id !== subscriptionId));
        const r = await sendAndroidLive(env, game, "end", [subscriptionId]);
        return json({ ok: true, delivered: r.ok }, 200, corsHeaders);
      } catch (err) {
        return json({ error: err.message || "Bad request" }, 400, corsHeaders);
      }
    }

    // -------------------------------------------------------------------------
    // 6. YOUTUBE LIVE WEBHOOK NOTIFIER (/youtube-webhook)
    // -------------------------------------------------------------------------
    if (url.pathname === "/youtube-webhook") {
      if (request.method === "GET") {
        const challenge = url.searchParams.get("hub.challenge");
        return new Response(challenge || "No challenge provided", { status: 200 });
      }

      if (request.method === "POST") {
        try {
          const xmlText = await request.text();
          if (xmlText.includes("<yt:videoId>") && xmlText.includes("<entry>")) {
            const entryXml = xmlText.slice(xmlText.indexOf("<entry>"));
            const videoIdMatch = entryXml.match(/<yt:videoId>(.*?)<\/yt:videoId>/);
            const titleMatch = entryXml.match(/<title>(.*?)<\/title>/);

            const videoId = videoIdMatch ? videoIdMatch[1] : null;
            const videoTitle = titleMatch ? decodeXml(titleMatch[1]) : "Spartan News Live Stream";
            const thumbnailUrl = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
            const targetUrl = `https://shsnews.live/live?v=${videoId}`;

            if (videoId && env.ONESIGNAL_APP_ID && env.ONESIGNAL_REST_KEY) {
              await fetch("https://onesignal.com/api/v1/notifications", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Basic ${env.ONESIGNAL_REST_KEY}`,
                },
                body: JSON.stringify({
                  app_id: env.ONESIGNAL_APP_ID,
                  included_segments: ["All"],
                  headings: { en: "🔴 SPARTAN NEWS IS LIVE!" },
                  contents: { en: videoTitle },
                  url: targetUrl,
                  web_url: targetUrl,
                  app_url: targetUrl,
                  big_picture: thumbnailUrl,
                  ios_attachments: thumbnailUrl ? { stream_thumb: thumbnailUrl } : undefined,
                  data: { videoId, url: targetUrl },
                }),
              });
            }
          }
        } catch (err) {
          console.error("Error handling YouTube webhook:", err);
        }
        return new Response("OK", { status: 200 });
      }
    }

    return json({ error: "Not found" }, 404, corsHeaders);
  },
};

async function fetchYouTubeApiJson(url, cacheId, maxAgeSeconds, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://shsnews.live/__youtube_cache/${encodeURIComponent(cacheId)}`);
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();

  const response = await fetch(url);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("YouTube API returned an invalid response");
  }

  if (!response.ok || data.error) {
    throw new Error(data.error && data.error.message ? data.error.message : `YouTube API error (${response.status})`);
  }

  const cacheResponse = new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `public, max-age=${maxAgeSeconds}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, cacheResponse));
  return data;
}

// -----------------------------------------------------------------------------
// SUPABASE AUTHENTICATION
// -----------------------------------------------------------------------------

async function authorize(request, env) {
  const raw = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!raw) return null;

  // Verify Supabase JWT Token format (3 dot-separated parts)
  if (raw.split(".").length === 3) {
    try {
      const payload = b64uToJson(raw.split(".")[1]);
      const email = String(payload.email || "").toLowerCase();
      
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) return null; // Expired token

      const allowed = String(env.ADMIN_EMAILS || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

      if (email && allowed.includes(email)) {
        return { via: "supabase", email };
      }
    } catch (e) {
      console.error("Failed to parse Supabase token payload:", e);
    }
  }

  // Password fallback if set
  if (env.ADMIN_PASSWORD) {
    let given = raw;
    try {
      given = decodeURIComponent(raw);
    } catch (e) {}
    if (await safeEqual(given, String(env.ADMIN_PASSWORD))) return { via: "password" };
  }

  return null;
}

function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

const b64uToJson = (s) => JSON.parse(new TextDecoder().decode(b64uToBytes(s)));

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const xa = new Uint8Array(x);
  const ya = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ ya[i];
  return diff === 0;
}

// -----------------------------------------------------------------------------
// SCHEDULE DATA & PUSH UTILITIES
// -----------------------------------------------------------------------------

async function loadRawGames(env) {
  if (env.SCHEDULE_KV) {
    try {
      const stored = await env.SCHEDULE_KV.get("games", "json");
      if (Array.isArray(stored)) return stored;
    } catch (e) {
      console.error("KV read failed, using built-in GAMES:", e);
    }
  }
  return GAMES;
}

function sanitizeGames(list) {
  if (!Array.isArray(list)) throw new Error("games must be a list");
  if (list.length > 300) throw new Error("Too many games (max 300)");

  const text = (v, max) => String(v ?? "").trim().slice(0, max);
  const num = (v) => Math.min(999, Math.max(0, parseInt(v, 10) || 0));

  return list.map((g, i) => {
    const label = text(g && g.opponent, 60) || `game #${i + 1}`;
    const date = text(g && g.date, 16).replace(" ", "T");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(date)) {
      throw new Error(`Pick a date and time for "${label}"`);
    }
    const sport = text(g.sport, 40);
    const opponent = text(g.opponent, 60);
    if (!sport) throw new Error(`Sport is required for "${label}"`);
    if (!opponent) throw new Error(`Opponent is required (game on ${date.slice(0, 10)})`);

    const status = ["scheduled", "live", "final"].includes(g.status) ? g.status : "scheduled";
    const givenId = text(g.id, 64);

    return {
      id: ID_RE.test(givenId) ? givenId : crypto.randomUUID(),
      date,
      sport,
      opponent,
      level: text(g.level, 30) || "Varsity",
      gender: text(g.gender, 10),
      home: g.home !== false,
      location: text(g.location, 80),
      status,
      spartanScore: num(g.spartanScore),
      opponentScore: num(g.opponentScore),
      clock: text(g.clock, 20),
    };
  });
}

function describeChange(prev, g) {
  const started = prev.status !== "live" && g.status === "live";
  const final = prev.status !== "final" && g.status === "final";
  const scoreChanged =
    g.status !== "scheduled" &&
    (prev.spartanScore !== g.spartanScore || prev.opponentScore !== g.opponentScore);
  const clockChanged = g.status === "live" && (prev.clock || "") !== (g.clock || "");
  return { started, final, scoreChanged, clockChanged, any: started || final || scoreChanged || clockChanged };
}

async function publishChanges(env, prev, next, notify) {
  const sent = { alerts: 0, liveActivities: 0, androidPins: 0, errors: [] };
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_KEY) {
    sent.skipped = "OneSignal is not configured on the Worker";
    return sent;
  }

  const prevById = new Map(prev.map((g) => [g.id, g]));
  const fail = (what, r) => sent.errors.push(`${what}: ${r.status} ${r.body}`.slice(0, 200));

  for (const g of next) {
    const before = prevById.get(g.id) || { status: "scheduled", spartanScore: 0, opponentScore: 0, clock: "" };
    const change = describeChange(before, g);
    if (!change.any) continue;

    try {
      if (notify && (change.started || change.final || change.scoreChanged)) {
        const kind = change.started ? "started" : change.final ? "final" : g.status === "live" ? "score" : "correction";
        const r = await sendScoreAlert(env, kind, g);
        r.ok ? sent.alerts++ : fail("alert", r);
      }

      if (g.status === "scheduled") continue;

      const la = await updateLiveActivity(env, g, g.status === "final");
      if (la.ok) sent.liveActivities++;

      const pins = await getPins(env, g.id);
      if (pins.length) {
        const r = await sendAndroidLive(env, g, "update", pins);
        r.ok ? (sent.androidPins += pins.length) : fail("android", r);
        if (g.status === "final") await setPins(env, g.id, []);
      }
    } catch (e) {
      sent.errors.push(String(e.message || e).slice(0, 200));
    }
  }
  return sent;
}

const scoreLine = (g) => `Spartans ${g.spartanScore}, ${g.opponent} ${g.opponentScore}`;
const gameLabel = (g) => `${g.sport} (${g.level})`;
const activityIdFor = (gameId) => `sparta_${gameId}`;

function alertText(kind, g) {
  switch (kind) {
    case "started":
      return {
        title: `🔴 LIVE: ${gameLabel(g)}`,
        body: g.spartanScore || g.opponentScore ? scoreLine(g) : `Spartans vs ${g.opponent} is underway.`,
      };
    case "final":
      return { title: `FINAL: ${scoreLine(g)}`, body: gameLabel(g) };
    case "correction":
      return { title: `Score corrected: ${scoreLine(g)}`, body: gameLabel(g) };
    default:
      return { title: `${gameLabel(g)}: ${scoreLine(g)}`, body: g.clock || "Score update" };
  }
}

const liveState = (g) => ({
  spartanScore: g.spartanScore,
  opponentScore: g.opponentScore,
  clock: g.status === "final" ? "FINAL" : g.clock || "",
  status: g.status,
});

function osAuthHeader(env) {
  const k = String(env.ONESIGNAL_REST_KEY || "");
  return (k.startsWith("os_v2") ? "Key " : "Basic ") + k;
}

async function osPost(env, url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: osAuthHeader(env) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, body: text.slice(0, 160) };
}

function sendScoreAlert(env, kind, g) {
  const { title, body } = alertText(kind, g);
  const target = `${SITE_URL}/scoreboard`;
  return osPost(env, "https://api.onesignal.com/notifications", {
    app_id: env.ONESIGNAL_APP_ID,
    filters: [{ field: "tag", key: "score_alerts", relation: "=", value: "1" }],
    headings: { en: title },
    contents: { en: body },
    url: target,
    web_url: target,
    app_url: target,
    collapse_id: `alert_${g.id}`.slice(0, 64),
    ttl: 3600,
    data: { type: "score", gameId: g.id },
  });
}

function updateLiveActivity(env, g, ending) {
  return osPost(
    env,
    `https://api.onesignal.com/apps/${env.ONESIGNAL_APP_ID}/live_activities/${activityIdFor(g.id)}/notifications`,
    {
      event: ending ? "end" : "update",
      event_updates: { data: liveState(g) },
      name: `Score ${g.id}`.slice(0, 100),
      priority: 10,
    }
  );
}

async function sendAndroidLive(env, g, event, subscriptionIds) {
  if (!env.ONESIGNAL_APP_ID || !env.ONESIGNAL_REST_KEY) return { ok: false, status: 0, body: "OneSignal not configured" };

  const live = {
    key: "score",
    event,
    event_attributes: {
      gameId: g.id,
      title: gameLabel(g),
      opponent: g.opponent,
      sport: g.sport,
      level: g.level,
    },
    event_updates: liveState(g),
  };

  let last = { ok: true, status: 200, body: "" };
  for (let i = 0; i < subscriptionIds.length; i += MAX_PINS_PER_GAME) {
    last = await osPost(env, "https://api.onesignal.com/notifications", {
      app_id: env.ONESIGNAL_APP_ID,
      include_subscription_ids: subscriptionIds.slice(i, i + MAX_PINS_PER_GAME),
      collapse_id: `live_${g.id}`.slice(0, 64),
      priority: 10,
      ...(event === "update" ? { ttl: 120 } : {}),
      data: { live_notification: live },
      headings: { en: "Score update" },
      contents: { en: scoreLine(g) },
    });
    if (!last.ok) break;
  }
  return last;
}

async function getPins(env, gameId) {
  if (!env.SCHEDULE_KV) return [];
  const v = await env.SCHEDULE_KV.get(`pins:${gameId}`, "json");
  return Array.isArray(v) ? v : [];
}

async function setPins(env, gameId, list) {
  if (!env.SCHEDULE_KV) return;
  if (!list.length) return env.SCHEDULE_KV.delete(`pins:${gameId}`);
  await env.SCHEDULE_KV.put(`pins:${gameId}`, JSON.stringify(list.slice(-MAX_PINS_PER_GAME)), {
    expirationTtl: 60 * 60 * 24 * 2,
  });
}

function json(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function decodeXml(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseDetroit(str) {
  const m = String(str || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;

  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi);

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Detroit",
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(new Date(utcGuess))
      .map((p) => [p.type, p.value])
  );

  const asLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute);
  return new Date(utcGuess - (asLocal - utcGuess));
}

function formatGame(g) {
  const start = parseDetroit(g.date);
  if (!start || !g.sport || !g.opponent) return null;

  const status = String(g.status || "scheduled").toLowerCase();
  const isLive = status === "live";
  const isCompleted = status === "final";
  const isFuture = !isLive && !isCompleted;

  const formattedStartTime = start.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Detroit",
  });

  const isHome = g.home !== false;
  const spartaName = "Spartans";
  const spartaScore = g.spartanScore ?? 0;
  const oppScore = g.opponentScore ?? 0;

  return {
    startTimeMs: start.getTime(),
    id: String(g.id || `${g.sport}-${g.level || "Varsity"}-${g.date}`.replace(/\s+/g, "-").toLowerCase()),
    status: isLive ? "IN_PROGRESS" : isCompleted ? "FINAL" : "SCHEDULED",
    isLive,
    isFuture,
    sport: String(g.sport).toUpperCase(),
    gender: g.gender || "",
    level: g.level || "Varsity",
    homeTeam: {
      name: isHome ? spartaName : g.opponent,
      score: isHome ? spartaScore : oppScore,
      logo: null,
    },
    awayTeam: {
      name: isHome ? g.opponent : spartaName,
      score: isHome ? oppScore : spartaScore,
      logo: null,
    },
    gameClock: isFuture ? formattedStartTime : isCompleted ? "FINAL" : g.clock || "IN PROGRESS",
    period: "",
    venue: g.location || (isHome ? "Spartan Stadium / Gym" : `AT ${g.opponent}`),
    topPlayers: [],
  };
}
