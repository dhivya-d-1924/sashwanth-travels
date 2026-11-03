"use strict";
/* v3.3: after a booking is sent, its name and phone change only with the owner's approval. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server/server.js");
const { createNotifier } = require("../server/notify.js");

function client(base) {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const headers = {};
    if (method !== "GET") headers["X-SST"] = "1";
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const r = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = /sst_sid=([^;]*)/.exec(sc); cookie = m && m[1] ? "sst_sid=" + m[1] : ""; }
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
}

test("customers can't edit a booking's name or phone directly; a valid change request is accepted; the owner approves", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-cc-"));
  const app = createApp({ dataDir: dir, limitScale: 20, owner: { name: "Owner", email: "o@st.in", phone: "9000000001", password: "owner-pass-123" } });
  await app.locals.ready; const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = "http://127.0.0.1:" + server.address().port, cu = client(base), own = client(base);
  try {
    const uid = (await cu("/api/auth/signup", { method: "POST", body: { name: "Ravi", email: "ravi@x.in", phone: "9876543210", password: "Sunset#Road71" } })).body.user.id;
    const P = "requests/" + uid, put = (op, data) => cu("/api/db/doc", { method: "POST", body: { path: P, op, data } });
    assert.equal((await put("set", { bookings: { b1: { ref: "ST-1", from: "Chennai", to: "Madurai", date: "2026-12-01", name: "Ravi", phone: "9876543210" } } })).status, 200);
    /* direct edits refused, with either op */
    const r1 = await put("update", { bookings: { b1: { phone: "9123456780" } } });
    assert.equal(r1.status, 403); assert.match(r1.body.error, /owner's approval/);
    assert.equal((await put("set", { bookings: { b1: { ref: "ST-1", name: "Someone else", phone: "9876543210" } } })).status, 403);
    /* other updates to the booking still work (payment, cancel) */
    assert.equal((await put("update", { bookings: { b1: { payment: { utr: "123456789012", method: "UPI", at: 1 } } } })).status, 200);
    /* change request: invalid rejected, valid accepted */
    assert.equal((await put("update", { bookings: { b1: { contactChange: { id: "cc1abc", name: "<script>", phone: "12" } } } })).status, 400);
    assert.equal((await put("update", { bookings: { b1: { contactChange: { id: "cc1abcd", name: "Lakshmi R", phone: "9123456780", why: "My mother travels", at: 1 } } } })).status, 200);
    /* customers can't approve their own change */
    assert.equal((await cu("/api/db/doc", { method: "POST", body: { path: "decisions/" + uid, op: "set", data: { bookings: { b1: { contact: { name: "Lakshmi R", phone: "9123456780" } } } } } })).status, 403);
    /* owner approves */
    await own("/api/auth/login", { method: "POST", body: { login: "o@st.in", password: "owner-pass-123" } });
    assert.equal((await own("/api/db/doc", { method: "POST", body: { path: "decisions/" + uid, op: "set", data: { bookings: { b1: { contact: { name: "Lakshmi R", phone: "9123456780", reqId: "cc1abcd" }, contactDecision: { reqId: "cc1abcd", status: "approved", at: 2 } } } } } })).status, 200);
    const dec = (await cu("/api/db/doc?path=" + encodeURIComponent("decisions/" + uid))).body;
    assert.equal(dec.data.bookings.b1.contact.phone, "9123456780", "customer can read the approval");
  } finally { app.locals.store.flushNow(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("notifications: owner hears about the request; after approval, trip messages go to the new number", async () => {
  const T0 = Date.parse("2026-11-10T06:00:00+05:30");
  const D = { meta: { ownerId: "own" }, users: { own: { name: "Owner", email: "owner@x.in", phone: "9000000001" }, c1: { name: "Ravi", email: "ravi@x.in", phone: "9876543210" } }, docs: {}, payments: {} };
  D.docs["site/config"] = { data: { name: "Sashwanth Travels", whatsapp: "+91 90000 00001" } };
  D.docs["requests/c1"] = { data: { profile: { name: "Ravi", phone: "9876543210" }, bookings: { b1: { ref: "ST-1", from: "Chennai", to: "Madurai", date: "2026-11-20", time: "10:00", days: 2, km: 462, type: "round", name: "Ravi", phone: "9876543210" } } } };
  D.docs["decisions/c1"] = { data: { bookings: { b1: { status: "confirmed", at: T0 - 1000 } } } };
  const wa = [], fetchImpl = async (url, init) => { const b = JSON.parse(init.body); if (url.includes("graph.facebook.com")) { wa.push(b); return { ok: true, status: 200, json: async () => ({ messages: [{ id: "x" }] }) }; } return { ok: true, status: 200, json: async () => ({ type: "success" }) }; };
  const n = createNotifier({ D, store: { save() {} }, env: { WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_ID: "1", WHATSAPP_TEMPLATE: "booking_update" }, fetchImpl, mailer: { sendMail: async () => {} }, log: { warn() {}, error() {} }, now: () => T0 });
  await n.scan(); /* baseline */
  D.docs["requests/c1"].data.bookings.b1.contactChange = { id: "cc1abcd", name: "Lakshmi R", phone: "9123456780", at: T0 };
  await n.scan();
  const text = w => w.template.components[0].parameters[0].text;
  assert.ok(wa.some(w => w.to === "919000000001" && /change the contact on ST-1 .* to Lakshmi R 9123456780/.test(text(w))), "owner told about the request");
  D.docs["decisions/c1"].data.bookings.b1.contact = { name: "Lakshmi R", phone: "9123456780", reqId: "cc1abcd" };
  D.docs["decisions/c1"].data.bookings.b1.contactDecision = { reqId: "cc1abcd", status: "approved", at: T0 };
  D.docs["decisions/c1"].data.bookings.b1.note = "Pickup moved to 9:30";
  await n.scan(); await n.scan();
  assert.ok(wa.some(w => w.to === "919123456780" && /contact for ST-1 .* is now Lakshmi R/.test(text(w))), "new number told about approval");
  assert.ok(wa.some(w => w.to === "919123456780" && /Pickup moved to 9:30/.test(text(w))), "later trip updates go to the new number");
  assert.ok(!wa.some(w => w.to === "919876543210" && /Pickup moved/.test(text(w))), "not to the old number");
});

test("reviews: only after the trip is completed, 1–5 stars, owner publishes to the public list", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-rv-"));
  const app = createApp({ dataDir: dir, limitScale: 20, owner: { name: "Owner", email: "o@st.in", phone: "9000000001", password: "owner-pass-123" } });
  await app.locals.ready; const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = "http://127.0.0.1:" + server.address().port, cu = client(base), own = client(base), guest = client(base);
  try {
    const uid = (await cu("/api/auth/signup", { method: "POST", body: { name: "Ravi Kumar", email: "ravi@x.in", phone: "9876543210", password: "Sunset#Road71" } })).body.user.id;
    const put = data => cu("/api/db/doc", { method: "POST", body: { path: "requests/" + uid, op: "update", data } });
    await cu("/api/db/doc", { method: "POST", body: { path: "requests/" + uid, op: "set", data: { bookings: { b1: { ref: "ST-1", from: "Chennai", to: "Ooty", date: "2026-10-01", name: "Ravi Kumar", phone: "9876543210" } } } } });
    const early = await put({ bookings: { b1: { review: { stars: 5, text: "Great", at: 1 } } } });
    assert.equal(early.status, 403); assert.match(early.body.error, /after it is completed/);
    await own("/api/auth/login", { method: "POST", body: { login: "o@st.in", password: "owner-pass-123" } });
    await own("/api/db/doc", { method: "POST", body: { path: "decisions/" + uid, op: "set", data: { bookings: { b1: { status: "completed", at: 2 } } } } });
    assert.equal((await put({ bookings: { b1: { review: { stars: 9, text: "x", at: 3 } } } })).status, 400);
    assert.equal((await put({ bookings: { b1: { review: { stars: 4, text: "Clean car, polite driver.", at: 3 } } } })).status, 200);
    /* customers can't publish reviews themselves */
    assert.equal((await cu("/api/db/doc", { method: "POST", body: { path: "site/reviews", op: "set", data: { items: { fake: { stars: 5 } } } } })).status, 403);
    assert.equal((await own("/api/db/doc", { method: "POST", body: { path: "site/reviews", op: "set", data: { items: { b1: { stars: 4, text: "Clean car, polite driver.", name: "Ravi K.", route: "Chennai → Ooty" } } } } })).status, 200);
    const pub = (await guest("/api/db/doc?path=" + encodeURIComponent("site/reviews"))).body;
    assert.equal(pub.data.items.b1.stars, 4, "visitors can read published reviews");
    assert.ok(!JSON.stringify(pub).includes("9876543210"), "no phone number in public reviews");
  } finally { app.locals.store.flushNow(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});
