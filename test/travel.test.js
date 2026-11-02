"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createApp } = require("../server/server.js");
const { minutes, ageOn } = require("../server/travel.js");

const KEY = "rzp_test_abc", SECRET = "test_secret_123";
const sign = (msg) => crypto.createHmac("sha256", SECRET).update(msg).digest("hex");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-travel-"));
const day = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

/* ---- fake providers ---- */
const P = { calls: [], offerPrice: "120.00", failOrder: false, failRefund: false, rzPayments: {}, refunds: [] };
const offer = (id, price) => ({
  id, expires_at: new Date(Date.now() + 30 * 60e3).toISOString(), total_amount: price, total_currency: "GBP",
  owner: { name: "Duffel Airways", iata_code: "ZZ" },
  conditions: { refund_before_departure: { allowed: true }, change_before_departure: { allowed: false } },
  passengers: [{ id: "pas_1", type: "adult" }, { id: "pas_2", age: 8 }],
  slices: [{ duration: "PT2H5M", origin: { iata_code: "MAA", city_name: "Chennai" }, destination: { iata_code: "SIN", city_name: "Singapore" },
    segments: [{ departing_at: day(20) + "T06:00:00", arriving_at: day(20) + "T12:35:00", marketing_carrier: { iata_code: "ZZ" }, marketing_carrier_flight_number: "101", passengers: [{ cabin_class_marketing_name: "Economy", baggages: [{ type: "checked", quantity: 1 }] }] }] }]
});
let orderSeq = 0;
async function fakeFetch(url, init) {
  const u = new URL(url), body = init.body ? JSON.parse(init.body) : null;
  P.calls.push({ host: u.host, method: init.method, path: u.pathname + u.search, body, headers: init.headers });
  const ok = data => ({ ok: true, status: 200, json: async () => data });
  const fail = (status, msg) => ({ ok: false, status, json: async () => ({ errors: [{ message: msg }] }) });
  if (u.host === "api.duffel.com") {
    if (u.pathname === "/places/suggestions") return ok({ data: [{ iata_code: "MAA", name: "Chennai International", city_name: "Chennai", type: "airport" }] });
    if (u.pathname === "/air/offer_requests") return ok({ data: { offers: [offer("off_a", "150.00"), offer("off_b", "120.00"), { ...offer("off_usd", "99.00"), total_currency: "USD" }] } });
    if (u.pathname.startsWith("/air/offers/")) return ok({ data: offer(u.pathname.split("/").pop(), P.offerPrice) });
    if (u.pathname === "/air/orders") return P.failOrder ? fail(422, "Offer no longer available") : ok({ data: { id: "ord_" + (++orderSeq), booking_reference: "ZZ" + orderSeq + "ABC" } });
    if (u.pathname === "/air/order_cancellations") return ok({ data: { id: "ore_1", refund_amount: "100.00", refund_currency: "GBP", expires_at: new Date(Date.now() + 10 * 60e3).toISOString() } });
    if (/\/air\/order_cancellations\/.+\/actions\/confirm/.test(u.pathname)) return ok({ data: { id: "ore_1", confirmed_at: new Date().toISOString() } });
  }
  if (u.host === "api.liteapi.travel" && u.pathname === "/v3.0/hotels/rates") return ok({
    data: [{ hotelId: "lp1", roomTypes: [{ offerId: "hot_off_1", offerRetailRate: { amount: 9000, currency: "INR" }, rates: [{ name: "Deluxe Double", boardName: "Breakfast", cancellationPolicies: { refundableTag: "RFN" }, retailRate: { total: [{ amount: 9000, currency: "INR" }] } }] }] }],
    hotels: [{ id: "lp1", name: "Temple View Inn", address: "North Masi St", stars: 4, rating: 8.6, thumbnail: "https://img.example/1.jpg" }] });
  if (u.host === "book.liteapi.travel" && u.pathname === "/v3.0/rates/prebook") return ok({ data: { prebookId: "pre_1", price: 9000, currency: "INR", priceDifferencePercent: 0, cancellationChanged: false } });
  if (u.host === "book.liteapi.travel" && u.pathname === "/v3.0/rates/book") return ok({ data: { bookingId: "lb_1", status: "CONFIRMED", hotelConfirmationCode: "HTL778" } });
  if (u.host === "book.liteapi.travel" && u.pathname.startsWith("/v3.0/bookings/")) return ok({ data: { status: "CANCELLED", refund_amount: 9000, currency: "INR" } });
  if (u.host === "api.razorpay.com") {
    if (u.pathname === "/v1/orders") return ok({ id: "order_t" + (++orderSeq), ...body });
    let m = /^\/v1\/payments\/([^/]+)$/.exec(u.pathname); if (m) return ok(P.rzPayments[m[1]]);
    m = /^\/v1\/payments\/([^/]+)\/refund$/.exec(u.pathname); if (m && P.failRefund) return { ok: false, status: 502, json: async () => ({ error: { description: "Gateway down" } }) }; if (m) { const r = { id: "rfnd_" + (P.refunds.length + 1), amount: body.amount }; P.refunds.push(r); return ok(r); }
  }
  return { ok: false, status: 404, json: async () => ({}) };
}

let server, base, theApp;
function client() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const h = {}; if (method !== "GET") h["X-SST"] = "1"; if (cookie) h.Cookie = cookie; if (body !== undefined) h["Content-Type"] = "application/json";
    const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) { const mm = /sst_sid=([^;]*)/.exec(sc); cookie = mm && mm[1] ? "sst_sid=" + mm[1] : ""; }
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, body: ct.includes("json") ? await r.json() : await r.text() };
  };
}
const owner = client(), cust = client(), other = client();
let CU;
const pax = [
  { title: "mr", given_name: "Ravi", family_name: "Kumar", gender: "m", born_on: "1985-04-02", email: "ravi@x.in", phone_number: "+919876543210" },
  { title: "miss", given_name: "Anu", family_name: "Kumar", gender: "f", born_on: day(-8 * 365), email: "ravi@x.in", phone_number: "+919876543210" }
];
async function payFor(c, bookingId, payId) {
  const o = await c("/api/travel/pay", { method: "POST", body: { bookingId } });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  P.rzPayments[payId] = { id: payId, order_id: o.body.orderId, amount: o.body.amount, currency: "INR", status: "captured", method: "upi" };
  return c("/api/pay/verify", { method: "POST", body: { orderId: o.body.orderId, paymentId: payId, signature: sign(o.body.orderId + "|" + payId) } });
}
const tdoc = async c => (await c(`/api/db/doc?path=travel/${CU}`)).body;

test.before(async () => {
  const app = theApp = createApp({ limitScale: 10, dataDir: dir, fetchImpl: fakeFetch, duffelKey: "duffel_test_x", liteKey: "sand_x", razorpay: { keyId: KEY, keySecret: SECRET, webhookSecret: "w".repeat(32) }, owner: { name: "Owner", email: "o@st.in", phone: "9000000001", password: "owner-pass-123" } });
  await app.locals.ready;
  await new Promise(r => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
  await owner("/api/auth/login", { method: "POST", body: { login: "o@st.in", password: "owner-pass-123" } });
  await owner("/api/db/doc", { method: "POST", body: { path: "site/config", op: "set", data: { sample: false, name: "Sashwanth Travels", phone: "+91 90000 00001", vehicles: [], routes: [], travel: { fx: { GBP: 110 }, flightFeePct: 2, hotelFeePct: 3 } } } });
  CU = (await cust("/api/auth/signup", { method: "POST", body: { name: "Ravi", email: "ravi@x.in", phone: "9876543210", password: "Marina#Wave2026" } })).body.user.id;
  await other("/api/auth/signup", { method: "POST", body: { name: "Bob", email: "b@x.in", phone: "9123456780", password: "Monsoon!Ride83" } });
});
test.after(async () => { theApp.locals.store.flushNow(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

test("helpers: ISO duration and age on travel date", () => {
  assert.equal(minutes("PT2H5M"), 125); assert.equal(minutes("P1DT1H"), 1500);
  assert.equal(ageOn("2010-06-15", "2026-06-14"), 15); assert.equal(ageOn("2010-06-15", "2026-06-15"), 16);
});

test("session advertises flights and hotels in test mode", async () => {
  assert.deepEqual((await cust("/api/session")).body.travel, { flights: true, hotels: true, test: true });
});

test("airport suggestions come from the provider", async () => {
  const r = await cust("/api/travel/places?q=chen");
  assert.equal(r.body[0].code, "MAA");
});

test("flight search validates input, converts to INR with the fee, sorts by price, hides unpriced currencies", async () => {
  assert.equal((await cust("/api/travel/flights/search", { method: "POST", body: { from: "MAA", to: "MAA", date: day(20), adults: 1 } })).status, 400);
  assert.equal((await cust("/api/travel/flights/search", { method: "POST", body: { from: "MAA", to: "SIN", date: day(-1), adults: 1 } })).status, 400);
  assert.equal((await cust("/api/travel/flights/search", { method: "POST", body: { from: "MAA", to: "SIN", date: day(20), adults: 1, infants: 2 } })).status, 400);
  const r = await cust("/api/travel/flights/search", { method: "POST", body: { from: "maa", to: "sin", date: day(20), adults: 1, children: 1, cabin: "economy" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.offers.map(o => o.id), ["off_b", "off_a"]);
  assert.deepEqual(r.body.missingRates, ["USD"]);
  const b = r.body.offers[0];
  assert.equal(b.price.base, 13200); assert.equal(b.price.fee, 264); assert.equal(b.price.total, 13464);
  assert.equal(b.slices[0].minutes, 125); assert.equal(b.baggage, "1 × checked");
  const req = P.calls.find(c => c.path.startsWith("/air/offer_requests"));
  assert.equal(req.headers["Duffel-Version"], "v2");
  assert.deepEqual(req.body.data.passengers, [{ type: "adult" }, { age: 8 }]);
});

test("hold: passengers validated, price re-checked with the airline, pending booking created", async () => {
  assert.equal((await cust("/api/travel/hold", { method: "POST", body: { offerId: "off_b", passengers: [pax[0]] } })).status, 400, "needs both passengers");
  const wrongAge = [pax[0], { ...pax[1], born_on: "1990-01-01" }];
  assert.equal((await cust("/api/travel/hold", { method: "POST", body: { offerId: "off_b", passengers: wrongAge } })).status, 400, "child booked as adult");
  assert.equal((await cust("/api/travel/hold", { method: "POST", body: { offerId: "off_b", passengers: [pax[0], { ...pax[1], phone_number: "98765" }] } })).status, 400);
  assert.equal((await other("/api/travel/hold", { method: "POST" })).status, 409, "unknown offer");
  P.offerPrice = "125.00";
  const h = await cust("/api/travel/hold", { method: "POST", body: { offerId: "off_b", passengers: pax } });
  assert.equal(h.status, 201);
  assert.equal(h.body.status, "awaiting_payment");
  assert.equal(h.body.priceChanged, true, "airline price moved from 120 to 125");
  assert.equal(h.body.price.total, Math.ceil(125 * 110) + Math.ceil(Math.ceil(125 * 110) * 0.02));
  assert.match(h.body.ref, /^FL-/);
});

let flightId;
test("pay → airline confirms → PNR stored, invoice available; others can't see it", async () => {
  const d = await tdoc(cust); flightId = Object.keys(d.data.bookings)[0];
  const v = await payFor(cust, flightId, "pay_f1");
  assert.equal(v.status, 200); assert.equal(v.body.status, "travel_paid");
  const b = (await tdoc(cust)).data.bookings[flightId];
  assert.equal(b.status, "confirmed");
  assert.match(b.reference, /^ZZ\d+ABC$/);
  const order = P.calls.find(c => c.path === "/air/orders");
  assert.equal(order.body.data.payments[0].amount, "125.00");
  assert.equal(order.body.data.passengers[1].id, "pas_2");
  assert.equal((await other(`/api/db/doc?path=travel/${CU}`)).body.exists, false);
  assert.equal((await cust("/api/db/doc", { method: "POST", body: { path: `travel/${CU}`, op: "update", data: { bookings: { [flightId]: { status: "confirmed" } } } } })).status, 403, "nobody edits travel bookings directly");
  const inv = await cust(`/api/travel/invoice/${CU}/${flightId}`);
  assert.equal(inv.status, 200); assert.match(inv.body, /Invoice INV-FL-/); assert.match(inv.body, /Service fee/);
  assert.equal((await other(`/api/travel/invoice/${CU}/${flightId}`)).status, 404);
  assert.equal((await owner(`/api/travel/invoice/${CU}/${flightId}`)).status, 200, "owner can see invoices");
});

test("cancellation: quote shows refund (fee kept), confirm refunds via Razorpay", async () => {
  const q = await cust("/api/travel/cancel/quote", { method: "POST", body: { bookingId: flightId } });
  assert.equal(q.status, 200); assert.equal(q.body.refund, 11000, "100 GBP × 110");
  const c = await cust("/api/travel/cancel/confirm", { method: "POST", body: { bookingId: flightId } });
  assert.equal(c.body.refunded, 11000);
  assert.equal(P.refunds.at(-1).amount, 1100000);
  assert.equal((await tdoc(cust)).data.bookings[flightId].status, "cancelled");
});

test("airline fails after payment → full automatic refund", async () => {
  P.offerPrice = "120.00";
  await cust("/api/travel/flights/search", { method: "POST", body: { from: "MAA", to: "SIN", date: day(20), adults: 1, children: 1 } });
  const h = await cust("/api/travel/hold", { method: "POST", body: { offerId: "off_a", passengers: pax } });
  P.failOrder = true;
  await payFor(cust, h.body.id, "pay_f2");
  P.failOrder = false;
  const b = (await tdoc(cust)).data.bookings[h.body.id];
  assert.equal(b.status, "failed_refunded");
  assert.equal(b.refund.amount, b.price.total);
  assert.equal(P.refunds.at(-1).amount, b.price.total * 100);
});

test("reconciliation: refund that failed is listed for staff and the owner can retry it once", async () => {
  await cust("/api/travel/flights/search", { method: "POST", body: { from: "MAA", to: "SIN", date: day(20), adults: 1, children: 1 } });
  const h = await cust("/api/travel/hold", { method: "POST", body: { offerId: "off_b", passengers: pax } });
  P.failOrder = true; P.failRefund = true;
  await payFor(cust, h.body.id, "pay_f3");
  P.failOrder = false; P.failRefund = false;
  let b = (await tdoc(cust)).data.bookings[h.body.id];
  assert.equal(b.status, "failed_refund_pending", "never shown as confirmed; refund marked pending");
  assert.equal((await cust("/api/travel/attention")).status, 403, "customers can't see the queue");
  const q = await owner("/api/travel/attention");
  assert.ok(q.body.some(x => x.id === h.body.id && x.why === "Refund pending"));
  assert.equal((await cust("/api/travel/refund-retry", { method: "POST", body: { uid: CU, bookingId: h.body.id } })).status, 403);
  const r = await owner("/api/travel/refund-retry", { method: "POST", body: { uid: CU, bookingId: h.body.id } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  b = (await tdoc(cust)).data.bookings[h.body.id];
  assert.equal(b.status, "failed_refunded"); assert.equal(r.body.refunded, b.price.total);
  const again = await owner("/api/travel/refund-retry", { method: "POST", body: { uid: CU, bookingId: h.body.id } });
  assert.equal(again.status, 409, "no double refund");
});

test("hotels: search in INR with fee, prebook, pay, hotel confirms, refundable cancellation", async () => {
  assert.equal((await cust("/api/travel/hotels/search", { method: "POST", body: { city: "Madurai", checkin: day(10), checkout: day(10), rooms: 1, adults: 2 } })).status, 400);
  assert.equal((await cust("/api/travel/hotels/search", { method: "POST", body: { city: "Madurai", checkin: day(10), checkout: day(12), rooms: 2, adults: 9 } })).status, 400);
  const s = await cust("/api/travel/hotels/search", { method: "POST", body: { city: "Madurai", countryCode: "IN", checkin: day(10), checkout: day(12), rooms: 1, adults: 2 } });
  assert.equal(s.status, 200);
  const h0 = s.body.hotels[0];
  assert.equal(h0.name, "Temple View Inn"); assert.equal(h0.rates[0].price.total, 9000 + 270); assert.equal(s.body.nights, 2);
  assert.equal((await cust("/api/travel/hold", { method: "POST", body: { offerId: "hot_off_1", holder: { firstName: "Ravi", lastName: "Kumar", email: "ravi@x.in", phone: "98765" } } })).status, 400);
  const h = await cust("/api/travel/hold", { method: "POST", body: { offerId: "hot_off_1", holder: { firstName: "Ravi", lastName: "Kumar", email: "ravi@x.in", phone: "+919876543210" } } });
  assert.equal(h.status, 201); assert.equal(h.body.prebookId, "pre_1"); assert.equal(h.body.priceChanged, false);
  await payFor(cust, h.body.id, "pay_h1");
  const b = (await tdoc(cust)).data.bookings[h.body.id];
  assert.equal(b.status, "confirmed"); assert.equal(b.reference, "HTL778");
  const book = P.calls.find(c => c.path === "/v3.0/rates/book");
  assert.equal(book.body.clientReference, h.body.id, "idempotency key"); assert.equal(book.body.payment.method, "ACC_CREDIT_CARD");
  const q = await cust("/api/travel/cancel/quote", { method: "POST", body: { bookingId: h.body.id } });
  assert.equal(q.body.refund, 9000);
  const c = await cust("/api/travel/cancel/confirm", { method: "POST", body: { bookingId: h.body.id } });
  assert.equal(c.body.refunded, 9000);
});

test("not connected: clear message instead of fake results", async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "sst-nt-"));
  const app = createApp({ dataDir: d2, duffelKey: "", liteKey: "" });
  const srv = await new Promise(r => { const s2 = app.listen(0, () => r(s2)); });
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/travel/flights/search`, { method: "POST", headers: { "Content-Type": "application/json", "X-SST": "1" }, body: JSON.stringify({ from: "MAA", to: "SIN", date: day(20), adults: 1 }) });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /Duffel key/);
  } finally { app.locals.store.flushNow(); srv.closeAllConnections(); await new Promise(r2 => srv.close(r2)); fs.rmSync(d2, { recursive: true, force: true }); }
});
