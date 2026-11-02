"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createApp } = require("../server/server.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
let server, base, theApp;
const llmCalls = [];
const fakeClaude = { messages: { create: async req => { llmCalls.push(req); return { stop_reason: "end_turn", content: [{ type: "text", text: "Vanakkam!" }] }; } } };

/* tiny cookie-aware client */
function client() {
  let cookie = "";
  return async function call(p, { method = "GET", body, raw, type, noCsrf } = {}) {
    const headers = {};
    if (!noCsrf && method !== "GET") headers["X-SST"] = "1";
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (raw) headers["Content-Type"] = type;
    const r = await fetch(base + p, { method, headers, body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
    const sc = r.headers.get("set-cookie");
    if (sc) { const m = /sst_sid=([^;]*)/.exec(sc); cookie = m && m[1] ? "sst_sid=" + m[1] : ""; this && (this.setCookie = sc); }
    const ct = r.headers.get("content-type") || "";
    return { status: r.status, body: ct.includes("json") ? await r.json() : null, setCookie: sc };
  };
}
const owner = client(), alice = client(), bob = client(), driver = client(), guest = client();
let A, B, D, O;
const put = (c, p, op, data) => c("/api/db/doc", { method: "POST", body: { path: p, op, data } });

test.before(async () => {
  const app = theApp = createApp({ limitScale: 10, dataDir: dir, claudeClient: fakeClaude, owner: { name: "Owner", email: "owner@test.in", phone: "9000000001", password: "owner-pass-123" } });
  await app.locals.ready;
  await new Promise(r => { server = app.listen(0, r); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(async () => { theApp.locals.store.flushNow(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

test("serves the built site", async () => {
  const html = await fetch(base + "/").then(r => r.text());
  assert.match(html, /claude-shim\.js/);
  assert.match(html, /site\.js/);
  const r = await fetch(base + "/");
  assert.match(r.headers.get("content-security-policy"), /script-src 'self';/);
});

test("signup validates input and refuses duplicates", async () => {
  assert.equal((await alice("/api/auth/signup", { method: "POST", body: { name: "Alice", email: "bad", phone: "9876543210", password: "Temple&Coast56" } })).status, 400);
  assert.equal((await alice("/api/auth/signup", { method: "POST", body: { name: "Alice", email: "a@x.in", phone: "9876543210", password: "short" } })).status, 400);
  const r = await alice("/api/auth/signup", { method: "POST", body: { name: "Alice", email: "a@x.in", phone: "9876543210", password: "Sunset#Road71" } });
  assert.equal(r.status, 201); A = r.body.user.id;
  assert.match(r.setCookie, /HttpOnly/i);
  assert.match(r.setCookie, /SameSite=Lax/i);
  assert.equal((await bob("/api/auth/signup", { method: "POST", body: { name: "Dup", email: "A@X.in", phone: "9123456780", password: "Temple&Coast56" } })).status, 409);
  assert.equal((await bob("/api/auth/signup", { method: "POST", body: { name: "Dup", email: "d@x.in", phone: "+91 98765 43210", password: "Temple&Coast56" } })).status, 409);
  B = (await bob("/api/auth/signup", { method: "POST", body: { name: "Bob", email: "b@x.in", phone: "9123456780", password: "Monsoon!Ride82" } })).body.user.id;
  D = (await driver("/api/auth/signup", { method: "POST", body: { name: "Murugan", email: "d@x.in", phone: "9555555555", password: "Highway$Gear94" } })).body.user.id;
});

test("state-changing calls need the app's header (CSRF guard)", async () => {
  assert.equal((await alice("/api/db/doc", { method: "POST", body: { path: "requests/x", op: "set", data: {} }, noCsrf: true })).status, 403);
});

test("login by email or mobile; wrong password rejected; lockout after 5 tries", async () => {
  const c = client();
  assert.equal((await c("/api/auth/login", { method: "POST", body: { login: "b@x.in", password: "nope" } })).status, 401);
  assert.equal((await c("/api/auth/login", { method: "POST", body: { login: "91234 56780", password: "Monsoon!Ride82" } })).status, 200);
  const o = await owner("/api/auth/login", { method: "POST", body: { login: "owner@test.in", password: "owner-pass-123" } });
  assert.equal(o.status, 200); assert.equal(o.body.user.isOwner, true); O = o.body.user.id;
  const x = client();
  for (let i = 0; i < 5; i++) await x("/api/auth/login", { method: "POST", body: { login: "d@x.in", password: "wrong" } });
  assert.equal((await x("/api/auth/login", { method: "POST", body: { login: "d@x.in", password: "Highway$Gear94" } })).status, 429);
});

test("session reports identity and role", async () => {
  assert.equal((await guest("/api/session")).body.user, null);
  const s = (await alice("/api/session")).body.user;
  assert.equal(s.name, "Alice"); assert.equal(s.canEdit, false); assert.equal(s.level, "interact");
});

test("only staff publish business data; everyone reads it", async () => {
  assert.equal((await put(alice, "site/config", "set", { sample: false, name: "Hacked" })).status, 403);
  assert.equal((await put(guest, "site/config", "set", { sample: false })).status, 401);
  assert.equal((await put(owner, "site/config", "set", { sample: false, name: "Sashwanth Travels", phone: "+91 90000 00001" })).status, 200);
  const g = await guest("/api/db/doc?path=site/config");
  assert.equal(g.body.data.name, "Sashwanth Travels");
});

test("customers only see and change their own requests", async () => {
  const booking = { ref: "ST-1", from: "Chennai", to: "Madurai", date: "2099-01-10", days: 2, fare: { total: 12812 } };
  assert.equal((await put(alice, `requests/${A}`, "set", { profile: { name: "Alice", phone: "9876543210" }, bookings: { b1: booking } })).status, 200);
  assert.equal((await bob(`/api/db/doc?path=requests/${A}`)).body.exists, false);
  assert.equal((await put(bob, `requests/${A}`, "update", { bookings: { b1: { cancelledAt: 1 } } })).status, 403);
  const col = await owner("/api/db/collection?path=requests");
  assert.equal(col.body.docs.length, 1);
  assert.equal((await bob("/api/db/collection?path=requests")).body.docs.length, 0);
});

test("a customer can't forge a confirmation; staff decisions are readable by that customer only", async () => {
  assert.equal((await put(alice, `decisions/${A}`, "set", { bookings: { b1: { status: "confirmed" } } })).status, 403);
  assert.equal((await put(owner, `decisions/${A}`, "set", { bookings: { b1: { status: "confirmed", fare: { total: 12812 }, log: { 1: "confirmed" } } } })).status, 200);
  assert.equal((await alice(`/api/db/doc?path=decisions/${A}`)).body.data.bookings.b1.status, "confirmed");
  assert.equal((await bob(`/api/db/doc?path=decisions/${A}`)).body.exists, false);
});

test("update deep-merges (trip photos accumulate), arrays replace, missing doc rejected", async () => {
  await put(owner, `decisions/${A}`, "update", { bookings: { b1: { trip: { photos: { p1: { id: "x", kind: "pickup" } } }, log: { 2: "photo" } } } });
  await put(owner, `decisions/${A}`, "update", { bookings: { b1: { trip: { photos: { p2: { id: "y", kind: "start" } }, start: { km: 1000 } } } } });
  const d = (await owner(`/api/db/doc?path=decisions/${A}`)).body.data.bookings.b1;
  assert.deepEqual(Object.keys(d.trip.photos).sort(), ["p1", "p2"]);
  assert.equal(d.status, "confirmed");
  assert.deepEqual(Object.keys(d.log).sort(), ["1", "2"]);
  assert.equal((await put(owner, "decisions/nobody", "update", { x: 1 })).status, 400);
});

test("team: owner adds a driver, who then gets staff access; only the owner manages roles", async () => {
  assert.equal((await put(driver, `decisions/${A}`, "update", { x: 1 })).status, 403);
  assert.equal((await put(owner, "site/roles", "set", { staff: { [D]: { name: "Murugan", role: "driver", phone: "9555555555" } } })).status, 200);
  const s = (await driver("/api/session")).body.user;
  assert.equal(s.canEdit, true); assert.equal(s.staffRole, "driver");
  assert.equal((await put(driver, `decisions/${A}`, "update", { bookings: { b1: { trip: { end: { km: 1950 } } } } })).status, 200);
  assert.equal((await put(driver, "site/roles", "set", { staff: {} })).status, 403);
  const found = await owner("/api/users/search?q=ali");
  assert.equal(found.body[0].name, "Alice");
  assert.equal((await alice("/api/users/search?q=bob")).body.length, 0, "customers can't search users");
});

test("blocked customers can't send requests (server-enforced)", async () => {
  await put(owner, `customers/${B}`, "set", { blocked: true });
  assert.equal((await put(bob, `requests/${B}`, "set", { bookings: { x: {} } })).status, 403);
  assert.equal((await alice(`/api/db/doc?path=customers/${A}`)).body.exists, false);
});

test("photos: type checked; customer uploads private to uploader + staff; staff uploads public", async () => {
  assert.equal((await alice("/api/assets", { method: "POST", raw: Buffer.from("not an image"), type: "image/png" })).status, 400);
  const up = await alice("/api/assets", { method: "POST", raw: PNG, type: "image/png" });
  assert.equal(up.status, 201);
  assert.equal((await alice(up.body.url)).status, 200);
  assert.equal((await bob(up.body.url)).status, 404);
  assert.equal((await owner(up.body.url)).status, 200);
  const staffUp = await owner("/api/assets", { method: "POST", raw: PNG, type: "image/png" });
  assert.equal((await guest(staffUp.body.url)).status, 200);
  assert.equal((await guest("/api/assets", { method: "POST", raw: PNG, type: "image/png" })).status, 401);
});

test("agent proxy: guard prompt added, unknown tools dropped, quick tier mapped", async () => {
  const r = await guest("/api/llm", { method: "POST", body: { tier: "quick", messages: [{ role: "user", content: "Hi" }], tools: [{ name: "list_vehicles", description: "x", input_schema: { type: "object", properties: {} } }, { name: "rm_rf", description: "evil" }] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.content[0].text, "Vanakkam!");
  const call = llmCalls.at(-1);
  assert.match(call.system, /Only help with travel/);
  assert.deepEqual(call.tools.map(t => t.name), ["list_vehicles"]);
  assert.equal(call.model, "claude-haiku-5-5");
  assert.equal(call.max_tokens, 2048);
});

test("password change signs out other sessions; owner can issue a temporary password", async () => {
  const other = client();
  await other("/api/auth/login", { method: "POST", body: { login: "a@x.in", password: "Sunset#Road71" } });
  assert.equal((await alice("/api/auth/password", { method: "POST", body: { current: "wrong", next: "Coral!Bay2027x" } })).status, 401);
  assert.equal((await alice("/api/auth/password", { method: "POST", body: { current: "Sunset#Road71", next: "Coral!Bay2027x" } })).status, 200);
  assert.equal((await other("/api/session")).body.user, null);
  assert.ok((await alice("/api/session")).body.user);
  assert.equal((await alice("/api/auth/reset", { method: "POST", body: { userId: B } })).status, 403);
  const t = await owner("/api/auth/reset", { method: "POST", body: { userId: B } });
  const fresh = client();
  assert.equal((await fresh("/api/auth/login", { method: "POST", body: { login: "b@x.in", password: t.body.tempPassword } })).status, 200);
});

test("logout ends the session; data persists to disk", async () => {
  await driver("/api/auth/logout", { method: "POST", body: {} });
  assert.equal((await driver("/api/session")).body.user, null);
  await new Promise(r => setTimeout(r, 80));
  const db = JSON.parse(fs.readFileSync(path.join(dir, "db.json"), "utf8"));
  assert.ok(db.docs[`requests/${A}`]);
  assert.ok(!JSON.stringify(db.users).includes("Coral!Bay2027x"), "passwords are hashed");
  assert.ok(Object.keys(db.meta.sessions).every(k => /^[a-f0-9]{64}$/.test(k)), "only session hashes stored");
});
