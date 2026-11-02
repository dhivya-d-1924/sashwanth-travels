"use strict";
/*
 * Server-side copy of the fare and availability rules (the page uses the same formulas).
 * The server never trusts an amount sent by the browser: it recomputes from site/config.
 */
const norm = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
const todayISO = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function findRoute(cfg, a, b) {
  const A = norm(a), B = norm(b);
  for (const r of (cfg && cfg.routes) || []) {
    const f = norm(r.from), t = norm(r.to);
    if ((f === A && t === B) || (f === B && t === A)) return Number(r.km);
  }
  return null;
}
const rateCard = (cfg, v) => ({
  ratePerKm: Number(v.ratePerKm) || 0, minKmPerDay: Number(v.minKmPerDay) || 0, driverBata: Number(v.driverBata) || 0,
  nightCharge: Number(cfg.nightCharge) || 0, gstPercent: Number(cfg.gstPercent) || 0, advancePercent: Number(cfg.advancePercent) || 0
});
function priceWith(rc, runKm, days) {
  days = Math.max(1, Math.round(Number(days) || 1));
  const minKm = rc.minKmPerDay * days, chargeKm = Math.max(Math.max(0, Number(runKm) || 0), minKm);
  const base = chargeKm * rc.ratePerKm, bata = rc.driverBata * days, night = rc.nightCharge * Math.max(0, days - 1);
  const sub = base + bata + night, gst = Math.round(sub * rc.gstPercent) / 100, total = Math.round(sub + gst);
  const advance = Math.min(total, Math.ceil(total * rc.advancePercent / 100 / 10) * 10);
  return { runKm: Number(runKm) || 0, minKm, chargeKm, rate: rc.ratePerKm, base, bata, night, gst, gstPercent: rc.gstPercent, total, advance, days };
}
/* Price a customer's booking request from the business's own data. */
function quoteBooking(cfg, b) {
  const v = ((cfg && cfg.vehicles) || []).find(x => x.id === b.vehicleId);
  if (!v) return null;
  const tableKm = findRoute(cfg, b.from, b.to);
  const ow = tableKm != null ? tableKm : Math.max(0, Number(b.km) || 0);
  const rc = rateCard(cfg, v);
  return { vehicle: v, rc, fare: priceWith(rc, b.type === "oneway" ? ow : ow * 2, b.days) };
}
function freeUnits(cfg, blocks, vehicleId, start, days, ignoreId) {
  const v = ((cfg && cfg.vehicles) || []).find(x => x.id === vehicleId);
  if (!v) return 0;
  const end = addDays(start, Math.max(1, Number(days) || 1) - 1);
  const used = Object.entries(blocks || {}).filter(([id, x]) => id !== ignoreId && x.vehicleId === vehicleId && !(x.to < start || x.from > end)).length;
  return Math.max(0, (Number(v.count) || 0) - used);
}

module.exports = { findRoute, rateCard, priceWith, quoteBooking, freeUnits, todayISO, addDays };
