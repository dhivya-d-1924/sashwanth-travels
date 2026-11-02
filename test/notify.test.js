"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createNotifier, waNumber, zonedMs } = require("../server/notify.js");

const ENV = { SMTP_USER: "shop@gmail.com", SMTP_PASS: "app-pass", WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_ID: "123", WHATSAPP_TEMPLATE: "booking_update", MSG91_AUTHKEY: "k", MSG91_TEMPLATE_ID: "tpl" };
const T0 = Date.parse("2026-11-10T06:00:00+05:30");

function world() {
  const D = { meta: { ownerId: "own" }, users: { own: { name: "Owner", email: "owner@x.in", phone: "9000000001" }, c1: { name: "Ravi", email: "ravi@x.in", phone: "9876543210" } }, docs: {}, payments: {} };
  D.docs["site/config"] = { data: { name: "Sashwanth Travels", whatsapp: "+91 90000 00001" } };
  D.docs["requests/c1"] = { data: { profile: { name: "Ravi", phone: "9876543210" }, bookings: { b1: { ref: "ST-1", from: "Chennai", to: "Madurai", date: "2026-11-10", time: "10:00", days: 2, km: 462, type: "round", createdAt: T0 - 864e5 } } } };
  const sent = { email: [], wa: [], sms: [] }, ctl = { waFail: 0, now: T0 };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.includes("graph.facebook.com")) { if (ctl.waFail > 0) { ctl.waFail--; return { ok: false, status: 400, json: async () => ({ error: { message: "Template not approved" } }) }; } sent.wa.push(body); return { ok: true, status: 200, json: async () => ({ messages: [{ id: "w1" }] }) }; }
    if (url.includes("msg91")) { sent.sms.push(body); return { ok: true, status: 200, json: async () => ({ type: "success" }) }; }
    throw new Error("unexpected " + url);
  };
  const mailer = { sendMail: async m => { sent.email.push(m); } };
  const n = createNotifier({ D, store: { save() {} }, env: ENV, fetchImpl, mailer, log: { warn() {}, error() {} }, now: () => ctl.now });
  return { D, n, sent, ctl };
}
const decide = (D, patch) => { D.docs["decisions/c1"] = { data: { bookings: { b1: { ...(((D.docs["decisions/c1"] || {}).data || {}).bookings || {}).b1, ...patch } } } }; };

test("phone numbers: Indian 10-digit becomes 91…; junk rejected", () => {
  assert.equal(waNumber("98765 43210"), "919876543210");
  assert.equal(waNumber("+91 98765 43210"), "919876543210");
  assert.equal(waNumber("+65 8123 4567"), "6581234567");
  assert.equal(waNumber("12345"), null);
});

test("airline local time converts with the airport's time zone", () => {
  assert.equal(new Date(zonedMs("2026-11-20T06:00:00", "Asia/Kolkata")).toISOString(), "2026-11-20T00:30:00.000Z");
  assert.equal(new Date(zonedMs("2026-11-20T06:00:00", "Asia/Singapore")).toISOString(), "2026-11-19T22:00:00.000Z");
});

test("first start records a baseline: existing bookings don't trigger a burst", async () => {
  const { n, sent } = world();
  await n.scan();
  assert.equal(sent.email.length + sent.wa.length + sent.sms.length, 0);
});

test("status change → email, WhatsApp and SMS to the customer's own number, exactly once", async () => {
  const { D, n, sent } = world();
  await n.scan();
  decide(D, { status: "confirmed", note: "", at: T0 });
  await n.scan(); await n.scan();
  const toCustomer = sent.wa.filter(w => w.to === "919876543210");
  assert.equal(toCustomer.length, 1);
  assert.match(toCustomer[0].template.components[0].parameters[0].text, /Booking confirmed: ST-1/);
  assert.equal(sent.email.filter(e => e.to === "ravi@x.in").length, 1);
  assert.equal(sent.sms.length, 1);
  assert.equal(sent.sms[0].recipients[0].mobiles, "919876543210");
  assert.ok(sent.sms[0].recipients[0].var1.length <= 30, "DLT variable limit");
});

test("last-minute owner note and driver assignment are sent; a changed note is sent again", async () => {
  const { D, n, sent } = world();
  await n.scan();
  decide(D, { status: "confirmed", at: T0, note: "Pickup moved to 10:30 due to rain", assign: { driverName: "Kumar", driverPhone: "9888877777", vehicleNo: "TN 09 AB 1234" } });
  await n.scan();
  const texts = sent.wa.map(w => w.template.components[0].parameters[0].text);
  assert.ok(texts.some(t => /Pickup moved to 10:30/.test(t)));
  assert.ok(texts.some(t => /Driver for ST-1: Kumar/.test(t)));
  decide(D, { note: "Driver will call 15 minutes before" });
  await n.scan();
  assert.ok(sent.wa.map(w => w.template.components[0].parameters[0].text).some(t => /call 15 minutes before/.test(t)));
});

test("reminders: 2 hours before pickup, estimated arrival alarm, trip-ending alarm; stale ones skipped", async () => {
  const { D, n, sent, ctl } = world();
  await n.scan();
  decide(D, { status: "confirmed", at: T0 });
  await n.scan();
  const count = re => sent.wa.filter(w => re.test(w.template.components[0].parameters[0].text)).length;
  ctl.now = Date.parse("2026-11-10T08:05:00+05:30"); await n.scan();
  assert.equal(count(/arrives in about 2 hours/), 1);
  ctl.now = Date.parse("2026-11-10T19:50:00+05:30"); await n.scan(); /* 462 km ÷ 45 km/h ≈ 10h16m after 10:00 → ETA 20:16 */
  assert.equal(count(/reach Madurai in about 30 minutes/), 1);
  ctl.now = Date.parse("2026-11-11T08:30:00+05:30"); await n.scan();
  assert.equal(count(/ends today/), 1);
  /* a second booking whose pickup was hours ago: no late "2 hours" reminder */
  D.docs["requests/c1"].data.bookings.b2 = { ref: "ST-2", from: "Chennai", to: "Vellore", date: "2026-11-11", time: "01:00", days: 1 };
  D.docs["decisions/c1"].data.bookings.b2 = { status: "confirmed" };
  await n.scan();
  assert.equal(sent.wa.filter(w => /ST-2/.test(w.template.components[0].parameters[0].text) && /2 hours/.test(w.template.components[0].parameters[0].text)).length, 0);
});

test("customer opt-out is respected per channel", async () => {
  const { D, n, sent } = world();
  D.docs["requests/c1"].data.prefs = { nWhatsapp: "off", nSms: "off" };
  await n.scan();
  decide(D, { status: "confirmed", at: T0 });
  await n.scan();
  assert.equal(sent.wa.filter(w => w.to === "919876543210").length, 0);
  assert.equal(sent.sms.length, 0);
  assert.equal(sent.email.filter(e => e.to === "ravi@x.in").length, 1);
});

test("a failing channel is retried at most 3 times; other channels still deliver", async () => {
  const { D, n, sent, ctl } = world();
  await n.scan();
  ctl.waFail = 10;
  decide(D, { status: "confirmed", at: T0 });
  for (let i = 0; i < 6; i++) await n.scan();
  assert.equal(10 - ctl.waFail, 3, "exactly 3 attempts");
  assert.equal(sent.email.filter(e => e.to === "ravi@x.in").length, 1);
  const logged = n.status().log.find(l => l.ref === "ST-1");
  assert.match(logged.ch.whatsapp.err, /Template not approved/);
});

test("owner hears about new requests and payments", async () => {
  const { D, n, sent } = world();
  await n.scan();
  D.docs["requests/c1"].data.bookings.b3 = { ref: "ST-3", from: "Chennai", to: "Ooty", date: "2026-12-01", days: 3, pax: 4, vehicleName: "Innova" };
  D.payments.order_1 = { status: "paid", amount: 321000, ref: "ST-3" };
  await n.scan();
  const ownerWa = sent.wa.filter(w => w.to === "919000000001").map(w => w.template.components[0].parameters[0].text);
  assert.ok(ownerWa.some(t => /New booking request ST-3/.test(t)));
  assert.ok(ownerWa.some(t => /₹3210/.test(t)));
});

test("flight: confirmation, 3-hour reminder and landing alarm use airport time zones", async () => {
  const { D, n, sent, ctl } = world();
  await n.scan();
  const b = { id: "t1", ref: "FL-1", kind: "flight", status: "confirmed", reference: "ZZ1ABC", title: "Duffel Airways · Chennai → Singapore", travelDate: "2026-11-20", price: { total: 13464 }, payment: { amount: 13464 },
    offer: { slices: [{ from: "MAA", to: "SIN", toCity: "Singapore", fromTz: "Asia/Kolkata", departAt: "2026-11-20T06:00:00", arriveAt: "2026-11-20T12:35:00", minutes: 245 }] } };
  D.docs["travel/c1"] = { data: { bookings: { t1: b } } };
  await n.scan();
  const txt = () => sent.wa.map(w => w.template.components[0].parameters[0].text);
  assert.ok(txt().some(t => /Flight confirmed.*PNR.*ZZ1ABC|Airline PNR: ZZ1ABC/.test(t)));
  ctl.now = Date.parse("2026-11-20T03:10:00+05:30"); await n.scan();
  assert.ok(txt().some(t => /departs at 06:00/.test(t)));
  ctl.now = Date.parse("2026-11-20T09:40:00+05:30"); await n.scan(); /* lands 06:00 IST + 245 min = 10:05 IST */
  assert.ok(txt().some(t => /land at Singapore \(SIN\) in about 30 minutes/.test(t)));
});

test("no channels configured: events are skipped and not replayed when keys are added later", async () => {
  const { D } = world();
  const quiet = createNotifier({ D, store: { save() {} }, env: {}, fetchImpl: async () => { throw new Error("no"); }, log: { warn() {}, error() {} }, now: () => T0 });
  await quiet.scan();
  decide(D, { status: "confirmed", at: T0 });
  await quiet.scan();
  assert.ok(D.notify.sent["cab:b1:confirmed"].skipped);
});

test("a note sent inside the status message isn't repeated as a separate update", async () => {
  const { D, n, sent } = world();
  await n.scan();
  decide(D, { status: "confirmed", at: T0, note: "Advance received online." });
  await n.scan(); await n.scan();
  const withNote = sent.wa.filter(w => w.to === "919876543210" && /Advance received online/.test(w.template.components[0].parameters[0].text));
  assert.equal(withNote.length, 1);
});
