"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createApp } = require("../server/server.js");

const KEY = "rzp_test_abc", SECRET = "test_secret_123", WH = "webhook_secret_0123456789abcdef0123";
const sign = (secret, msg) => crypto.createHmac("sha256", secret).update(msg).digest("hex");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-pay-"));
const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);

/* Fake Razorpay API */
const rz = { orders: {}, payments: {}, refunds: [], calls: [] };
let orderSeq = 0;
async function fakeFetch(url, init) {
  const u = new URL(url), body = init.body ? JSON.parse(init.body) : null;
  rz.calls.push({ method: init.method, path: u.pathname, body, auth: init.headers.Authorization });
  const ok = data => ({ ok: true, status: 200, json: async () => data });
  if (init.method === "POST" && u.pathname === "/v1/orders") { const id = "order_" + (++orderSeq); rz.orders[id] = { id, ...body, status: "created" }; return ok(rz.orders[id]); }
  let m = /^\/v1\/payments\/([^/]+)$/.exec(u.pathname);
  if (init.method === "GET" && m) return rz.payments[m[1]] ? ok(rz.payments[m[1]]) : { ok: false, status: 404, json: async () => ({ error: { description: "not found" } }) };
  m = /^\/v1\/payments\/([^/]+)\/capture$/.exec(u.pathname);
  if (m) { rz.payments[m[1]].status = "captured"; return ok(rz.payments[m[1]]); }
  m = /^\/v1\/payments\/([^/]+)\/refund$/.exec(u.pathname);
  if (m) { const r = { id: "rfnd_" + (rz.refunds.length + 1), amount: body.amount }; rz.refunds.push(r); return ok(r); }
  return { ok: false, status: 404, json: async () => ({}) };
}

let server, base, theApp;
function client() {
  let cookie = "";
  return async (p, { method = "GET", body, headers = {}, raw } = {}) => {
    const h = { ...headers };
    if (method !== "GET" && !raw) h["X-SST"] = "1";
    if (cookie) h.Cookie = cookie;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const r = await fetch(base + p, { method, headers: h, body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
    const sc = r.headers.get("set-cookie"); if (sc) { const mm = /sst_sid=([^;]*)/.exec(sc); cookie = mm && mm[1] ? "sst_sid=" + mm[1] : ""; }
    return { status: r.status, body: await r.json().catch(() => null), headers: r.headers };
  };
}
const owner = client(), cust = client(), other = client();
let CU;
const put = (c, p, op, data) => c("/api/db/doc", { method: "POST", body: { path: p, op, data } });
const config = {
  sample: false, name: "Sashwanth Travels", phone: "+91 90000 00001", advancePercent: 25, gstPercent: 0, nightCharge: 0,
  vehicles: [{ id: "sedan", name: "Sedan", type: "sedan", seats: 4, ac: true, count: 1, ratePerKm: 13, minKmPerDay: 250, driverBata: 400 }],
  routes: [{ from: "Chennai", to: "Madurai", km: 462 }]
};
const booking = (ref, extra = {}) => ({ ref, from: "Chennai", to: "Madurai", date: future, endDate: future, days: 2, pax: 2, type: "round", km: 1, vehicleId: "sedan", vehicleName: "Sedan", name: "Priya", phone: "9876543210", fare: { total: 10, advance: 1 }, createdAt: Date.now(), ...extra });

test.before(async () => {
  const app = theApp = createApp({ limitScale: 10, dataDir: dir, fetchImpl: fakeFetch, razorpay: { keyId: KEY, keySecret: SECRET, webhookSecret: WH }, owner: { name: "Owner", email: "o@st.in", phone: "9000000001", password: "owner-pass-123" } });
  await app.locals.ready;
  await new Promise(r => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
  await owner("/api/auth/login", { method: "POST", body: { login: "o@st.in", password: "owner-pass-123" } });
  await put(owner, "site/config", "set", config);
  CU = (await cust("/api/auth/signup", { method: "POST", body: { name: "Priya", email: "p@x.in", phone: "9876543210", password: "Lotus@Pond3141" } })).body.user.id;
  await other("/api/auth/signup", { method: "POST", body: { name: "Ravi", email: "r@x.in", phone: "9123456789", password: "Marina#Wave2026" } });
});
test.after(async () => { theApp.locals.store.flushNow(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

let order1;
test("gateway is advertised and allowed by the security policy", async () => {
  const s = await cust("/api/session");
  assert.deepEqual(s.body.payments, { provider: "razorpay", keyId: KEY });
  const csp = s.headers.get("content-security-policy");
  assert.match(csp, /script-src 'self' https:\/\/checkout\.razorpay\.com/);
  assert.match(csp, /frame-src https:\/\/api\.razorpay\.com/);
});

test("order amount is computed by the server, ignoring a tampered fare", async () => {
  await put(cust, `requests/${CU}`, "set", { bookings: { b1: booking("ST-1") } });
  const r = await cust("/api/pay/order", { method: "POST", body: { bookingId: "b1" } });
  assert.equal(r.status, 200);
  // route table 462 km x2 = 924 km x ₹13 = 12012 + bata 800 = 12812; 25% → 3203 → rounded up to ₹3210
  assert.equal(r.body.amount, 321000);
  assert.equal(r.body.keyId, KEY);
  assert.equal(rz.calls.at(-1).body.amount, 321000);
  assert.equal(rz.calls.at(-1).auth, "Basic " + Buffer.from(KEY + ":" + SECRET).toString("base64"));
  order1 = r.body.orderId;
  const again = await cust("/api/pay/order", { method: "POST", body: { bookingId: "b1" } });
  assert.equal(again.body.orderId, order1, "retry reuses the open order");
});

test("other customers can't pay for or verify someone else's booking", async () => {
  assert.equal((await other("/api/pay/order", { method: "POST", body: { bookingId: "b1" } })).status, 404);
  assert.equal((await other("/api/pay/verify", { method: "POST", body: { orderId: order1, paymentId: "pay_1", signature: sign(SECRET, order1 + "|pay_1") } })).status, 404);
});

test("a forged signature is rejected", async () => {
  rz.payments.pay_1 = { id: "pay_1", order_id: order1, amount: 321000, currency: "INR", status: "captured", method: "upi" };
  const r = await cust("/api/pay/verify", { method: "POST", body: { orderId: order1, paymentId: "pay_1", signature: "deadbeef" } });
  assert.equal(r.status, 400);
});

test("a valid payment confirms the booking, locks the price and blocks the vehicle", async () => {
  const r = await cust("/api/pay/verify", { method: "POST", body: { orderId: order1, paymentId: "pay_1", signature: sign(SECRET, order1 + "|pay_1") } });
  assert.equal(r.status, 200); assert.equal(r.body.status, "confirmed");
  const dec = (await cust(`/api/db/doc?path=decisions/${CU}`)).body.data.bookings.b1;
  assert.equal(dec.status, "confirmed"); assert.equal(dec.advancePaid, true);
  assert.equal(dec.fare.total, 12812); assert.equal(dec.paidOnline.paymentId, "pay_1");
  const req = (await cust(`/api/db/doc?path=requests/${CU}`)).body.data.bookings.b1;
  assert.equal(req.payment.online, true); assert.equal(req.payment.utr, "pay_1");
  const av = (await cust("/api/db/doc?path=site/availability")).body.data.blocks;
  assert.equal(av.b1.vehicleId, "sedan");
  const again = await cust("/api/pay/verify", { method: "POST", body: { orderId: order1, paymentId: "pay_1", signature: sign(SECRET, order1 + "|pay_1") } });
  assert.equal(again.body.already, true, "verifying twice changes nothing");
  assert.equal((await cust("/api/pay/order", { method: "POST", body: { bookingId: "b1" } })).status, 409, "can't pay a confirmed booking again");
});

test("payment whose amount doesn't match the order is refused", async () => {
  await put(cust, `requests/${CU}`, "update", { bookings: { b9: booking("ST-9", { date: new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10) }) } });
  const o = (await cust("/api/pay/order", { method: "POST", body: { bookingId: "b9" } })).body.orderId;
  rz.payments.pay_low = { id: "pay_low", order_id: o, amount: 100, currency: "INR", status: "captured" };
  const r = await cust("/api/pay/verify", { method: "POST", body: { orderId: o, paymentId: "pay_low", signature: sign(SECRET, o + "|pay_low") } });
  assert.equal(r.status, 400);
});

test("vehicle taken before payment: can't start paying; taken during payment: paid but flagged for the owner", async () => {
  await put(cust, `requests/${CU}`, "update", { bookings: { b2: booking("ST-2") } });
  assert.equal((await cust("/api/pay/order", { method: "POST", body: { bookingId: "b2" } })).status, 409, "the only sedan is already booked for these dates");
  const later = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
  await put(cust, `requests/${CU}`, "update", { bookings: { b3: booking("ST-3", { date: later, endDate: later }) } });
  const o = (await cust("/api/pay/order", { method: "POST", body: { bookingId: "b3" } })).body.orderId;
  await put(owner, "site/availability", "update", { blocks: { phone1: { vehicleId: "sedan", from: later, to: later, reason: "Phone booking" } } });
  rz.payments.pay_3 = { id: "pay_3", order_id: o, amount: 321000, currency: "INR", status: "authorized" };
  const r = await cust("/api/pay/verify", { method: "POST", body: { orderId: o, paymentId: "pay_3", signature: sign(SECRET, o + "|pay_3") } });
  assert.equal(r.body.status, "no_vehicle");
  assert.ok(rz.calls.some(c => c.path === "/v1/payments/pay_3/capture"), "authorized payment is captured");
  const dec = (await owner(`/api/db/doc?path=decisions/${CU}`)).body.data.bookings.b3;
  assert.equal(dec.status, "changes_requested"); assert.equal(dec.advancePaid, true);
});

test("webhook: bad signature rejected; signed payment.captured finalizes once", async () => {
  const later = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  await put(cust, `requests/${CU}`, "update", { bookings: { b4: booking("ST-4", { date: later, endDate: later }) } });
  const o = (await cust("/api/pay/order", { method: "POST", body: { bookingId: "b4" } })).body.orderId;
  rz.payments.pay_4 = { id: "pay_4", order_id: o, amount: 321000, currency: "INR", status: "captured" };
  const payload = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_4", order_id: o } } } });
  const hook = client();
  assert.equal((await hook("/api/pay/webhook", { method: "POST", raw: payload, headers: { "Content-Type": "application/json", "X-Razorpay-Signature": "bad" } })).status, 400);
  const good = { "Content-Type": "application/json", "X-Razorpay-Signature": sign(WH, payload), "X-Razorpay-Event-Id": "evt_1" };
  assert.equal((await hook("/api/pay/webhook", { method: "POST", raw: payload, headers: good })).status, 200);
  assert.equal((await hook("/api/pay/webhook", { method: "POST", raw: payload, headers: good })).body.duplicate, true);
  const dec = (await cust(`/api/db/doc?path=decisions/${CU}`)).body.data.bookings.b4;
  assert.equal(dec.status, "confirmed");
});

test("refunds: owner only, partial then rest, never more than paid", async () => {
  assert.equal((await cust("/api/pay/refund", { method: "POST", body: { uid: CU, bookingId: "b3" } })).status, 403);
  const p = await owner("/api/pay/refund", { method: "POST", body: { uid: CU, bookingId: "b3", amount: 1000 } });
  assert.equal(p.status, 200); assert.equal(p.body.remaining, 2210);
  assert.equal(rz.refunds.at(-1).amount, 100000);
  assert.equal((await owner("/api/pay/refund", { method: "POST", body: { uid: CU, bookingId: "b3", amount: 5000 } })).status, 400);
  const rest = await owner("/api/pay/refund", { method: "POST", body: { uid: CU, bookingId: "b3" } });
  assert.equal(rest.body.remaining, 0);
  const dec = (await cust(`/api/db/doc?path=decisions/${CU}`)).body.data.bookings.b3;
  assert.equal(dec.refund.amount, 3210); assert.equal(dec.refund.full, true);
});

test("gateway off: no keys means no online payment and a strict policy", async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "sst-nopay-"));
  const app = createApp({ dataDir: d2 });
  const srv = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/session`);
  assert.equal((await r.json()).payments, null);
  assert.match(r.headers.get("content-security-policy"), /script-src 'self';/);
  app.locals.store.flushNow(); await new Promise(r => srv.close(r)); fs.rmSync(d2, { recursive: true, force: true });
});
