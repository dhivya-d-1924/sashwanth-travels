"use strict";
/*
 * Razorpay payment gateway for the booking advance.
 *
 * Flow: the customer taps "Pay online" → POST /api/pay/order (server prices the advance from
 * the rate card and creates a Razorpay order) → Razorpay Checkout → POST /api/pay/verify
 * (signature check + payment re-fetched from Razorpay) → booking auto-confirmed and the vehicle
 * blocked on the calendar. A webhook (/api/pay/webhook) finalizes payments whose browser closed
 * before verifying. Finalizing is idempotent. The owner can refund from the console.
 */
const crypto = require("crypto");
const { quoteBooking, freeUnits, todayISO, findRoute } = require("./pricing");
const { deepMerge } = require("./store");

const API = "https://api.razorpay.com/v1";
const hmac = (secret, msg) => crypto.createHmac("sha256", secret).update(msg).digest("hex");
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function createPayments(ctx) {
  const { D, store, changed, HttpError, keyId, keySecret, webhookSecret, routeKm } = ctx;
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const enabled = !!(keyId && keySecret);
  D.payments = D.payments || {};
  D.meta.webhookEvents = D.meta.webhookEvents || [];

  async function rz(method, path, body) {
    const res = await fetchImpl(API + path, {
      method,
      headers: { Authorization: "Basic " + Buffer.from(keyId + ":" + keySecret).toString("base64"), "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (data.error && data.error.description) || `Razorpay error ${res.status}`;
      throw new HttpError(res.status >= 500 ? 502 : 400, msg);
    }
    return data;
  }
  const doc = p => (D.docs[p] && D.docs[p].data) || null;
  function mergeDoc(p, patch, by) {
    const cur = D.docs[p];
    D.docs[p] = { data: cur ? deepMerge(cur.data, patch) : patch, version: (cur ? cur.version : 0) + 1, updatedAt: Date.now(), by };
    changed(p);
  }
  const blockedStatus = s => ["confirmed", "on_trip", "completed", "rejected", "cancelled"].includes(s);

  /* ---------- create an order for a booking's advance ---------- */
  async function createOrder(uid, bookingId) {
    if (!enabled) throw new HttpError(503, "Online payment isn't set up yet. Please pay by UPI/bank and send the reference.");
    const cfg = doc("site/config");
    if (!cfg || cfg.sample) throw new HttpError(409, "Bookings open once the owner publishes real details.");
    const b = ((doc("requests/" + uid) || {}).bookings || {})[bookingId];
    if (!b) throw new HttpError(404, "Booking not found");
    const dec = (((doc("decisions/" + uid) || {}).bookings) || {})[bookingId] || {};
    if (b.cancelledAt || blockedStatus(dec.status)) throw new HttpError(409, "This booking isn't waiting for payment.");
    if (dec.advancePaid) throw new HttpError(409, "The advance for this booking is already paid.");
    if (!b.date || b.date < todayISO()) throw new HttpError(409, "This trip's start date has passed. Please send a new request.");
    /* Business rule: for a route not in the owner's table, the road distance comes from the map, not from the
       browser. A customer-entered km more than 10% below the map distance is raised to the map distance. */
    let bq = b, kmAdjusted = null;
    if (!findRoute(cfg, b.from, b.to) && typeof routeKm === "function") {
      const mapKm = await routeKm(b.from, b.to).catch(() => null);
      if (mapKm && (Number(b.km) || 0) < mapKm * 0.9) { bq = { ...b, km: mapKm }; kmAdjusted = { entered: Number(b.km) || 0, map: mapKm }; }
    }
    const q = quoteBooking(cfg, bq);
    if (!q) throw new HttpError(409, "This vehicle is no longer offered. Please send a new request.");
    const amount = Math.round(q.fare.advance * 100);
    if (amount < 100) throw new HttpError(409, "No advance is due for this booking. The owner will confirm it.");
    const blocks = (doc("site/availability") || {}).blocks || {};
    if (freeUnits(cfg, blocks, b.vehicleId, b.date, b.days, bookingId) < 1) throw new HttpError(409, "Sorry, this vehicle has just been booked for these dates. Please choose another vehicle or date.");
    /* Reuse a recent unpaid order for the same booking and amount (customer retrying). */
    const reuse = Object.entries(D.payments).find(([, p]) => p.uid === uid && p.bookingId === bookingId && p.status === "created" && p.amount === amount && Date.now() - p.at < 30 * 60e3);
    let orderId;
    if (reuse) orderId = reuse[0];
    else {
      const order = await rz("POST", "/orders", { amount, currency: "INR", receipt: String(b.ref || bookingId).slice(0, 40), notes: { bookingId, ref: String(b.ref || ""), uid } });
      orderId = order.id;
      D.payments[orderId] = { uid, bookingId, ref: b.ref, amount, currency: "INR", status: "created", at: Date.now(), quote: { rc: q.rc, fare: { total: q.fare.total, advance: q.fare.advance, chargeKm: q.fare.chargeKm }, kmAdjusted }, refunds: [] };
      store.save();
    }
    const u = D.users[uid] || {};
    return {
      keyId, orderId, amount, currency: "INR", name: cfg.name || "Sashwanth Travels",
      description: `Advance for ${b.ref || "your trip"} · ${b.from} → ${b.to}`, kmAdjusted,
      prefill: { name: b.name || u.name || "", contact: b.phone || u.phone || "", email: u.email || "" }
    };
  }

  /* ---------- mark an order paid (idempotent) ---------- */
  async function finalize(orderId, paymentId, source) {
    const rec = D.payments[orderId];
    if (!rec) throw new HttpError(404, "Unknown order");
    if (rec.status === "paid") return { ok: true, already: true, status: rec.outcome };
    /* Never trust the browser: confirm the payment with Razorpay itself. */
    let p = await rz("GET", "/payments/" + encodeURIComponent(paymentId));
    if (p.order_id !== orderId || Number(p.amount) !== rec.amount || p.currency !== rec.currency) throw new HttpError(400, "Payment doesn't match this order.");
    if (p.status === "authorized") p = await rz("POST", "/payments/" + encodeURIComponent(paymentId) + "/capture", { amount: rec.amount, currency: rec.currency });
    if (p.status !== "captured") throw new HttpError(402, "The payment wasn't completed. You have not been charged.");
    if (D.payments[orderId].status === "paid") return { ok: true, already: true, status: rec.outcome }; // raced with webhook

    const now = Date.now(), { uid, bookingId } = rec;
    rec.status = "paid"; rec.paymentId = paymentId; rec.paidAt = now; rec.source = source; rec.method = p.method || "";
    /* Flights/hotels: hand over to the travel module, which confirms with the provider (or refunds). */
    if (rec.kind === "travel") {
      rec.outcome = "travel_paid"; store.save();
      if (api.onTravelPaid) await api.onTravelPaid(rec);
      return { ok: true, status: rec.outcome };
    }
    const paidOnline = { orderId, paymentId, amount: rec.amount / 100, method: p.method || "", at: now };
    mergeDoc("requests/" + uid, { bookings: { [bookingId]: { payment: { method: "Paid online" + (p.method ? ` (${String(p.method).toUpperCase()})` : ""), utr: paymentId, at: now, online: true } } } }, "system");

    const cfg = doc("site/config") || {};
    const b = ((doc("requests/" + uid) || {}).bookings || {})[bookingId] || {};
    const dec = (((doc("decisions/" + uid) || {}).bookings) || {})[bookingId] || {};
    const blocks = (doc("site/availability") || {}).blocks || {};
    const at = now + 1, log = {};
    let patch;
    if (b.cancelledAt || ["rejected", "cancelled"].includes(dec.status)) {
      patch = { paidOnline, advancePaid: true, note: "We received your advance after this booking was cancelled. The owner will refund it.", at };
      log[at] = "System: payment received on a cancelled booking — refund needed";
      rec.outcome = "needs_refund";
    } else if (freeUnits(cfg, blocks, b.vehicleId, b.date, b.days, bookingId) > 0) {
      patch = { status: "confirmed", advancePaid: true, paidOnline, rc: rec.quote.rc, fare: rec.quote.fare, note: "Advance received online. Your booking is confirmed.", at };
      log[at] = `System: ₹${rec.amount / 100} paid online (${paymentId}); booking confirmed`;
      mergeDoc("site/availability", { blocks: { [bookingId]: { vehicleId: b.vehicleId, from: b.date, to: b.endDate || b.date, reason: "Booking " + (b.ref || bookingId) + " (paid online)" } } }, "system");
      rec.outcome = "confirmed";
    } else {
      patch = { status: "changes_requested", advancePaid: true, paidOnline, note: "We received your advance, but this vehicle was just booked for these dates. The owner will call you to rebook or refund.", at };
      log[at] = "System: paid online but no vehicle free — owner to rebook or refund";
      rec.outcome = "no_vehicle";
    }
    patch.log = log;
    mergeDoc("decisions/" + uid, { bookings: { [bookingId]: patch } }, "system");
    store.save();
    return { ok: true, status: rec.outcome };
  }

  async function verify(uid, { orderId, paymentId, signature }) {
    const rec = D.payments[String(orderId || "")];
    if (!rec || rec.uid !== uid) throw new HttpError(404, "Order not found");
    if (!paymentId || !signature || !safeEq(hmac(keySecret, orderId + "|" + paymentId), signature)) throw new HttpError(400, "Payment could not be verified. If money was deducted, it will be confirmed automatically or refunded.");
    return finalize(orderId, String(paymentId), "checkout");
  }

  /* Razorpay → server. Raw body required for the signature. */
  async function webhook(req, res) {
    if (!webhookSecret) return res.status(503).end();
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    if (!safeEq(hmac(webhookSecret, raw), req.get("x-razorpay-signature") || "")) return res.status(400).json({ error: "Bad signature" });
    const eventId = req.get("x-razorpay-event-id") || "";
    if (eventId && D.meta.webhookEvents.includes(eventId)) return res.json({ ok: true, duplicate: true });
    let ev; try { ev = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).end(); }
    if (eventId) { D.meta.webhookEvents.push(eventId); if (D.meta.webhookEvents.length > 1000) D.meta.webhookEvents.splice(0, 200); store.save(); }
    const pay = ev && ev.payload && ev.payload.payment && ev.payload.payment.entity;
    if ((ev.event === "payment.captured" || ev.event === "order.paid") && pay && D.payments[pay.order_id]) {
      try { await finalize(pay.order_id, pay.id, "webhook"); } catch (e) { console.error("[webhook]", e.message); }
    }
    if (ev.event === "payment.failed" && pay && D.payments[pay.order_id] && D.payments[pay.order_id].status === "created") {
      D.payments[pay.order_id].lastError = (pay.error_description || "Payment failed").slice(0, 200); store.save();
    }
    res.json({ ok: true });
  }

  /* Owner refunds (full or partial) on bookings paid online. */
  async function refund(uid, bookingId, rupees, byUid) {
    if (!enabled) throw new HttpError(503, "Online payment isn't set up.");
    const rec = Object.values(D.payments).find(p => p.uid === uid && p.bookingId === bookingId && p.status === "paid");
    if (!rec) throw new HttpError(404, "No online payment found for this booking.");
    const already = rec.refunds.reduce((s, r) => s + r.amount, 0);
    const left = rec.amount - already;
    const amount = rupees ? Math.round(Number(rupees) * 100) : left;
    if (!(amount >= 100) || amount > left) throw new HttpError(400, `Refund must be between ₹1 and ₹${left / 100}.`);
    const r = await rz("POST", "/payments/" + encodeURIComponent(rec.paymentId) + "/refund", { amount, notes: { bookingId, ref: String(rec.ref || "") } });
    const at = Date.now();
    rec.refunds.push({ id: r.id, amount, at, by: byUid });
    const total = (already + amount) / 100;
    mergeDoc("decisions/" + uid, { bookings: { [bookingId]: { refund: { amount: total, lastId: r.id, at, full: already + amount === rec.amount }, log: { [at]: `Owner: refunded ₹${amount / 100} (${r.id})` } } } }, byUid);
    store.save();
    return { refundId: r.id, refunded: total, remaining: (rec.amount - already - amount) / 100 };
  }

  /* Travel (flights/hotels): the travel module prices the booking; this creates the Razorpay order. */
  async function createTravelOrder(uid, booking) {
    if (!enabled) throw new HttpError(503, "Online payment isn't set up yet, so flights and hotels can't be paid for.");
    const amount = Math.round(booking.price.total * 100);
    const reuse = Object.entries(D.payments).find(([, p]) => p.kind === "travel" && p.uid === uid && p.bookingId === booking.id && p.status === "created" && p.amount === amount && Date.now() - p.at < 20 * 60e3);
    let orderId;
    if (reuse) orderId = reuse[0];
    else {
      const order = await rz("POST", "/orders", { amount, currency: "INR", receipt: booking.ref.slice(0, 40), notes: { kind: booking.kind, bookingId: booking.id, uid } });
      orderId = order.id;
      D.payments[orderId] = { kind: "travel", uid, bookingId: booking.id, ref: booking.ref, amount, currency: "INR", status: "created", at: Date.now(), refunds: [] };
      store.save();
    }
    const u = D.users[uid] || {};
    return { keyId, orderId, amount, currency: "INR", name: ((doc("site/config") || {}).name) || "Sashwanth Travels", description: booking.title, prefill: { name: u.name || "", contact: u.phone || "", email: u.email || "" } };
  }
  /* Refund (part of) a paid travel order. amountPaise is capped at what's left. */
  async function refundOrder(orderId, amountPaise, reason) {
    const rec = D.payments[orderId];
    if (!rec || rec.status !== "paid") throw new HttpError(404, "No completed payment to refund.");
    const left = rec.amount - rec.refunds.reduce((s, r) => s + r.amount, 0);
    const amount = Math.min(left, Math.round(amountPaise));
    if (amount < 100) return { refunded: 0 };
    const r = await rz("POST", "/payments/" + encodeURIComponent(rec.paymentId) + "/refund", { amount, notes: { reason: String(reason || "").slice(0, 200), ref: String(rec.ref || "") } });
    rec.refunds.push({ id: r.id, amount, at: Date.now(), reason });
    store.save();
    return { refunded: amount / 100, refundId: r.id };
  }
  const api = { enabled, keyId, createOrder, verify, finalize, webhook, refund, createTravelOrder, refundOrder, onTravelPaid: null };
  return api;
}

module.exports = { createPayments, hmac };
