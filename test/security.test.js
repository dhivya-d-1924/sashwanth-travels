"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const SEC = require("../server/security.js");
const { createApp } = require("../server/server.js");

test("password rules: length, variety, common, sequences, personal details", () => {
  const who = { name: "Ravi Kumar", email: "ravi.k@gmail.com", phone: "9876543210" };
  assert.match(SEC.passwordProblems("Ab1!", who).join(" "), /at least 10/);
  assert.match(SEC.passwordProblems("alllowercaseletters", who).join(" "), /^$|.*/); /* 19 chars, one class: allowed only because 16+ */
  assert.equal(SEC.passwordProblems("alllowercaseletters", who).length, 0);
  assert.match(SEC.passwordProblems("lowercase1x", who).join(" "), /Mix at least 3/);
  assert.match(SEC.passwordProblems("Password@2026", who).join(" "), /very common/);
  assert.match(SEC.passwordProblems("Chennai@1234567", who).join(" "), /sequences/);
  assert.match(SEC.passwordProblems("Kumar#Trips77", who).join(" "), /name or email/);
  assert.match(SEC.passwordProblems("Trip#543210xy", who).join(" "), /mobile number/);
  assert.match(SEC.passwordProblems("Goooood!77xy", who).join(" "), /repeating/);
  assert.deepEqual(SEC.passwordProblems("Marina#Wave2026", who), []);
});

test("leaked-password check sends only 5 hash characters and fails open", async () => {
  const pw = "Marina#Wave2026", h = crypto.createHash("sha1").update(pw).digest("hex").toUpperCase();
  let asked = "";
  const hit = await SEC.isLeaked(pw, async url => { asked = url; return { ok: true, text: async () => `00000AAAAABBBBBCCCCCDDDDDEEEEEFFFFF:1\r\n${h.slice(5)}:42` }; });
  assert.equal(hit, true); assert.ok(asked.endsWith("/range/" + h.slice(0, 5)), "only the 5-character prefix leaves the server");
  assert.equal(await SEC.isLeaked(pw, async () => ({ ok: true, text: async () => "ABC:1" })), false);
  assert.equal(await SEC.isLeaked(pw, async () => { throw new Error("offline"); }), false, "unreachable service never blocks sign-up");
});

test("TOTP matches RFC 6238 test vector and blocks code reuse", () => {
  const secret = SEC.b32encode(Buffer.from("12345678901234567890"));
  assert.equal(SEC.totp(secret, 59 * 1000), "287082");
  assert.equal(SEC.totp(secret, 1111111109 * 1000), "081804");
  const t = 1111111109 * 1000, step = SEC.verifyTotp(secret, "081804", t);
  assert.ok(step > 0);
  assert.equal(SEC.verifyTotp(secret, "081804", t, step), -1, "same code can't be used twice");
  assert.equal(SEC.verifyTotp(secret, "000000", t), -1);
});

test("secrets are encrypted at rest; recovery codes are one-time", () => {
  const key = crypto.randomBytes(32), box = SEC.seal(key, "JBSWY3DPEHPK3PXP");
  assert.ok(!box.includes("JBSWY3DP")); assert.equal(SEC.open(key, box), "JBSWY3DPEHPK3PXP");
  const rc = SEC.newRecoveryCodes(3);
  const left = SEC.useRecoveryCode(rc.hashes, rc.codes[1].toUpperCase());
  assert.equal(left.length, 2); assert.equal(SEC.useRecoveryCode(left, rc.codes[1]), null);
});

/* ---------- through the server ---------- */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-sec-"));
let server, base, app;
function client() {
  let cookie = "";
  return async (p, { method = "GET", body } = {}) => {
    const h = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/130.0" }; if (method !== "GET") h["X-SST"] = "1"; if (cookie) h.Cookie = cookie; if (body !== undefined) h["Content-Type"] = "application/json";
    const r = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) { const m = /sst_sid=([^;]*)/.exec(sc); cookie = m && m[1] ? "sst_sid=" + m[1] : ""; }
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
}
test.before(async () => {
  app = createApp({ dataDir: dir, limitScale: 20, owner: { name: "Owner", email: "o@st.in", phone: "9000000001", password: "owner-pass-123" } });
  await app.locals.ready; await new Promise(r => { server = app.listen(0, r); }); base = "http://127.0.0.1:" + server.address().port;
});
test.after(async () => { app.locals.store.flushNow(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

test("sign-up rejects weak passwords with clear reasons", async () => {
  const c = client();
  const r = await c("/api/auth/signup", { method: "POST", body: { name: "Meena Raj", email: "meena@x.in", phone: "9811122233", password: "meena12345" } });
  assert.equal(r.status, 400); assert.equal(r.body.code, "weak_password"); assert.match(r.body.error, /name or email|sequences|Mix/);
  const chk = await c("/api/auth/password-check", { method: "POST", body: { password: "Lotus@Pond3141", name: "Meena Raj" } });
  assert.equal(chk.body.ok, true);
});

test("two-step sign-in: password then authenticator code; backup code works once; lockout after 5 wrong", async () => {
  const c = client();
  assert.equal((await c("/api/auth/signup", { method: "POST", body: { name: "Kavya S", email: "kavya@x.in", phone: "9811122244", password: "Lotus@Pond3141" } })).status, 201);
  assert.equal((await c("/api/auth/2fa/setup", { method: "POST", body: { password: "wrong" } })).status, 401);
  const setup = await c("/api/auth/2fa/setup", { method: "POST", body: { password: "Lotus@Pond3141" } });
  assert.equal(setup.status, 200); assert.match(setup.body.uri, /^otpauth:\/\/totp\//); assert.match(setup.body.qr, /^data:image\/svg\+xml;base64,/);
  const secret = setup.body.secret.replace(/\s/g, "");
  assert.equal((await c("/api/auth/2fa/enable", { method: "POST", body: { code: "123456" } })).status, 400);
  const en = await c("/api/auth/2fa/enable", { method: "POST", body: { code: SEC.totp(secret) } });
  assert.equal(en.status, 200); assert.equal(en.body.recoveryCodes.length, 10);
  const db = fs.readFileSync(path.join(dir, "db.json"), "utf8"); app.locals.store.flushNow();
  assert.ok(!fs.readFileSync(path.join(dir, "db.json"), "utf8").includes(secret), "authenticator secret is never stored in plain text");

  const d = client();
  const step1 = await d("/api/auth/login", { method: "POST", body: { login: "kavya@x.in", password: "Lotus@Pond3141" } });
  assert.equal(step1.body.mfa, true); assert.equal((await d("/api/session")).body.user, null, "password alone doesn't sign in");
  assert.equal((await d("/api/auth/mfa", { method: "POST", body: { ticket: step1.body.ticket, code: "000000" } })).status, 401);
  const ok = await d("/api/auth/mfa", { method: "POST", body: { ticket: step1.body.ticket, code: en.body.recoveryCodes[0] } });
  assert.equal(ok.status, 200); assert.equal(ok.body.usedRecovery, true); assert.equal(ok.body.recoveryLeft, 9);
  const e = client(), s2 = await e("/api/auth/login", { method: "POST", body: { login: "kavya@x.in", password: "Lotus@Pond3141" } });
  assert.equal((await e("/api/auth/mfa", { method: "POST", body: { ticket: s2.body.ticket, code: en.body.recoveryCodes[0] } })).status, 401, "a backup code works only once");

  const sec = await d("/api/auth/security");
  assert.equal(sec.body.twoFactor, true); assert.ok(sec.body.logins.some(l => l.ok && l.how === "recovery code"));
  assert.ok(sec.body.sessions.some(s => s.current && /Chrome on Windows/.test(s.device)));

  const x = client();
  for (let i = 0; i < 5; i++) await x("/api/auth/login", { method: "POST", body: { login: "kavya@x.in", password: "nope-" + i } });
  assert.equal((await x("/api/auth/login", { method: "POST", body: { login: "kavya@x.in", password: "Lotus@Pond3141" } })).status, 429, "locked after 5 wrong passwords");
});

test("temporary password from the owner forces a new password before anything else; sign out everywhere", async () => {
  const u = client(), owner = client();
  const id = (await u("/api/auth/signup", { method: "POST", body: { name: "Arun P", email: "arun@x.in", phone: "9811122255", password: "Monsoon!Ride82" } })).body.user.id;
  await owner("/api/auth/login", { method: "POST", body: { login: "o@st.in", password: "owner-pass-123" } });
  const t = (await owner("/api/auth/reset", { method: "POST", body: { userId: id } })).body.tempPassword;
  assert.ok(t.length >= 12);
  const v = client(); await v("/api/auth/login", { method: "POST", body: { login: "arun@x.in", password: t } });
  assert.equal((await v("/api/session")).body.user.mustChange, true);
  const blocked = await v("/api/db/doc", { method: "POST", body: { path: "requests/" + id, op: "set", data: { a: 1 } } });
  assert.equal(blocked.status, 403); assert.equal(blocked.body.code, "must_change_password");
  assert.equal((await v("/api/auth/password", { method: "POST", body: { current: t, next: t } })).status, 400, "must differ");
  assert.equal((await v("/api/auth/password", { method: "POST", body: { current: t, next: "Highway$Gear94" } })).status, 200);
  assert.equal((await v("/api/session")).body.user.mustChange, false);
  const w = client(); await w("/api/auth/login", { method: "POST", body: { login: "arun@x.in", password: "Highway$Gear94" } });
  assert.equal((await v("/api/auth/sessions/revoke-others", { method: "POST", body: {} })).body.signedOut, 1);
  assert.equal((await w("/api/session")).body.user, null);
});
