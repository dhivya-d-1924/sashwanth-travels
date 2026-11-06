"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createGeo, haversineKm } = require("../server/geo.js");
const { createPayments } = require("../server/payments.js");

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const day = n => new Date(Date.now() + 5.5 * 36e5 + n * 864e5).toISOString().slice(0, 10);

function fakeFetch(log) {
  return async (url, init) => {
    const u = new URL(url); log.push({ host: u.host, path: u.pathname, q: u.search, ua: init.headers["User-Agent"] });
    const ok = j => ({ ok: true, status: 200, json: async () => j });
    if (u.host === "geocoding-api.open-meteo.com") {
      const name = u.searchParams.get("name"), cc = u.searchParams.get("countryCode");
      if (name === "Madurai") return ok({ results: [{ name: "Madurai", admin1: "Tamil Nadu", country: "India", country_code: "IN", latitude: 9.9252, longitude: 78.1198, timezone: "Asia/Kolkata" }] });
      if (name === "Chennai") return ok({ results: [{ name: "Chennai", admin1: "Tamil Nadu", country: "India", country_code: "IN", latitude: 13.0827, longitude: 80.2707 }] });
      if (name === "Dubai" && cc === "IN") return ok({});
      if (name === "Dubai") return ok({ results: [{ name: "Dubai", admin1: "Dubai", country: "United Arab Emirates", country_code: "AE", latitude: 25.2, longitude: 55.27 }] });
      return ok({});
    }
    if (u.host === "ipwho.is") return ok(u.pathname === "/" ? { success: true, city: "Coimbatore", region: "Tamil Nadu", country: "India", country_code: "IN", latitude: 11.0, longitude: 76.96 } : { success: true, city: "Madurai", region: "Tamil Nadu", country: "India", country_code: "IN", latitude: 9.9, longitude: 78.1 });
    if (u.host === "nominatim.openstreetmap.org") return ok({ address: { city: "Chennai", state: "Tamil Nadu", country: "India", country_code: "in" } });
    if (u.host === "router.project-osrm.org") return ok({ routes: [{ distance: 462300, duration: 27000, geometry: { coordinates: [[80.27, 13.08], [79.5, 11.5], [78.12, 9.93]] } }] });
    if (u.host === "api.open-meteo.com") {
      const s = u.searchParams.get("start_date"), e = u.searchParams.get("end_date");
      const dates = []; for (let d = s; d <= e; d = new Date(Date.parse(d) + 864e5).toISOString().slice(0, 10)) dates.push(d);
      return ok({ current: { temperature_2m: 31.4, weather_code: 2 }, daily: { time: dates, weather_code: dates.map((_, i) => i === 0 ? 63 : 1), temperature_2m_max: dates.map(() => 33.2), temperature_2m_min: dates.map(() => 25.1), precipitation_probability_max: dates.map((_, i) => i === 0 ? 80 : 10) } });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test("place search prefers India and falls back worldwide", async () => {
  const log = [], g = createGeo({ HttpError, fetchImpl: fakeFetch(log), env: { OWNER_EMAIL: "owner@st.in" } });
  assert.equal((await g.search("Madurai"))[0].region, "Tamil Nadu");
  const d = await g.search("Dubai");
  assert.equal(d[0].countryCode, "AE");
  assert.equal(log.filter(l => l.q.includes("Dubai")).length, 2, "India first, then worldwide");
  await assert.rejects(g.search("x"), /at least 2/);
});

test("reverse geocoding names the city and identifies us to OpenStreetMap", async () => {
  const log = [], g = createGeo({ HttpError, fetchImpl: fakeFetch(log), env: { OWNER_EMAIL: "owner@st.in" } });
  const r = await g.reverse(13.08, 80.27);
  assert.equal(r.city, "Chennai"); assert.equal(r.countryCode, "IN");
  assert.match(log[0].ua, /SashwanthTravels\/.*owner@st\.in/);
  await assert.rejects(g.reverse(200, 0), /Invalid location/);
});

test("road route: km and minutes from the map, cached", async () => {
  const log = [], g = createGeo({ HttpError, fetchImpl: fakeFetch(log), env: {} });
  const r = await g.route("Chennai", "Madurai");
  assert.equal(r.km, 462); assert.equal(r.minutes, 450); assert.equal(r.line[0][0], 13.08);
  const n = log.length; await g.route("Chennai", "Madurai");
  assert.equal(log.length, n, "second call served from cache");
  assert.ok(Math.abs(haversineKm({ lat: 13.08, lon: 80.27 }, { lat: 9.93, lon: 78.12 }) - 420) < 15);
});

test("weather: real forecast inside 16 days, rain advice, honest 'not yet' beyond", async () => {
  const g = createGeo({ HttpError, fetchImpl: fakeFetch([]), env: {} });
  const w = await g.weather("Madurai", day(2), 3);
  assert.equal(w.available, true); assert.equal(w.days.length, 3);
  assert.equal(w.days[0].text, "Rain"); assert.match(w.days[0].advice, /Rain likely/);
  assert.equal(w.current.temp, 31);
  const far = await g.weather("Madurai", day(40), 3);
  assert.equal(far.available, false); assert.match(far.note, /16 days/); assert.equal(far.days.length, 0);
  const edge = await g.weather("Madurai", day(14), 5);
  assert.equal(edge.days.length, 2); assert.match(edge.partial, /Forecast covers up to/);
});

test("maps can be switched off", async () => {
  const g = createGeo({ HttpError, fetchImpl: fakeFetch([]), env: { MAPS: "off" } });
  await assert.rejects(g.search("Madurai"), /switched off/);
});

test("payment: a route not in the table uses the map distance when the entered km is too low", async () => {
  const cfg = { name: "ST", sample: false, advancePercent: 25, gstPercent: 0, vehicles: [{ id: "sedan", name: "Sedan", seats: 4, count: 2, ratePerKm: 13, minKmPerDay: 250, driverBata: 400 }], routes: [] };
  const D = { docs: { "site/config": { data: cfg }, "requests/u1": { data: { bookings: { b1: { ref: "ST-1", from: "Chennai", to: "Kanyakumari", date: day(5), days: 1, km: 50, type: "oneway", vehicleId: "sedan" } } } } }, payments: {}, meta: { webhookEvents: {} }, users: { u1: { name: "R" } } };
  const orders = [];
  const pay = createPayments({ D, store: { save() {} }, changed() {}, HttpError, keyId: "rzp_test_x", keySecret: "s", webhookSecret: "w".repeat(32), routeKm: async () => 700,
    fetchImpl: async (url, init) => { const b = JSON.parse(init.body); orders.push(b); return { ok: true, status: 200, json: async () => ({ id: "order_1", ...b }) }; } });
  const o = await pay.createOrder("u1", "b1");
  assert.deepEqual(o.kmAdjusted, { entered: 50, map: 700 });
  assert.equal(D.payments.order_1.quote.fare.chargeKm, 700, "charged on the map distance, not the 50 km typed in");
  /* a fair entry (within 10% of the map) is kept as entered */
  D.docs["requests/u1"].data.bookings.b1.km = 680; D.payments = {};
  const o2 = await pay.createOrder("u1", "b1");
  assert.equal(o2.kmAdjusted, null);
});

test("approximate city from the internet connection: own network for a local visitor, visitor's address otherwise", async () => {
  const log = [], g = createGeo({ HttpError, fetchImpl: fakeFetch(log), env: {} });
  const self = await g.ipLocate("::ffff:127.0.0.1");
  assert.equal(self.city, "Coimbatore"); assert.equal(self.approximate, true);
  assert.equal(log.at(-1).path, "/", "local visitor: looks up this network's public address");
  const remote = await g.ipLocate("49.37.10.20");
  assert.equal(remote.city, "Madurai"); assert.equal(log.at(-1).path, "/49.37.10.20");
  const lan = await g.ipLocate("192.168.1.5"); assert.equal(lan.city, "Coimbatore");
});

test("weather service busy (429): waits before asking again and reuses the last good answer", async () => {
  const { createGeo } = require("../server/geo.js");
  class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
  let n = 0, mode = "ok";
  const fetchImpl = async () => { n++; if (mode === "busy") return { ok: false, status: 429, headers: { get: () => "120" }, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ daily: { time: ["2026-11-06"], weather_code: [1], temperature_2m_max: [31], temperature_2m_min: [24], precipitation_probability_max: [10] }, current: { temperature_2m: 29, weather_code: 1 } }) }; };
  const g = createGeo({ fetchImpl, HttpError, env: {} });
  const first = await g.weather({ lat: 13.08, lon: 80.27, name: "Chennai" }, undefined, 1);
  assert.equal(first.available, true);
  mode = "busy";
  await assert.rejects(g.weather({ lat: 11.41, lon: 76.70, name: "Ooty" }, undefined, 1), /limiting requests/);
  const before = n;
  await assert.rejects(g.weather({ lat: 10.23, lon: 77.49, name: "Kodaikanal" }, undefined, 1), /busy/);
  assert.equal(n, before, "no new request while cooling down");
});
