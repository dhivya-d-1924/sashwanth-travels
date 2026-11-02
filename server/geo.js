"use strict";
/*
 * Places, road routes and weather — free, key-less public services, called only from the server
 * (cached, rate-limited, with timeouts) so the browser never talks to third parties directly.
 *   Place search : Open-Meteo Geocoding   (geocoding-api.open-meteo.com)
 *   Reverse geo  : OpenStreetMap Nominatim (nominatim.openstreetmap.org — needs a real contact in User-Agent)
 *   Road route   : OSRM                    (router.project-osrm.org demo; set GEO_ROUTER_URL for your own)
 *   Weather      : Open-Meteo Forecast     (api.open-meteo.com — up to 16 days ahead)
 * Nothing is invented: when a service can't answer, the caller gets a clear "not available".
 */
const WMO = {
  0: ["Clear sky", "sun"], 1: ["Mainly clear", "sun"], 2: ["Partly cloudy", "cloud-sun"], 3: ["Overcast", "cloud"],
  45: ["Fog", "fog"], 48: ["Freezing fog", "fog"], 51: ["Light drizzle", "drizzle"], 53: ["Drizzle", "drizzle"], 55: ["Heavy drizzle", "drizzle"],
  56: ["Freezing drizzle", "drizzle"], 57: ["Freezing drizzle", "drizzle"], 61: ["Light rain", "rain"], 63: ["Rain", "rain"], 65: ["Heavy rain", "rain"],
  66: ["Freezing rain", "rain"], 67: ["Freezing rain", "rain"], 71: ["Light snow", "snow"], 73: ["Snow", "snow"], 75: ["Heavy snow", "snow"], 77: ["Snow grains", "snow"],
  80: ["Rain showers", "rain"], 81: ["Rain showers", "rain"], 82: ["Violent rain showers", "storm"], 85: ["Snow showers", "snow"], 86: ["Snow showers", "snow"],
  95: ["Thunderstorm", "storm"], 96: ["Thunderstorm with hail", "storm"], 99: ["Thunderstorm with hail", "storm"]
};
const wmo = c => { const w = WMO[c] || ["Unknown", "cloud"]; return { text: w[0], icon: w[1] }; };
const todayIST = () => new Date(Date.now() + 5.5 * 36e5).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const haversineKm = (a, b) => { const R = 6371, r = x => x * Math.PI / 180; const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon); const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };

function createGeo({ HttpError, fetchImpl = fetch, env = process.env, contact = "" }) {
  const enabled = env.MAPS !== "off";
  const router = (env.GEO_ROUTER_URL || "https://router.project-osrm.org").replace(/\/$/, "");
  const UA = `SashwanthTravels/2.8 (${contact || env.OWNER_EMAIL || "owner@example.com"})`;
  const cache = new Map();
  const cached = async (key, ttl, fn) => {
    const hit = cache.get(key); if (hit && hit.exp > Date.now()) return hit.v;
    const v = await fn(); cache.set(key, { v, exp: Date.now() + ttl });
    if (cache.size > 3000) cache.delete(cache.keys().next().value);
    return v;
  };
  async function get(url, headers = {}) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetchImpl(url, { method: "GET", headers: { "User-Agent": UA, Accept: "application/json", ...headers }, signal: ctl.signal });
      if (!r.ok) throw new HttpError(502, "The map service didn't answer. Please try again.");
      return await r.json();
    } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(502, e.name === "AbortError" ? "The map service timed out. Please try again." : "The map service is unreachable right now."); }
    finally { clearTimeout(t); }
  }
  const need = () => { if (!enabled) throw new HttpError(503, "Maps and weather are switched off on this server."); };
  const clean = q => String(q || "").trim().replace(/\s+/g, " ").slice(0, 80);

  /* Place name → candidates (India first). */
  async function search(q) {
    need(); q = clean(q); if (q.length < 2) throw new HttpError(400, "Type at least 2 letters.");
    return cached("s:" + q.toLowerCase(), 7 * 864e5, async () => {
      const u = c => `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.split(",")[0])}&count=6&language=en&format=json${c ? "&countryCode=" + c : ""}`;
      let j = await get(u("IN"));
      if (!j.results || !j.results.length) j = await get(u(""));
      return (j.results || []).map(r => ({ name: r.name, region: r.admin1 || "", country: r.country || "", countryCode: r.country_code || "", lat: r.latitude, lon: r.longitude, tz: r.timezone || "" }));
    });
  }
  async function place(q) {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(String(q || ""));
    if (m) return { name: `${(+m[1]).toFixed(3)}, ${(+m[2]).toFixed(3)}`, lat: +m[1], lon: +m[2] };
    const r = await search(q); if (!r.length) throw new HttpError(404, `Couldn't find "${clean(q)}" on the map.`);
    return r[0];
  }
  /* Coordinates → city (for "use my location"). */
  async function reverse(lat, lon) {
    need(); lat = Number(lat); lon = Number(lon);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new HttpError(400, "Invalid location.");
    const key = `r:${lat.toFixed(2)},${lon.toFixed(2)}`;
    return cached(key, 864e5, async () => {
      const j = await get(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`, { "Accept-Language": "en" });
      const a = j.address || {};
      const city = a.city || a.town || a.village || a.municipality || a.county || a.state_district || "";
      if (!city) throw new HttpError(404, "Couldn't name this location.");
      return { city, region: a.state || "", country: a.country || "", countryCode: (a.country_code || "").toUpperCase(), lat, lon };
    });
  }
  /* Approximate city from the internet connection (fallback when the browser can't give a position).
     A private/loopback address (the site running on this PC) looks up this network's own public address. */
  async function ipLocate(ip) {
    need();
    ip = String(ip || "").replace(/^::ffff:/, "");
    const priv = !ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(ip);
    return cached("ip:" + (priv ? "self" : ip), 864e5, async () => {
      const j = await get("https://ipwho.is/" + (priv ? "" : encodeURIComponent(ip)) + "?fields=success,message,city,region,country,country_code,latitude,longitude");
      if (!j.success || !j.city) throw new HttpError(404, "Couldn't work out your city from the internet connection.");
      return { city: j.city, region: j.region || "", country: j.country || "", countryCode: (j.country_code || "").toUpperCase(), lat: j.latitude, lon: j.longitude, approximate: true, source: "internet connection" };
    });
  }
  /* Driving route between two places: km, minutes, simplified line. */
  async function route(from, to) {
    need();
    const a = await place(from), b = await place(to);
    if (haversineKm(a, b) > 3500) throw new HttpError(400, "Those places are too far apart for a road trip.");
    return cached(`rt:${a.lat.toFixed(3)},${a.lon.toFixed(3)}>${b.lat.toFixed(3)},${b.lon.toFixed(3)}`, 7 * 864e5, async () => {
      const j = await get(`${router}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=simplified&geometries=geojson`);
      const r = j.routes && j.routes[0]; if (!r) throw new HttpError(404, "No road route found between these places.");
      const pts = ((r.geometry && r.geometry.coordinates) || []).map(([x, y]) => [Math.round(y * 1e4) / 1e4, Math.round(x * 1e4) / 1e4]);
      const step = Math.max(1, Math.ceil(pts.length / 400));
      return { from: { name: a.name, lat: a.lat, lon: a.lon }, to: { name: b.name, lat: b.lat, lon: b.lon }, km: Math.round(r.distance / 1000), minutes: Math.round(r.duration / 60), line: pts.filter((_, i) => i % step === 0 || i === pts.length - 1), source: "OpenStreetMap / OSRM" };
    });
  }
  /* Daily forecast for a place: only dates inside the 16-day forecast window. */
  async function weather(q, start, days) {
    need();
    const p = q && typeof q === "object" ? q : await place(q);
    const today = todayIST(), last = addDays(today, 15);
    start = /^\d{4}-\d{2}-\d{2}$/.test(start || "") ? start : today;
    days = Math.min(16, Math.max(1, Number(days) || 1));
    const end = addDays(start, days - 1);
    const base = { place: p.name || "", lat: p.lat, lon: p.lon, source: "Open-Meteo" };
    if (start > last) return { ...base, available: false, availableFrom: addDays(start, -15), note: `Forecasts reach 16 days ahead. Check again from ${addDays(start, -15)}.`, days: [] };
    if (end < today) return { ...base, available: false, note: "Those dates have passed.", days: [] };
    const s = start < today ? today : start, e = end > last ? last : end;
    const j = await cached(`w:${p.lat.toFixed(2)},${p.lon.toFixed(2)}:${s}:${e}`, 30 * 6e4, () => get(`https://api.open-meteo.com/v1/forecast?latitude=${p.lat}&longitude=${p.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&current=temperature_2m,weather_code&timezone=auto&start_date=${s}&end_date=${e}`));
    const d = j.daily || {};
    const list = (d.time || []).map((date, i) => {
      const w = wmo(d.weather_code[i]), rain = d.precipitation_probability_max ? d.precipitation_probability_max[i] : null;
      return { date, ...w, max: Math.round(d.temperature_2m_max[i]), min: Math.round(d.temperature_2m_min[i]), rainChance: rain, advice: rain >= 60 || ["storm", "rain"].includes(w.icon) && rain >= 40 ? "Rain likely: plan indoor visits, carry an umbrella, allow extra road time" : d.temperature_2m_max[i] >= 37 ? "Very hot: sightseeing early morning and evening, carry water" : "" };
    });
    return { ...base, available: list.length > 0, partial: end > last ? `Forecast covers up to ${last}.` : "", current: j.current ? { temp: Math.round(j.current.temperature_2m), ...wmo(j.current.weather_code) } : null, days: list };
  }
  return { enabled, search, reverse, route, weather, place, ipLocate };
}

module.exports = { createGeo, haversineKm, wmo };
