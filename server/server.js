"use strict";
/*
 * Sashwanth Travels — self-hosted server.
 *   npm start  → http://localhost:3000
 *
 * Serves the same page that is published inside Claude, and provides what Claude's
 * viewer provides there: accounts and sessions, a rule-enforced document store with live
 * updates, photo storage, and a Claude API proxy for the Saarathi agent.
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const { createStore, deepMerge } = require("./store");
const { canRead, canWrite, splitPath, RANK } = require("./rules");
const { createPayments } = require("./payments");
const { createTravel } = require("./travel");
const { createNotifier } = require("./notify");
const { createGeo } = require("./geo");
const SEC = require("./security");
const { createPhotos } = require("./photos");

const ROOT = path.join(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = m => new HttpError(400, m);

/* ---------- passwords ---------- */
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k)));
async function hashPassword(pw) { const salt = crypto.randomBytes(16); return { salt: salt.toString("hex"), hash: (await scrypt(pw, salt)).toString("hex") }; }
async function checkPassword(pw, u) { const k = await scrypt(pw, Buffer.from(u.salt, "hex")); return crypto.timingSafeEqual(k, Buffer.from(u.hash, "hex")); }
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
const PHONE = /^[+]?\d[\d ]{9,14}$/;
const normPhone = p => String(p || "").replace(/[^\d]/g, "").slice(-10);
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

function createApp(opts = {}) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(ROOT, "data");
  const store = createStore(path.join(dataDir, "db.json"));
  const assetDir = path.join(dataDir, "assets");
  fs.mkdirSync(assetDir, { recursive: true });
  const D = store.data;
  D.meta.sessions = D.meta.sessions || {};
  const secureCookie = opts.secureCookie ?? process.env.COOKIE_SECURE === "1";
  const secKey = SEC.loadKey(dataDir, process.env.SECRET_KEY);
  const pwnedCheck = opts.pwnedCheck ?? process.env.PWNED_CHECK === "on";
  D.meta.mfa = D.meta.mfa || {};
  /* Password rules for new and changed passwords (existing passwords keep working). */
  async function checkNewPassword(pw, who) {
    const probs = SEC.passwordProblems(pw, who);
    if (probs.length) throw Object.assign(new HttpError(400, probs.join(" ")), { code: "weak_password" });
    if (pwnedCheck && await SEC.isLeaked(pw, opts.fetchImpl || fetch)) throw Object.assign(new HttpError(400, "This password has appeared in a data breach elsewhere, so attackers try it first. Please choose a different one."), { code: "leaked_password" });
  }

  /* Claude client for the agent (optional) */
  /* AI_PROVIDER=anthropic (Claude, default) or gemini (Google). With only one key set, that provider is used. */
  const aiEnv = opts.aiEnv || process.env;
  const provider = String(aiEnv.AI_PROVIDER || (aiEnv.ANTHROPIC_API_KEY ? "anthropic" : aiEnv.GEMINI_API_KEY ? "gemini" : "anthropic")).toLowerCase();
  let claude = opts.claudeClient || null;
  const useGemini = !claude && provider === "gemini" && !!aiEnv.GEMINI_API_KEY;
  const model = opts.model || (useGemini ? aiEnv.GEMINI_MODEL || "gemini-3.8-flash" : process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5");
  const quickModel = opts.quickModel || (useGemini ? aiEnv.GEMINI_QUICK_MODEL || aiEnv.GEMINI_MODEL || "gemini-3.8-flash" : process.env.ANTHROPIC_QUICK_MODEL || "claude-haiku-5-5");
  if (useGemini) claude = require("./gemini").createGeminiClient({ apiKey: aiEnv.GEMINI_API_KEY, fetchImpl: opts.fetchImpl || fetch });
  else if (!claude && aiEnv.ANTHROPIC_API_KEY) {
    const Anthropic = require("@anthropic-ai/sdk");
    claude = new (Anthropic.default || Anthropic)({ apiKey: aiEnv.ANTHROPIC_API_KEY });
  }
  const aiName = claude ? (claude.provider === "gemini" ? "gemini" : "claude") : null;

  /* ---------- users & roles ---------- */
  const roles = () => (D.docs["site/roles"] && D.docs["site/roles"].data.staff) || {};
  const levelOf = uid => !uid || !D.users[uid] ? "view" : D.meta.ownerId === uid ? "owner" : roles()[uid] ? "admin" : "interact";
  const publicUser = uid => {
    const u = D.users[uid]; if (!u) return null;
    const level = levelOf(uid);
    return { id: uid, name: u.name, email: u.email, phone: u.phone, avatarUrl: "", color: "", mustChange: !!u.mustChange, twoFactor: !!(u.totp && u.totp.enabled), isOwner: level === "owner", canEdit: RANK[level] >= RANK.admin, level, staffRole: roles()[uid] ? roles()[uid].role : null };
  };
  async function createUser({ name, email, phone, password }, { skipPolicy } = {}) {
    name = String(name || "").trim(); email = String(email || "").trim().toLowerCase(); phone = String(phone || "").trim();
    if (!name || name.length > 80) throw bad("Enter your name.");
    if (!EMAIL.test(email)) throw bad("Enter a valid email address.");
    if (!PHONE.test(phone)) throw bad("Enter a valid 10-digit mobile number.");
    if (!skipPolicy) await checkNewPassword(password, { name, email, phone });
    else if (String(password || "").length < 8) throw bad("Use a password of at least 8 characters.");
    if (Object.values(D.users).some(u => u.email === email)) throw new HttpError(409, "An account with this email already exists. Sign in instead.");
    if (Object.values(D.users).some(u => normPhone(u.phone) === normPhone(phone))) throw new HttpError(409, "An account with this mobile number already exists. Sign in instead.");
    const id = "u_" + crypto.randomBytes(11).toString("base64url");
    D.users[id] = { name, email, phone, ...(await hashPassword(password)), createdAt: Date.now(), fails: 0, lockUntil: 0 };
    store.save();
    return id;
  }
  /* Owner account from the environment on first start */
  const ready = (async () => {
    if (!D.meta.ownerId && (opts.owner || process.env.OWNER_EMAIL)) {
      const o = opts.owner || { name: process.env.OWNER_NAME || "Owner", email: process.env.OWNER_EMAIL, phone: process.env.OWNER_PHONE, password: process.env.OWNER_PASSWORD };
      const existing = Object.entries(D.users).find(([, u]) => u.email === String(o.email).toLowerCase());
      D.meta.ownerId = existing ? existing[0] : await createUser(o, { skipPolicy: true });
      store.save();
      console.log(`[owner] Owner account ready: ${o.email}`);
    } else if (!D.meta.ownerId) {
      console.warn("[owner] No owner account. Set OWNER_EMAIL, OWNER_PHONE and OWNER_PASSWORD in .env and restart.");
    }
  })();

  /* ---------- sessions (HttpOnly cookie; only a hash is stored) ---------- */
  const SESSION_MS = 30 * 864e5;
  const newSession = (res, uid, req) => {
    const token = crypto.randomBytes(32).toString("base64url");
    D.meta.sessions[sha(token)] = { uid, exp: Date.now() + SESSION_MS, at: Date.now(), device: req ? SEC.deviceLabel(req.headers["user-agent"]) : "", ip: req ? SEC.maskIp(req.ip) : "" };
    store.save();
    res.cookie("sst_sid", token, { httpOnly: true, sameSite: "lax", secure: secureCookie, maxAge: SESSION_MS, path: "/" });
  };
  const readCookie = req => { const m = /(?:^|;\s*)sst_sid=([^;]+)/.exec(req.headers.cookie || ""); return m ? m[1] : null; };
  const sessionUid = req => {
    const t = readCookie(req); if (!t) return null;
    const s = D.meta.sessions[sha(t)];
    if (!s || s.exp < Date.now() || !D.users[s.uid]) return null;
    return s.uid;
  };

  /* ---------- live updates ---------- */
  const listeners = new Set();
  let notifier = null;
  const changed = p => { if (notifier) notifier.poke(); for (const l of listeners) if (canRead(p, l.uid(), levelOf(l.uid()))) l.res.write(`event: change\ndata: ${JSON.stringify({ path: p })}\n\n`); };

  /* ---------- rate limits ---------- */
  const hits = new Map();
  const scale = opts.limitScale || 1;
  const limit = (key, max0, ms) => (req, res, next) => {
    const max = max0 * scale;
    const k = key + ":" + (req.uid || req.ip), now = Date.now();
    const h = (hits.get(k) || []).filter(t => now - t < ms);
    if (h.length >= max) return res.status(429).json({ error: "Too many requests. Please wait a minute and try again.", code: "rate_limited" });
    h.push(now); hits.set(k, h); next();
  };

  const app = express();
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
  app.disable("x-powered-by");
  app.set("trust proxy", process.env.TRUST_PROXY === "1");
  const rzp = opts.razorpay || { keyId: process.env.RAZORPAY_KEY_ID, keySecret: process.env.RAZORPAY_KEY_SECRET, webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET };
  const geo = createGeo({ HttpError, fetchImpl: opts.fetchImpl || fetch, env: opts.geoEnv || process.env });
  const pay = createPayments({ D, store, changed: p => changed(p), HttpError, routeKm: geo.enabled ? async (a, b) => (await geo.route(a, b)).km : null, keyId: rzp.keyId, keySecret: rzp.keySecret, webhookSecret: rzp.webhookSecret, fetchImpl: opts.fetchImpl });
  const travel = createTravel({ D, store, changed: p => changed(p), HttpError, pay, fetchImpl: opts.fetchImpl,
    duffelKey: opts.duffelKey ?? process.env.DUFFEL_ACCESS_TOKEN, liteKey: opts.liteKey ?? process.env.LITEAPI_KEY, litePaymentMethod: process.env.LITEAPI_PAYMENT_METHOD });
  const RZ = pay.enabled ? " https://checkout.razorpay.com https://*.razorpay.com" : "";
  const CSP = `default-src 'self'; script-src 'self'${pay.enabled ? " https://checkout.razorpay.com" : ""}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'${RZ}; frame-src${pay.enabled ? " https://api.razorpay.com https://checkout.razorpay.com" : " 'none'"}; media-src 'self' https:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;
  app.use((req, res, next) => {
    res.set({
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "microphone=(self), camera=(self), geolocation=(self), payment=(self \"https://api.razorpay.com\")", "X-Frame-Options": "DENY"
    });
    next();
  });
  app.use((req, res, next) => { req.uid = sessionUid(req); req.level = levelOf(req.uid); next(); });
  /* After the owner issues a temporary password, nothing can be changed until the person sets their own. */
  app.use((req, res, next) => {
    const u = req.uid && D.users[req.uid];
    if (u && u.mustChange && req.method !== "GET" && req.path.startsWith("/api/") && !req.path.startsWith("/api/auth/")) return res.status(403).json({ error: "Set a new password first (My account → Security).", code: "must_change_password" });
    next();
  });
  /* Razorpay webhook: server-to-server, signed; needs the raw body and no CSRF header. */
  app.post("/api/pay/webhook", express.raw({ type: "*/*", limit: "1mb" }), wrap(pay.webhook));
  /* CSRF: state-changing calls must come from our own script (custom header + SameSite cookie). */
  app.use("/api", (req, res, next) => {
    if (req.method !== "GET" && req.get("x-sst") !== "1") return res.status(403).json({ error: "Missing request header" });
    next();
  });
  app.use("/api/assets", express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "20mb" }));
  app.use(express.json({ limit: "512kb" }));
  const needUser = (req, res, next) => req.uid ? next() : res.status(401).json({ error: "Sign in first.", code: "not_signed_in" });

  /* ---------- auth ---------- */
  app.get("/api/health", (req, res) => res.json({ ok: true, version: require("../package.json").version, agent: !!claude, ai: aiName, aiModel: claude ? model : null, owner: !!D.meta.ownerId, payments: pay.enabled, maps: geo.enabled }));
  app.get("/api/session", (req, res) => res.json({ user: req.uid ? publicUser(req.uid) : null, agent: !!claude, payments: pay.enabled ? { provider: "razorpay", keyId: pay.keyId } : null, travel: (travel.enabled.flights || travel.enabled.hotels) ? travel.enabled : null, geo: geo.enabled }));
  app.post("/api/auth/signup", limit("signup", 20, 15 * 60e3), wrap(async (req, res) => {
    await ready;
    const id = await createUser(req.body || {});
    D.users[id].logins = [{ at: Date.now(), ok: true, how: "account created", device: SEC.deviceLabel(req.headers["user-agent"]), ip: SEC.maskIp(req.ip) }]; D.users[id].pwChangedAt = Date.now();
    newSession(res, id, req);
    res.status(201).json({ user: publicUser(id) });
  }));
  const logAttempt = (u, req, ok, how) => { u.logins = [{ at: Date.now(), ok, how, device: SEC.deviceLabel(req.headers["user-agent"]), ip: SEC.maskIp(req.ip) }, ...(u.logins || [])].slice(0, 12); };
  const LOCK_MSG = "Too many wrong attempts. This account is locked for 15 minutes. Ask the owner if you need help sooner.";
  const failCount = u => { u.fails = (u.fails || 0) + 1; if (u.fails >= 5) { u.lockUntil = Date.now() + 15 * 60e3; u.fails = 0; } };
  app.post("/api/auth/login", limit("login", 30, 15 * 60e3), wrap(async (req, res) => {
    await ready;
    const login = String((req.body || {}).login || "").trim().toLowerCase(), pw = String((req.body || {}).password || "");
    const entry = Object.entries(D.users).find(([, u]) => u.email === login || (normPhone(login).length === 10 && normPhone(u.phone) === normPhone(login)));
    const fail = () => { throw new HttpError(401, "Email/mobile or password is wrong."); };
    if (!entry) { await hashPassword(pw); fail(); }
    const [id, u] = entry;
    if (u.lockUntil > Date.now()) throw new HttpError(429, LOCK_MSG);
    if (!(await checkPassword(pw, u))) { failCount(u); logAttempt(u, req, false, "password"); store.save(); fail(); }
    u.fails = 0;
    /* Two-step verification: password alone isn't enough; issue a short-lived ticket for the code step. */
    if (u.totp && u.totp.enabled) {
      const ticket = crypto.randomBytes(24).toString("base64url");
      for (const [k, m] of Object.entries(D.meta.mfa)) if (m.exp < Date.now()) delete D.meta.mfa[k];
      D.meta.mfa[sha(ticket)] = { uid: id, exp: Date.now() + 5 * 60e3, tries: 0 };
      store.save();
      return res.json({ mfa: true, ticket, recoveryLeft: (u.totp.recovery || []).length });
    }
    logAttempt(u, req, true, "password"); store.save();
    newSession(res, id, req);
    res.json({ user: publicUser(id) });
  }));
  app.post("/api/auth/mfa", limit("mfa", 20, 15 * 60e3), wrap(async (req, res) => {
    const t = String((req.body || {}).ticket || ""), code = String((req.body || {}).code || "").trim();
    const m = D.meta.mfa[sha(t)];
    if (!m || m.exp < Date.now()) throw new HttpError(401, "This sign-in has expired. Enter your password again.");
    const u = D.users[m.uid]; if (!u || !u.totp || !u.totp.enabled) throw new HttpError(401, "Sign in again.");
    if (u.lockUntil > Date.now()) throw new HttpError(429, LOCK_MSG);
    let ok = false, how = "authenticator";
    if (/^\d{6}$/.test(code.replace(/\s/g, ""))) { const step = SEC.verifyTotp(SEC.open(secKey, u.totp.secret), code, Date.now(), u.totp.lastStep ?? -1); if (step >= 0) { ok = true; u.totp.lastStep = step; } }
    else { const left = SEC.useRecoveryCode(u.totp.recovery, code); if (left) { ok = true; how = "recovery code"; u.totp.recovery = left; } }
    if (!ok) { m.tries++; failCount(u); logAttempt(u, req, false, "code"); if (m.tries >= 5) delete D.meta.mfa[sha(t)]; store.save(); throw new HttpError(401, "That code is wrong or has expired. Use the current 6-digit code from your authenticator app, or a backup code."); }
    delete D.meta.mfa[sha(t)]; u.fails = 0; logAttempt(u, req, true, how); store.save();
    newSession(res, m.uid, req);
    res.json({ user: publicUser(m.uid), recoveryLeft: u.totp.recovery.length, usedRecovery: how === "recovery code" });
  }));
  app.post("/api/auth/logout", (req, res) => {
    const t = readCookie(req); if (t) { delete D.meta.sessions[sha(t)]; store.save(); }
    res.clearCookie("sst_sid", { path: "/" }); res.json({ ok: true });
  });
  app.post("/api/auth/password", needUser, limit("pw", 5, 15 * 60e3), wrap(async (req, res) => {
    const u = D.users[req.uid];
    if (!(await checkPassword(String(req.body.current || ""), u))) throw new HttpError(401, "Current password is wrong.");
    const next = String(req.body.next || "");
    if (await checkPassword(next, u)) throw bad("Choose a new password that's different from the current one.");
    await checkNewPassword(next, u);
    Object.assign(u, await hashPassword(next), { mustChange: false, pwChangedAt: Date.now() });
    for (const [k, s] of Object.entries(D.meta.sessions)) if (s.uid === req.uid) delete D.meta.sessions[k];
    newSession(res, req.uid, req); store.save();
    res.json({ ok: true });
  }));
  /* Owner can set a temporary password for someone who forgot theirs. */
  app.post("/api/auth/reset", needUser, wrap(async (req, res) => {
    if (req.level !== "owner") throw new HttpError(403, "Only the owner can reset passwords.");
    const u = D.users[String(req.body.userId || "")]; if (!u) throw new HttpError(404, "User not found");
    const temp = crypto.randomBytes(9).toString("base64url");
    Object.assign(u, await hashPassword(temp), { fails: 0, lockUntil: 0, mustChange: true });
    if (req.body.reset2fa && u.totp) delete u.totp;
    for (const [k, s] of Object.entries(D.meta.sessions)) if (s.uid === req.body.userId) delete D.meta.sessions[k];
    store.save(); res.json({ tempPassword: temp });
  }));
  /* ---------- security centre ---------- */
  const needPassword = async (req, u) => { if (!(await checkPassword(String((req.body || {}).password || ""), u))) { failCount(u); store.save(); throw new HttpError(401, "Your password is wrong."); } };
  app.get("/api/auth/security", needUser, (req, res) => {
    const u = D.users[req.uid], cur = sha(readCookie(req) || "");
    const sessions = Object.entries(D.meta.sessions).filter(([, x]) => x.uid === req.uid && x.exp > Date.now()).map(([k, x]) => ({ current: k === cur, at: x.at || null, device: x.device || "Unknown device", ip: x.ip || "" })).sort((a, b) => (b.at || 0) - (a.at || 0));
    res.json({ twoFactor: !!(u.totp && u.totp.enabled), recoveryLeft: u.totp && u.totp.enabled ? (u.totp.recovery || []).length : 0, mustChange: !!u.mustChange, pwChangedAt: u.pwChangedAt || u.createdAt || null, logins: (u.logins || []).slice(0, 10), sessions });
  });
  app.post("/api/auth/password-check", limit("pwc", 60, 60e3), wrap(async (req, res) => {
    const u = req.uid ? D.users[req.uid] : {};
    const who = { name: req.body.name || u.name, email: req.body.email || u.email, phone: req.body.phone || u.phone };
    const problems = SEC.passwordProblems(req.body.password, who);
    const leaked = !problems.length && pwnedCheck ? await SEC.isLeaked(String(req.body.password || ""), opts.fetchImpl || fetch) : false;
    res.json({ ok: !problems.length && !leaked, problems: leaked ? ["This password has appeared in a data breach elsewhere."] : problems });
  }));
  app.post("/api/auth/sessions/revoke-others", needUser, wrap(async (req, res) => {
    const cur = sha(readCookie(req) || ""); let n = 0;
    for (const [k, x] of Object.entries(D.meta.sessions)) if (x.uid === req.uid && k !== cur) { delete D.meta.sessions[k]; n++; }
    store.save(); res.json({ signedOut: n });
  }));
  app.post("/api/auth/2fa/setup", needUser, limit("2fa", 10, 15 * 60e3), wrap(async (req, res) => {
    const u = D.users[req.uid]; await needPassword(req, u);
    const secret = SEC.newSecret(), brand = ((D.docs["site/config"] || {}).data || {}).name || "Sashwanth Travels";
    u.totpPending = { secret: SEC.seal(secKey, secret), exp: Date.now() + 15 * 60e3 }; store.save();
    const uri = SEC.otpauthUri(secret, u.email, brand);
    const svg = await require("qrcode").toString(uri, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    res.json({ secret: secret.replace(/(.{4})/g, "$1 ").trim(), uri, qr: "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64") });
  }));
  app.post("/api/auth/2fa/enable", needUser, limit("2fa", 10, 15 * 60e3), wrap(async (req, res) => {
    const u = D.users[req.uid], p = u.totpPending;
    if (!p || p.exp < Date.now()) throw new HttpError(409, "Start the setup again: the QR code has expired.");
    const secret = SEC.open(secKey, p.secret), step = SEC.verifyTotp(secret, req.body.code);
    if (step < 0) throw new HttpError(400, "That code doesn't match. Check the phone's time is set automatically and enter the current 6-digit code.");
    const rc = SEC.newRecoveryCodes();
    u.totp = { enabled: true, secret: p.secret, lastStep: step, recovery: rc.hashes, at: Date.now() }; delete u.totpPending;
    const cur = sha(readCookie(req) || ""); for (const [k, x] of Object.entries(D.meta.sessions)) if (x.uid === req.uid && k !== cur) delete D.meta.sessions[k];
    store.save(); res.json({ enabled: true, recoveryCodes: rc.codes });
  }));
  app.post("/api/auth/2fa/disable", needUser, limit("2fa", 10, 15 * 60e3), wrap(async (req, res) => {
    const u = D.users[req.uid]; await needPassword(req, u);
    if (!u.totp || !u.totp.enabled) return res.json({ enabled: false });
    const code = String(req.body.code || "").trim();
    const ok = SEC.verifyTotp(SEC.open(secKey, u.totp.secret), code, Date.now(), u.totp.lastStep ?? -1) >= 0 || !!SEC.useRecoveryCode(u.totp.recovery, code);
    if (!ok) throw new HttpError(400, "Enter a current code from your authenticator app (or a backup code) to turn this off.");
    delete u.totp; store.save(); res.json({ enabled: false });
  }));
  app.post("/api/auth/2fa/recovery", needUser, limit("2fa", 10, 15 * 60e3), wrap(async (req, res) => {
    const u = D.users[req.uid]; await needPassword(req, u);
    if (!u.totp || !u.totp.enabled) throw new HttpError(409, "Turn on two-step verification first.");
    const rc = SEC.newRecoveryCodes(); u.totp.recovery = rc.hashes; store.save(); res.json({ recoveryCodes: rc.codes });
  }));
  app.get("/api/users/search", needUser, (req, res) => {
    if (RANK[req.level] < RANK.admin) return res.json([]);
    const q = String(req.query.q || "").trim().toLowerCase();
    const out = Object.entries(D.users).filter(([id, u]) => id !== req.uid && (!q || u.name.toLowerCase().includes(q) || u.email.includes(q) || normPhone(u.phone).includes(normPhone(q) || "~")))
      .slice(0, 10).map(([id, u]) => ({ id, name: u.name, email: req.level === "owner" ? u.email : null, avatarUrl: "", color: "", isMe: false, guest: false }));
    res.json(out);
  });
  app.post("/api/users/profiles", needUser, (req, res) => {
    const ids = (Array.isArray(req.body.ids) ? req.body.ids : [req.body.ids]).slice(0, 64).map(String);
    const out = {};
    for (const id of ids) { const u = D.users[id]; if (u && (id === req.uid || RANK[req.level] >= RANK.admin)) out[id] = { id, name: u.name, avatarUrl: "", color: "", email: null, isMe: id === req.uid, guest: false }; }
    res.json(out);
  });

  /* ---------- document store ---------- */
  const isDocPath = segs => segs.length % 2 === 0;
  app.get("/api/db/doc", (req, res) => {
    const p = String(req.query.path || ""), segs = splitPath(p);
    if (!isDocPath(segs)) throw bad("Not a document path");
    const d = D.docs[p];
    if (!d || !canRead(p, req.uid, req.level)) return res.json({ exists: false });
    res.json({ exists: true, data: d.data, version: d.version });
  });
  app.get("/api/db/collection", (req, res) => {
    const p = String(req.query.path || ""), segs = splitPath(p);
    if (isDocPath(segs)) throw bad("Not a collection path");
    const docs = Object.entries(D.docs)
      .filter(([k]) => k.startsWith(p + "/") && k.split("/").length === segs.length + 1 && canRead(k, req.uid, req.level))
      .map(([k, d]) => ({ id: k.split("/").pop(), data: d.data, version: d.version }))
      .sort((a, b) => a.id < b.id ? -1 : 1);
    res.json({ docs });
  });
  app.post("/api/db/doc", needUser, limit("write", 120, 60e3), (req, res) => {
    const { path: p, op, data } = req.body || {};
    const segs = splitPath(p);
    if (!isDocPath(segs)) throw bad("Not a document path");
    if (segs[0] === "travel") throw new HttpError(403, "Flight and hotel bookings are changed only through booking actions.");
    if (segs[0] === "photos") throw new HttpError(403, "Photos are managed in Owner console → Photos.");
    if (!canWrite(p, req.uid, req.level)) throw new HttpError(403, "You don't have permission to change this.");
    /* Business rule enforced on the server: blocked customers can't send requests. */
    if (segs[0] === "requests" && req.level === "interact" && D.docs["customers/" + req.uid]?.data?.blocked) throw new HttpError(403, "Your account can't send requests. Please call the owner.");
    const cur = D.docs[p];
    /* Business rule: after a booking is sent, the customer can't change its name or phone directly.
       They send a change request (contactChange) and the owner approves it (decisions → contact). */
    if (segs[0] === "requests" && req.level === "interact" && cur && op !== "delete" && data && typeof data === "object") {
      const next = op === "set" ? data : deepMerge(cur.data, data);
      for (const [id, ob] of Object.entries((cur.data && cur.data.bookings) || {})) {
        const nb = ((next && next.bookings) || {})[id];
        if (nb && ["name", "phone"].some(k => String(nb[k] ?? "") !== String(ob[k] ?? ""))) throw new HttpError(403, "The name and phone on a booking change only with the owner's approval. Use \"Change name or phone\" in My Trips.");
        const rv = nb && nb.review;
        if (rv && JSON.stringify(rv) !== JSON.stringify(ob.review || null)) {
          const dec = ((((D.docs["decisions/" + req.uid] || {}).data || {}).bookings) || {})[id] || {};
          if (dec.status !== "completed") throw new HttpError(403, "You can review a trip after it is completed.");
          if (typeof rv !== "object" || !Number.isInteger(rv.stars) || rv.stars < 1 || rv.stars > 5 || String(rv.text || "").length > 500) throw new HttpError(400, "Choose 1 to 5 stars; reviews can be up to 500 characters.");
        }
        const cc = nb && nb.contactChange;
        if (cc && cc !== ob.contactChange && JSON.stringify(cc) !== JSON.stringify(ob.contactChange || null)) {
          if (typeof cc !== "object" || !/^cc[a-z0-9]{4,16}$/.test(String(cc.id || "")) || !/^[\p{L}][\p{L} .'-]{1,59}$/u.test(String(cc.name || "").trim()) || !/^[+]?\d[\d ]{9,14}$/.test(String(cc.phone || "").trim()) || String(cc.why || "").length > 140)
            throw new HttpError(400, "Enter a valid name and mobile number for the change.");
        }
      }
    }
    if (op === "delete") { delete D.docs[p]; }
    else {
      if (!data || typeof data !== "object" || Array.isArray(data)) throw bad("Document body must be an object");
      if (Buffer.byteLength(JSON.stringify(data)) > 256 * 1024) throw new HttpError(413, "Document too large");
      if (op === "set") D.docs[p] = { data, version: (cur?.version || 0) + 1, updatedAt: Date.now(), by: req.uid };
      else if (op === "update") {
        if (!cur) throw bad("Document does not exist");
        D.docs[p] = { data: deepMerge(cur.data, data), version: cur.version + 1, updatedAt: Date.now(), by: req.uid };
      } else throw bad("Unknown op");
    }
    store.save(); changed(p);
    res.json({ ok: true, version: D.docs[p]?.version || 0 });
  });
  app.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const l = { res, uid: () => sessionUid(req) };
    listeners.add(l);
    res.write("event: hello\ndata: {}\n\n");
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => { clearInterval(ping); listeners.delete(l); });
  });

  /* ---------- photos ---------- */
  const MAGIC = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47], "image/webp": [0x52, 0x49, 0x46, 0x46] };
  app.post("/api/assets", needUser, limit("upload", 30, 60e3), (req, res) => {
    const type = String(req.get("content-type") || "").split(";")[0];
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !MAGIC[type] || !MAGIC[type].every((b, i) => buf[i] === b)) throw bad("Upload a JPG, PNG or WebP photo.");
    const id = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(path.join(assetDir, id), buf);
    D.assets[id] = { type, size: buf.length, by: req.uid, staff: RANK[req.level] >= RANK.admin, at: Date.now() };
    store.save();
    res.status(201).json({ id, url: "/_blob/" + id, sizeBytes: buf.length, contentType: type });
  });
  /* Staff photos are public (fleet, gallery, trip photos); customer uploads (payment screenshots)
     are visible only to the uploader and staff. */
  app.get("/_blob/:id", (req, res) => {
    const a = D.assets[req.params.id];
    if (!a || !/^[a-f0-9]{32}$/.test(req.params.id)) return res.status(404).end();
    if (!a.staff && req.uid !== a.by && RANK[req.level] < RANK.admin) return res.status(404).end();
    res.set({ "Content-Type": a.type, "Cache-Control": a.staff ? "public, max-age=86400" : "private, max-age=3600" });
    res.sendFile(path.join(assetDir, req.params.id));
  });

  /* ---------- payments (Razorpay) ---------- */
  app.post("/api/pay/order", needUser, limit("payorder", 20, 60e3), wrap(async (req, res) => {
    if (req.level !== "interact" && req.level !== "owner") throw new HttpError(403, "Only customer accounts can pay for bookings.");
    if (D.docs["customers/" + req.uid]?.data?.blocked) throw new HttpError(403, "Your account can't make payments. Please call the owner.");
    res.json(await pay.createOrder(req.uid, String(req.body.bookingId || "")));
  }));
  app.post("/api/pay/verify", needUser, limit("payverify", 30, 60e3), wrap(async (req, res) => {
    res.json(await pay.verify(req.uid, req.body || {}));
  }));
  app.post("/api/pay/refund", needUser, wrap(async (req, res) => {
    if (req.level !== "owner") throw new HttpError(403, "Only the owner can issue refunds.");
    res.json(await pay.refund(String(req.body.uid || ""), String(req.body.bookingId || ""), req.body.amount, req.uid));
  }));

  /* ---------- flights & hotels ---------- */
  app.get("/api/travel/places", limit("places", 120, 60e3), wrap(async (req, res) => res.json(await travel.places(req.query.q))));
  app.post("/api/travel/flights/search", limit("fsearch", 20, 60e3), wrap(async (req, res) => res.json(await travel.searchFlights(req.body || {}))));
  app.post("/api/travel/hotels/search", limit("hsearch", 20, 60e3), wrap(async (req, res) => res.json(await travel.searchHotels(req.body || {}))));
  const customerOnly = (req) => { if (req.level !== "interact" && req.level !== "owner") throw new HttpError(403, "Use a customer account to book."); if (D.docs["customers/" + req.uid]?.data?.blocked) throw new HttpError(403, "Your account can't make bookings. Please contact support."); };
  app.post("/api/travel/hold", needUser, limit("hold", 15, 60e3), wrap(async (req, res) => { customerOnly(req); res.status(201).json(await travel.hold(req.uid, req.body || {})); }));
  app.post("/api/travel/pay", needUser, limit("tpay", 20, 60e3), wrap(async (req, res) => { customerOnly(req); res.json(await travel.startPayment(req.uid, String(req.body.bookingId || ""))); }));
  app.post("/api/travel/cancel/quote", needUser, limit("tcq", 10, 60e3), wrap(async (req, res) => res.json(await travel.cancelQuote(req.uid, String(req.body.bookingId || "")))));
  app.post("/api/travel/cancel/confirm", needUser, limit("tcc", 10, 60e3), wrap(async (req, res) => res.json(await travel.cancelConfirm(req.uid, String(req.body.bookingId || "")))));
  const ownerOnly = (req) => { if (req.level !== "owner") throw new HttpError(403, "Only the owner can do this."); };
  app.get("/api/travel/attention", needUser, wrap(async (req, res) => { if (RANK[req.level] < RANK.admin) throw new HttpError(403, "Staff only."); res.json(travel.attention()); }));
  app.post("/api/travel/refund-retry", needUser, limit("trr", 10, 60e3), wrap(async (req, res) => { ownerOnly(req); res.json(await travel.retryRefund(String(req.body.uid || ""), String(req.body.bookingId || ""))); }));
  app.get("/api/travel/invoice/:uid/:id", (req, res) => {
    if (!req.uid || (req.uid !== req.params.uid && RANK[req.level] < RANK.admin)) return res.status(404).send("Not found");
    try { const html = travel.invoiceHtml(req.params.uid, req.params.id); res.set({ "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'", "Content-Type": "text/html; charset=utf-8" }).send(html); }
    catch (e) { res.status(e.status || 500).send(String(e.message || "Error")); }
  });

  /* ---------- Claude proxy for the Saarathi agent ---------- */
  const TOOL_ALLOW = new Set(["search_flights", "search_hotels", "get_business_info", "get_customer_account", "list_vehicles", "lookup_route", "check_availability", "estimate_fare", "prepare_booking", "get_my_bookings", "escalate_to_owner", "get_booking_status", "find_alternatives", "save_trip_plan", "get_trip_budget", "save_itinerary_draft", "get_preferences", "save_preferences", "delete_preferences", "get_weather", "get_route_distance", "get_my_location", "show_destination"]);
  const GUARD = "You are deployed as the booking assistant on a travel company's website. Only help with travel, trips, vehicles, bookings, payments, policies and places to visit. Politely decline anything else. Follow the business rules given in the first user message.";
  app.post("/api/llm", limit("llm", 30, 60e3), wrap(async (req, res) => {
    if (!claude) return res.status(503).json({ error: "The AI agent isn't configured on this server.", code: "sampling_disabled" });
    const b = req.body || {};
    const messages = Array.isArray(b.messages) ? b.messages.slice(-40) : [];
    if (!messages.length || messages[0].role !== "user") throw bad("Conversation must start with a user message");
    if (Buffer.byteLength(JSON.stringify(messages)) > 400 * 1024) throw new HttpError(413, "Conversation too long");
    const tools = (Array.isArray(b.tools) ? b.tools : []).filter(t => t && TOOL_ALLOW.has(t.name)).map(t => ({ name: t.name, description: String(t.description || "").slice(0, 1024), input_schema: t.input_schema && t.input_schema.type === "object" ? t.input_schema : { type: "object", properties: {} } }));
    try {
      const r = await claude.messages.create({ model: b.tier === "quick" ? quickModel : model, max_tokens: 2048, system: GUARD, messages, ...(tools.length ? { tools } : {}) });
      res.json({ content: r.content, stop_reason: r.stop_reason });
    } catch (e) {
      console.error("[llm]", e.status || "", e.message);
      res.status(e.status === 429 ? 429 : 502).json({ error: "The agent couldn't answer just now.", code: e.status === 429 ? "rate_limited" : "upstream_error" });
    }
  }));

  /* ---------- destination photos (Wikimedia Commons + owner's licensed photos) ---------- */
  const photos = createPhotos({ D, store, changed: p => changed(p), HttpError, fetchImpl: opts.fetchImpl || fetch, contact: (opts.owner && opts.owner.email) || process.env.OWNER_EMAIL || "", delayMs: opts.photoDelayMs ?? 250 });
  ready.then(() => { if (opts.photoAuto) { setTimeout(() => photos.autoRefresh(), opts.photoStartMs ?? 8000).unref(); setInterval(() => photos.autoRefresh(), 864e5).unref(); } });
  const staffOnly = req => { if (RANK[req.level] < RANK.admin) throw new HttpError(403, "Staff only."); };
  app.get("/api/photos", (req, res) => { res.set("Cache-Control", "no-cache"); res.json({ destinations: photos.publicView(req.query.all === "1" && RANK[req.level] >= RANK.admin), job: RANK[req.level] >= RANK.admin ? photos.status() : undefined }); });
  app.post("/api/photos/refresh", needUser, limit("phr", 6, 60e3), wrap(async (req, res) => { staffOnly(req); const ids = Array.isArray(req.body.destinations) ? req.body.destinations.map(String) : req.body.destinationId ? [String(req.body.destinationId)] : null; res.json(await photos.refresh(ids)); }));
  app.post("/api/photos/update", needUser, limit("phu", 60, 60e3), wrap(async (req, res) => { staffOnly(req); res.json(photos.update(String(req.body.destinationId || ""), String(req.body.id || ""), { hidden: req.body.hidden, featured: req.body.featured })); }));
  app.post("/api/photos/add", needUser, limit("pha", 20, 60e3), wrap(async (req, res) => { if (req.level !== "owner") throw new HttpError(403, "Only the owner can add photos."); res.json(await photos.addManual(String(req.body.destinationId || ""), req.body || {})); }));
  app.post("/api/photos/broken", limit("phb", 30, 60e3), wrap(async (req, res) => res.json(await photos.reportBroken(String(req.body.destinationId || ""), String(req.body.id || "")))));

  /* ---------- places, routes, weather (open to guests; rate-limited, cached) ---------- */
  app.get("/api/geo/search", limit("gs", 60, 60e3), wrap(async (req, res) => res.json(await geo.search(req.query.q))));
  app.get("/api/geo/reverse", limit("gr", 20, 60e3), wrap(async (req, res) => res.json(await geo.reverse(req.query.lat, req.query.lon))));
  app.get("/api/geo/ip", limit("gi", 10, 60e3), wrap(async (req, res) => res.json(await geo.ipLocate(req.ip))));
  app.get("/api/geo/route", limit("gt", 30, 60e3), wrap(async (req, res) => res.json(await geo.route(String(req.query.from || ""), String(req.query.to || "")))));
  app.get("/api/weather", limit("gw", 40, 60e3), wrap(async (req, res) => {
    const q = req.query.lat && req.query.lon ? { lat: Number(req.query.lat), lon: Number(req.query.lon), name: String(req.query.name || "").slice(0, 60) } : String(req.query.place || "");
    if (typeof q === "object" && !(Math.abs(q.lat) <= 90 && Math.abs(q.lon) <= 180)) throw new HttpError(400, "Invalid location.");
    res.json(await geo.weather(q, String(req.query.start || ""), req.query.days));
  }));

  /* ---------- notifications: Gmail, WhatsApp, SMS ---------- */
  notifier = createNotifier({ D, store, env: opts.notifyEnv || process.env, fetchImpl: opts.fetchImpl || fetch, mailer: opts.mailer || null });
  ready.then(() => { if (opts.notify !== false) notifier.start(); });
  app.get("/api/notify/status", needUser, (req, res) => { if (RANK[req.level] < RANK.admin) throw new HttpError(403, "Staff only."); res.json(notifier.status()); });
  app.post("/api/notify/test", needUser, limit("ntest", 5, 60e3), wrap(async (req, res) => {
    if (req.level !== "owner") throw new HttpError(403, "Only the owner can send test messages.");
    const email = String(req.body.email || "").trim().slice(0, 200), phone = String(req.body.phone || "").trim().slice(0, 20);
    if (!email && !phone) throw new HttpError(400, "Enter an email or a mobile number.");
    res.json(await notifier.test({ name: "Test", email, phone }));
  }));

  app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
  /* Friendly addresses that open a checkout page or section. */
  const PAGES = { "/flights": "travel", "/hotels": "travel", "/book": "book-trip", "/booking": "book-trip", "/checkout": "book-review", "/pay": "book-pay", "/my-trips": "trips", "/account": "account", "/contact": "contact" };
  for (const [from, hash] of Object.entries(PAGES)) app.get(from, (req, res) => res.redirect(302, "/#" + hash));
  /* The page itself is never cached (so an update shows at once); its files carry a version stamp. */
  app.use(express.static(PUBLIC_DIR, { maxAge: "1h", index: "index.html", setHeaders: (res, file) => { if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-cache"); } }));

  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Upload too large" });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Malformed JSON" });
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    /* Our own HttpErrors carry customer-facing messages (e.g. "provider not connected"); unexpected errors stay generic. */
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? "Something went wrong on our side. Please try again." : err.message, code: err.code });
  });

  app.locals.store = store;
  app.locals.notifier = notifier;
  app.locals.ready = ready;
  app.locals.pay = pay;
  app.locals.travel = travel;
  return app;
}

module.exports = { createApp };

if (require.main === module) {
  const envFile = path.join(ROOT, ".env");
  try { if (fs.existsSync(envFile) && process.loadEnvFile) process.loadEnvFile(envFile); } catch { /* optional */ }
  require("../scripts/build.js");
  const port = Number(process.env.PORT) || 3000;
  const app = createApp({ pwnedCheck: process.env.PWNED_CHECK !== "off", photoAuto: process.env.PHOTOS !== "off" });
  const server = app.listen(port, () => console.log(`Sashwanth Travels running on http://localhost:${port}`));
  const stop = () => { app.locals.store.flushNow(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
