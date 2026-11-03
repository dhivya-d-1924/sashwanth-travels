"use strict";
/*
 * Notification engine: Gmail (SMTP), WhatsApp (Meta Cloud API) and SMS (MSG91, DLT-compliant).
 * It watches the booking data and sends each message once (idempotent keys), retries a failed channel
 * at most 3 times, and never sends stale reminders. On first start it records the current state as a
 * baseline so old bookings don't trigger a burst of messages.
 */
const crypto = require("crypto");

const IST = "+05:30";
const H = 36e5, MIN = 6e4;
const istMs = (date, time) => Date.parse(`${date}T${(time || "06:00").slice(0, 5)}:00${IST}`);
const fmtIST = ms => new Date(ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const fmtDay = d => { try { return new Date(d + "T00:00:00" + IST).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" }); } catch { return d; } };
const addDays = (iso, n) => new Date(Date.parse(iso + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const hash = s => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 10);
/* Local wall-clock time in an IANA zone → epoch ms (for airline times). */
function zonedMs(local, tz) {
  const guess = Date.parse(local.slice(0, 19) + "Z");
  if (!tz) return Date.parse(local.slice(0, 19) + IST);
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(guess));
    const g = Object.fromEntries(parts.map(p => [p.type, p.value]));
    const asUtc = Date.parse(`${g.year}-${g.month}-${g.day}T${g.hour}:${g.minute}:${g.second}Z`);
    return guess - (asUtc - guess);
  } catch { return Date.parse(local.slice(0, 19) + IST); }
}
/* India mobile → 91XXXXXXXXXX; other E.164 numbers kept as digits. */
function waNumber(p) {
  const raw = String(p || "").trim(), d = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return d.length >= 10 && d.length <= 15 ? d : null;
  if (d.length === 10) return "91" + d;
  if (d.length === 12 && d.startsWith("91")) return d;
  if (d.length === 11 && d.startsWith("0")) return "91" + d.slice(1);
  return null;
}
const oneLine = s => String(s || "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim();

function createNotifier({ D, store, env = process.env, fetchImpl = fetch, mailer = null, log = console, now = () => Date.now() }) {
  if (!D.notify) D.notify = { sent: {}, log: [], baseline: false };
  const N = D.notify;
  const brand = () => ((D.docs["site/config"] || {}).data || {}).name || "Sashwanth Travels";
  const siteUrl = () => (env.PUBLIC_URL || "").replace(/\/$/, "");

  /* ---------- channels ---------- */
  const ch = {
    email: !!(env.SMTP_USER && env.SMTP_PASS),
    whatsapp: !!(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID && env.WHATSAPP_TEMPLATE),
    sms: !!(env.MSG91_AUTHKEY && env.MSG91_TEMPLATE_ID)
  };
  let transport = mailer;
  if (!transport && ch.email) {
    const nodemailer = require("nodemailer");
    transport = nodemailer.createTransport({ host: env.SMTP_HOST || "smtp.gmail.com", port: Number(env.SMTP_PORT || 465), secure: Number(env.SMTP_PORT || 465) === 465, auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } });
  }
  async function sendEmail(to, subject, text) {
    const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;border:1px solid #e5e5e5;border-radius:10px;overflow:hidden"><div style="background:#13213A;color:#fff;padding:14px 18px;font-weight:bold">${esc(brand())}</div><div style="padding:18px;color:#222;line-height:1.55;white-space:pre-line">${esc(text)}</div>${siteUrl() ? `<div style="padding:0 18px 18px"><a href="${esc(siteUrl())}/#trips" style="background:#E39E12;color:#13213A;padding:10px 16px;border-radius:20px;text-decoration:none;font-weight:bold">Open My Trips</a></div>` : ""}<div style="padding:10px 18px;font-size:12px;color:#777;border-top:1px solid #eee">You get this because you have a booking with us. Turn off email updates in My account → Notifications.</div></div>`;
    await transport.sendMail({ from: env.MAIL_FROM || `"${brand()}" <${env.SMTP_USER}>`, to, subject, text, html });
  }
  async function sendWhatsApp(phone, text) {
    const to = waNumber(phone); if (!to) throw new Error("No valid mobile number");
    const r = await fetchImpl(`https://graph.facebook.com/${env.WHATSAPP_API_VERSION || "v21.0"}/${encodeURIComponent(env.WHATSAPP_PHONE_ID)}/messages`, {
      method: "POST", headers: { Authorization: "Bearer " + env.WHATSAPP_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: env.WHATSAPP_TEMPLATE, language: { code: env.WHATSAPP_LANG || "en" }, components: [{ type: "body", parameters: [{ type: "text", text: oneLine(text).slice(0, 1000) }] }] } })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || "WhatsApp HTTP " + r.status);
  }
  /* MSG91 Flow (India DLT): the approved template must use ##var1## (short status) and ##var2## (booking ref). */
  async function sendSms(phone, short, ref) {
    const to = waNumber(phone); if (!to || !to.startsWith("91")) throw new Error("SMS is sent to Indian mobile numbers only");
    const r = await fetchImpl("https://control.msg91.com/api/v5/flow", {
      method: "POST", headers: { authkey: env.MSG91_AUTHKEY, "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ template_id: env.MSG91_TEMPLATE_ID, short_url: "0", recipients: [{ mobiles: to, var1: oneLine(short).slice(0, 30), var2: String(ref || "").slice(0, 30) }] })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.type === "error") throw new Error(j.message || "SMS HTTP " + r.status);
  }

  /* ---------- recipients ---------- */
  const prefsOf = uid => (((D.docs["requests/" + uid] || {}).data || {}).prefs) || {};
  function customer(uid) {
    const u = D.users[uid] || {}, prof = (((D.docs["requests/" + uid] || {}).data || {}).profile) || {}, p = prefsOf(uid);
    return { uid, name: prof.name || u.name || "", email: u.email || "", phone: prof.phone || u.phone || "", want: { email: p.nEmail !== "off", whatsapp: p.nWhatsapp !== "off", sms: p.nSms !== "off" } };
  }
  function owner() {
    const u = D.users[D.meta.ownerId] || {}, c = (D.docs["site/config"] || {}).data || {};
    return { uid: D.meta.ownerId, name: u.name || "Owner", email: env.OWNER_NOTIFY_EMAIL || u.email || "", phone: env.OWNER_NOTIFY_PHONE || c.whatsapp || u.phone || "", want: { email: true, whatsapp: true, sms: false } };
  }

  /* ---------- idempotent delivery with limited retries ---------- */
  async function deliver(key, to, msg) {
    const rec = N.sent[key] || (N.sent[key] = { at: now(), to: to.uid || "", ref: msg.ref || "", text: msg.text.slice(0, 300), ch: {} });
    const jobs = [];
    const want = (name, ok, fn) => {
      const st = rec.ch[name];
      if (!ch[name] || !to.want[name] || !ok) return;
      if (st && (st.ok || st.tries >= 3)) return;
      jobs.push((async () => {
        const s = rec.ch[name] || (rec.ch[name] = { tries: 0 });
        s.tries++; s.at = now();
        try { await fn(); s.ok = true; delete s.err; }
        catch (e) { s.ok = false; s.err = String(e.message || e).slice(0, 160); log.warn(`[notify] ${name} ${key}: ${s.err}`); }
      })());
    };
    want("email", !!to.email, () => sendEmail(to.email, msg.subject, msg.text));
    want("whatsapp", !!to.phone, () => sendWhatsApp(to.phone, msg.text));
    want("sms", !!to.phone && !!msg.short, () => sendSms(to.phone, msg.short, msg.ref));
    if (!jobs.length) { if (!Object.keys(rec.ch).length) rec.skipped = true; return; } /* nothing to send now: don't replay it later */
    await Promise.all(jobs);
    N.log.unshift({ at: now(), key, ref: msg.ref || "", to: to.name || to.email || to.phone, text: msg.text.slice(0, 200), ch: JSON.parse(JSON.stringify(rec.ch)) });
    N.log.length = Math.min(N.log.length, 200);
    store.save();
  }

  /* ---------- what should be sent right now ---------- */
  function cabStatus(b, d) {
    d = d || {};
    if (["on_trip", "completed", "rejected"].includes(d.status)) return d.status;
    if (b.cancelledAt) return "cancelled";
    return d.status || (b.payment ? "payment_submitted" : "awaiting_payment");
  }
  function due() {
    const out = [], t = now();
    const at = (target, early, late) => t >= target - early && t <= target + late;
    for (const [path, doc] of Object.entries(D.docs)) {
      /* ---- cab bookings ---- */
      if (path.startsWith("requests/")) {
        const uid = path.slice(9), r = doc.data || {}, dec = (((D.docs["decisions/" + uid] || {}).data || {}).bookings) || {}, who0 = customer(uid);
        for (const [id, b] of Object.entries(r.bookings || {})) {
          const d = dec[id] || {}, s = cabStatus(b, d), ref = b.ref || id, route = `${b.from} → ${b.to}`;
          /* An owner-approved contact change: trip messages go to the new name and number (email stays with the account). */
          const who = d.contact && d.contact.phone ? { ...who0, name: d.contact.name || who0.name, phone: d.contact.phone } : who0;
          if (b.review && b.review.stars && b.review.at) out.push({ key: `own:review:${id}:${b.review.at}`, to: owner(), ref, subject: `New ${b.review.stars}★ review · ${ref}`, text: `New ${b.review.stars}-star review for ${ref} (${route}) from ${who0.name}${b.review.text ? `: "${String(b.review.text).slice(0, 300)}"` : "."} Publish or reply in Owner console → Reviews.` });
          const cc = b.contactChange, cd = d.contactDecision;
          if (cc && cc.id && !(cd && cd.reqId === cc.id) && !["cancelled", "rejected", "completed"].includes(s))
            out.push({ key: `own:cc:${id}:${cc.id}`, to: owner(), ref, subject: `Contact change request ${ref}`, text: `Customer asks to change the contact on ${ref} (${route}) to ${cc.name} ${cc.phone}${cc.why ? ` (${cc.why})` : ""}. Approve or reject in Owner console → Bookings.` });
          if (cc && cd && cd.reqId === cc.id) {
            const okMsg = cd.status === "approved";
            out.push({ key: `cc:${id}:${cc.id}:${cd.status}`, to: okMsg ? who : who0, ref, short: okMsg ? "Contact updated" : "Contact change not approved", subject: `${okMsg ? "Contact updated" : "Contact change not approved"} · ${ref}`, text: okMsg ? `The contact for ${ref} (${route}) is now ${cc.name}, ${cc.phone}. Trip updates will come to this number.` : `Your request to change the contact on ${ref} wasn't approved${cd.note ? ": " + cd.note : "."} Please call us if you need help.` });
          }
          out.push({ key: `own:new:${id}`, to: owner(), ref, subject: `New booking request ${ref}`, text: `New booking request ${ref}: ${route} on ${fmtDay(b.date)} for ${b.days} day(s), ${b.pax || "?"} passenger(s), ${b.vehicleName || ""}. Customer: ${who.name} ${who.phone}.` });
          const label = { confirmed: "Booking confirmed", rejected: "Vehicle not available", changes_requested: "Owner needs information", cancelled: "Booking cancelled", on_trip: "Trip started", completed: "Trip completed" }[s];
          if (label) out.push({ key: `cab:${id}:${s}`, to: who, ref, short: label, subject: `${label} · ${ref}`, text: `${label}: ${ref}, ${route} on ${fmtDay(b.date)}.${d.note ? " Note: " + d.note : ""}${s === "completed" && d.bill ? "" : ""}` });
          /* A note already included in the status message isn't sent twice. */
          if (label && d.note && !N.sent[`cab:${id}:${s}`]) out.push({ key: `cabnote:${id}:${hash(d.note)}`, cover: true });
          if (d.note && !["rejected", "changes_requested"].includes(s)) out.push({ key: `cabnote:${id}:${hash(d.note)}`, to: who, ref, short: "Update on your trip", subject: `Update on ${ref}`, text: `Update on ${ref} (${route}): ${d.note}` });
          if (d.assign && d.assign.driverName && s === "confirmed") out.push({ key: `cabdrv:${id}:${hash(d.assign.driverName + d.assign.vehicleNo + d.assign.driverPhone)}`, to: who, ref, short: "Driver assigned", subject: `Driver details for ${ref}`, text: `Driver for ${ref}: ${d.assign.driverName}, ${d.assign.driverPhone}, vehicle ${d.assign.vehicleNo}. Pickup ${fmtDay(b.date)} at ${b.time || "06:00"}${b.pickup ? " from " + b.pickup : ""}.` });
          if (s === "confirmed" || s === "on_trip") {
            const pick = istMs(b.date, b.time);
            if (s === "confirmed" && at(pick - 24 * H, 0, 6 * H)) out.push({ key: `cab24:${id}`, to: who, ref, short: "Pickup tomorrow", subject: `Pickup tomorrow · ${ref}`, text: `Reminder: pickup for ${ref} (${route}) is tomorrow, ${fmtIST(pick)}${b.pickup ? ", " + b.pickup : ""}.${d.assign ? ` Driver ${d.assign.driverName}, ${d.assign.driverPhone}.` : ""}` });
            if (s === "confirmed" && at(pick - 2 * H, 0, 90 * MIN)) out.push({ key: `cab2h:${id}`, to: who, ref, short: "Pickup in 2 hours", subject: `Pickup in 2 hours · ${ref}`, text: `Your vehicle for ${ref} arrives in about 2 hours (${fmtIST(pick)}). Please be ready${b.pickup ? " at " + b.pickup : ""}.${d.assign ? ` Driver ${d.assign.driverName}, ${d.assign.driverPhone}, ${d.assign.vehicleNo}.` : ""}` });
            /* Estimated arrival alarm: road km ÷ 45 km/h from pickup, 30 minutes before. */
            const km = Number(b.km) || 0;
            if (km > 0) { const eta = pick + (km / 45) * H; if (at(eta - 30 * MIN, 0, 40 * MIN)) out.push({ key: `cabeta:${id}`, to: who, ref, short: `Near ${String(b.to).slice(0, 20)}`, subject: `Arriving soon at ${b.to}`, text: `You should reach ${b.to} in about 30 minutes (estimated ${fmtIST(eta)}, based on road distance). Keep your belongings ready.` }); }
            /* Trip-ending alarm on the last day. */
            const last = addDays(b.date, Math.max(1, Number(b.days) || 1) - 1), endMorning = istMs(last, "08:00");
            if (at(endMorning, 0, 6 * H)) out.push({ key: `cabend:${id}`, to: who, ref, short: "Trip ends today", subject: `Your trip ends today · ${ref}`, text: `Your trip ${ref} ends today (${fmtDay(last)}). ${b.type === "oneway" ? `Drop at ${b.to}.` : `Return to ${b.from} by evening.`} The final bill is based on the odometer reading; the advance is deducted.` });
          }
        }
        for (const [tid, tk] of Object.entries(r.tickets || {})) out.push({ key: `own:ticket:${uid}:${tid}`, to: owner(), ref: "", subject: "Customer message", text: `Message from ${tk.name || who0.name} ${tk.phone || who0.phone}: ${tk.message}` });
      }
      /* ---- flights & hotels ---- */
      if (path.startsWith("travel/")) {
        const uid = path.slice(7), who = customer(uid);
        for (const b of Object.values((doc.data || {}).bookings || {})) {
          const ref = b.ref, what = b.kind === "flight" ? "flight" : "hotel";
          const msgs = {
            confirming: ["Payment received", `Payment of ₹${b.payment ? b.payment.amount : b.price.total} received for ${ref} (${b.title}). We're confirming with the ${b.kind === "flight" ? "airline" : "hotel"}; it isn't confirmed yet.`],
            confirmed: [b.kind === "flight" ? "Flight confirmed" : "Hotel confirmed", `${b.kind === "flight" ? "Flight" : "Hotel"} confirmed: ${b.title}, ${fmtDay(b.travelDate)}. ${b.kind === "flight" ? "Airline PNR" : "Hotel confirmation"}: ${b.reference}.`],
            failed_refunded: ["Not confirmed, refunded", `Sorry, the ${b.kind === "flight" ? "airline" : "hotel"} couldn't confirm ${ref}. ₹${b.refund ? b.refund.amount : ""} has been refunded (5–7 working days). We can find alternatives in My Trips.`],
            failed_refund_pending: ["Not confirmed", `Sorry, ${ref} couldn't be confirmed. Your refund is being processed; we'll update you.`],
            cancelled: ["Booking cancelled", `${ref} is cancelled.${b.refund && b.refund.amount ? ` Refund ₹${b.refund.amount} started (5–7 working days).` : ""}`]
          }[b.status];
          if (msgs && !(b.status === "cancelled" && !b.payment)) out.push({ key: `tr:${b.id}:${b.status}`, to: who, ref, short: msgs[0], subject: `${msgs[0]} · ${ref}`, text: msgs[1] });
          if (b.status === "failed_refund_pending") out.push({ key: `own:refpend:${b.id}`, to: owner(), ref, subject: `Refund pending ${ref}`, text: `Provider failed for ${ref} and the automatic refund didn't go through. Owner console → Flights & hotels → Retry refund.` });
          if (b.status === "confirmed" && b.kind === "flight" && b.offer && b.offer.slices) {
            b.offer.slices.forEach((s, i) => {
              const dep = zonedMs(s.departAt, s.fromTz), arr = dep + (Number(s.minutes) || 0) * MIN;
              if (at(dep - 24 * H, 0, 6 * H)) out.push({ key: `fl24:${b.id}:${i}`, to: who, ref, short: "Flight tomorrow", subject: `Flight tomorrow · ${b.reference}`, text: `Reminder: ${s.from} → ${s.to} departs tomorrow at ${s.departAt.slice(11, 16)} local time. PNR ${b.reference}. Web check-in usually opens 24–48 hours before.` });
              if (at(dep - 3 * H, 0, 90 * MIN)) out.push({ key: `fl3h:${b.id}:${i}`, to: who, ref, short: "Flight in 3 hours", subject: `Flight in 3 hours · ${b.reference}`, text: `Your flight ${s.from} → ${s.to} departs at ${s.departAt.slice(11, 16)} local time. Reach the airport now; carry ID matching the booking. PNR ${b.reference}.` });
              if (s.minutes && at(arr - 30 * MIN, 0, 40 * MIN)) out.push({ key: `flland:${b.id}:${i}`, to: who, ref, short: `Landing soon at ${s.to}`, subject: `Landing soon at ${s.toCity || s.to}`, text: `Your flight should land at ${s.toCity || s.to} (${s.to}) in about 30 minutes (scheduled ${s.arriveAt.slice(11, 16)} local time).` });
            });
          }
          if (b.status === "confirmed" && b.kind === "hotel") {
            const ci = istMs(b.travelDate, "18:00") - 24 * H, co = istMs(b.endDate, "08:00");
            if (at(ci, 0, 8 * H)) out.push({ key: `htin:${b.id}`, to: who, ref, short: "Check-in tomorrow", subject: `Check-in tomorrow · ${b.offer.hotel}`, text: `Reminder: check-in at ${b.offer.hotel} tomorrow (${fmtDay(b.travelDate)}). Confirmation ${b.reference}. Carry a photo ID.` });
            if (at(co, 0, 4 * H)) out.push({ key: `htout:${b.id}`, to: who, ref, short: "Check-out today", subject: `Check-out today · ${b.offer.hotel}`, text: `Your stay at ${b.offer.hotel} ends today. Check the hotel's check-out time and collect your belongings.` });
          }
        }
      }
    }
    for (const [oid, p] of Object.entries(D.payments || {})) if (p.status === "paid") out.push({ key: `own:paid:${oid}`, to: owner(), ref: p.ref || "", subject: `Payment received ${p.ref || ""}`, text: `Online payment received: ₹${p.amount / 100} for ${p.ref || p.bookingId}${p.kind === "travel" ? " (flight/hotel)" : " (cab advance)"}.` });
    return out;
  }

  let running = false, again = false;
  async function scan() {
    if (running) { again = true; return; }
    running = true;
    try {
      const list = due();
      if (!N.baseline) { for (const m of list) N.sent[m.key] = { at: now(), baseline: true, ch: {} }; N.baseline = true; store.save(); return; }
      for (const m of list) {
        const r = N.sent[m.key];
        if (m.cover) { if (!r) N.sent[m.key] = { at: now(), skipped: true, ch: {} }; continue; }
        if (r && (r.baseline || r.skipped)) continue;
        if (r && Object.keys(r.ch).length && Object.values(r.ch).every(x => x.ok || x.tries >= 3)) continue;
        await deliver(m.key, m.to, m);
      }
      /* keep the log small: forget keys older than 120 days */
      const cut = now() - 120 * 864e5; for (const [k, v] of Object.entries(N.sent)) if (v.at < cut) delete N.sent[k];
    } catch (e) { log.error("[notify] scan", e.message); }
    finally { running = false; if (again) { again = false; setTimeout(scan, 500); } }
  }
  let timer = null, deb = null;
  return {
    channels: ch, scan, due,
    poke() { clearTimeout(deb); deb = setTimeout(scan, 2000); },
    start() { if (!timer) { timer = setInterval(scan, 60e3); timer.unref && timer.unref(); const t0 = setTimeout(scan, 3000); t0.unref && t0.unref(); } },
    stop() { clearInterval(timer); clearTimeout(deb); timer = null; },
    async test(to) { const m = { subject: `${brand()} test message`, text: `Test message from ${brand()}: notifications are working.`, short: "Test message", ref: "TEST" }; const key = "test:" + now(); await deliver(key, { ...to, want: { email: true, whatsapp: true, sms: true } }, m); return N.sent[key].ch; },
    status() { return { channels: ch, log: N.log.slice(0, 50) }; }
  };
}

module.exports = { createNotifier, waNumber, zonedMs };
