"use strict";
/*
 * Account security:
 *  - password policy (length, variety, no common/leaked passwords, nothing from the person's own details)
 *  - optional leaked-password check against Have I Been Pwned using k-anonymity (only 5 hash characters leave the server)
 *  - TOTP two-step verification (RFC 6238, works with Google Authenticator, Microsoft Authenticator, Authy …)
 *  - one-time recovery codes (stored only as hashes)
 *  - authenticator secrets encrypted at rest with AES-256-GCM
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/* Most common passwords (global + India-specific). Lower-case; compared after removing digits/symbols too. */
const COMMON = new Set(("123456 password 12345678 qwerty 123456789 12345 1234 111111 1234567 dragon 123123 baseball abc123 football monkey letmein 696969 shadow master 666666 qwertyuiop " +
  "123321 mustang 1234567890 michael 654321 superman 1qaz2wsx 7777777 121212 000000 qazwsx 123qwe killer trustno1 jordan jennifer zxcvbnm asdfgh hunter buster soccer harley batman " +
  "andrew tigger sunshine iloveyou 2000 charlie robert thomas hockey ranger daniel starwars klaster 112233 george computer michelle jessica pepper 1111 zxcvbn 555555 11111111 131313 " +
  "freedom 777777 pass maggie 159753 aaaaaa ginger princess joshua cheese amanda summer love ashley nicole chelsea biteme matthew access yankees 987654321 dallas austin thunder taylor " +
  "matrix welcome admin administrator passw0rd password1 password123 qwerty123 india india123 india@123 bharat chennai chennai123 madurai coimbatore tamilnadu tamil krishna ganesh " +
  "murugan sairam saibaba om omsairam jaihind jaishriram vande mataram cricket dhoni sachin virat kohli rajini vijay ajith sashwanth travels travel welcome123 test test123 " +
  "changeme default guest login secret root toor 1q2w3e4r 1q2w3e4r5t qwe123 asdf1234 abcd1234 abcdef abcdefg iloveu loveyou").split(/\s+/));

const SEQS = ["0123456789", "abcdefghijklmnopqrstuvwxyz", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
function hasSequence(pw, n = 5) {
  const p = pw.toLowerCase();
  for (const s of SEQS) for (const src of [s, [...s].reverse().join("")]) for (let i = 0; i + n <= src.length; i++) if (p.includes(src.slice(i, i + n))) return true;
  return false;
}

/* Returns a list of plain-language problems; empty = acceptable. */
function passwordProblems(pw, who = {}) {
  pw = String(pw || "");
  const out = [];
  if (pw.length < 10) out.push("Use at least 10 characters.");
  if (pw.length > 128) out.push("Use at most 128 characters.");
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (pw.length < 16 && classes < 3) out.push("Mix at least 3 of: lower-case, upper-case, numbers, symbols (or use 16+ characters).");
  const low = pw.toLowerCase(), core = low.replace(/[^a-z]/g, "");
  if (COMMON.has(low) || COMMON.has(core) || /pass(word)?|qwerty|letmein|welcome|admin/.test(low)) out.push("This is a very common password. Choose something less predictable.");
  if (/(.)\1{3,}/.test(pw)) out.push("Avoid repeating the same character 4 or more times.");
  if (hasSequence(pw)) out.push("Avoid sequences like 12345 or abcde.");
  const parts = [...String(who.name || "").toLowerCase().split(/[^a-z஀-௿]+/), String(who.email || "").toLowerCase().split("@")[0]].filter(t => t && t.length >= 4);
  if (parts.some(t => low.includes(t))) out.push("Don't use your name or email in the password.");
  const ph = String(who.phone || "").replace(/\D/g, "").slice(-10);
  if (ph.length === 10 && (pw.includes(ph) || pw.includes(ph.slice(-6)))) out.push("Don't use your mobile number in the password.");
  return out;
}

/* Have I Been Pwned "range" API: only the first 5 characters of the SHA-1 are sent. Fails open (never blocks sign-up if unreachable). */
async function isLeaked(pw, fetchImpl, timeoutMs = 4000) {
  const h = crypto.createHash("sha1").update(String(pw)).digest("hex").toUpperCase();
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl("https://api.pwnedpasswords.com/range/" + h.slice(0, 5), { headers: { "Add-Padding": "true", "User-Agent": "SashwanthTravels-security" }, signal: ctl.signal });
    if (!r.ok) return false;
    const text = typeof r.text === "function" ? await r.text() : "";
    return text.split(/\r?\n/).some(line => { const [suf, n] = line.trim().split(":"); return suf === h.slice(5) && Number(n) > 0; });
  } catch { return false; } finally { clearTimeout(t); }
}

/* ---------- TOTP (RFC 6238) ---------- */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function b32encode(buf) { let bits = 0, val = 0, out = ""; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; return out; }
function b32decode(s) { const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, ""); let bits = 0, val = 0; const out = []; for (const c of clean) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function hotp(secretBuf, counter, digits = 6) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", secretBuf).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 10 ** digits;
  return String(code).padStart(digits, "0");
}
const totp = (secretB32, t = Date.now()) => hotp(b32decode(secretB32), Math.floor(t / 30000));
/* Accepts the current code or one step either side (clock drift). Returns the time step used, or -1. */
function verifyTotp(secretB32, code, t = Date.now(), lastStep = -1) {
  code = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return -1;
  const key = b32decode(secretB32), step = Math.floor(t / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastStep) continue; /* a code can't be used twice */
    const exp = hotp(key, s);
    if (crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(code))) return s;
  }
  return -1;
}
const newSecret = () => b32encode(crypto.randomBytes(20));
const otpauthUri = (secret, account, issuer) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/* ---------- recovery codes ---------- */
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
function newRecoveryCodes(n = 10) {
  const alpha = "abcdefghjkmnpqrstuvwxyz23456789";
  const codes = Array.from({ length: n }, () => { const b = crypto.randomBytes(8); let s = ""; for (let i = 0; i < 8; i++) s += alpha[b[i] % alpha.length]; return s.slice(0, 4) + "-" + s.slice(4); });
  return { codes, hashes: codes.map(c => sha(c)) };
}
function useRecoveryCode(hashes, code) {
  const h = sha(String(code || "").trim().toLowerCase().replace(/\s/g, ""));
  const i = (hashes || []).indexOf(h);
  if (i < 0) return null;
  const left = hashes.slice(); left.splice(i, 1); return left;
}

/* ---------- secrets at rest (AES-256-GCM) ---------- */
function loadKey(dataDir, envKey) {
  if (envKey && /^[0-9a-f]{64}$/i.test(envKey)) return Buffer.from(envKey, "hex");
  const f = path.join(dataDir, ".secret-key");
  try { const k = fs.readFileSync(f, "utf8").trim(); if (/^[0-9a-f]{64}$/i.test(k)) return Buffer.from(k, "hex"); } catch { /* create below */ }
  const k = crypto.randomBytes(32); fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(f, k.toString("hex"), { mode: 0o600 }); return k;
}
function seal(key, text) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv); const enc = Buffer.concat([c.update(String(text), "utf8"), c.final()]); return [iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join("."); }
function open(key, sealed) { const [iv, tag, enc] = String(sealed).split(".").map(x => Buffer.from(x, "base64url")); const d = crypto.createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString("utf8"); }

/* Short, privacy-friendly descriptions for the sign-in history. */
function deviceLabel(ua) {
  ua = String(ua || "");
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iPhone/iPad" : /Windows/i.test(ua) ? "Windows" : /Mac OS/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "Unknown device";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${br} on ${os}`;
}
const maskIp = ip => { ip = String(ip || "").replace(/^::ffff:/, ""); if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.replace(/\.\d+$/, ".x"); if (ip.includes(":")) return ip.split(":").slice(0, 3).join(":") + ":…"; return ip || "unknown"; };

module.exports = { passwordProblems, isLeaked, totp, verifyTotp, newSecret, otpauthUri, b32encode, b32decode, newRecoveryCodes, useRecoveryCode, loadKey, seal, open, deviceLabel, maskIp, hasSequence };
