"use strict";
/*
 * Access rules for the document store — the same rules the Claude-hosted version declares.
 * Levels: view < interact < admin < owner. "self" = nobody else.
 *   guest (not signed in) = view, customer = interact, staff (manager/driver) = admin, owner = owner.
 * A rule covers its path and everything below; the deepest matching rule wins.
 * "<prefix>/{self}" covers each user's own subtree; for other users' subtrees only the prefix rule applies.
 */
const RANK = { view: 0, interact: 1, admin: 2, owner: 3, self: 99 };

const RULES = [
  { path: "", read: "view", write: "interact" },
  { path: "site", read: "view", write: "admin" },
  { path: "site/roles", read: "view", write: "owner" },
  { path: "requests", read: "admin", write: "admin" },
  { path: "requests/{self}", read: "interact", write: "interact" },
  { path: "decisions", read: "admin", write: "admin" },
  { path: "decisions/{self}", read: "interact", write: "admin" },
  { path: "customers", read: "admin", write: "admin" },
  /* Flights & hotels: written only by the server (see server.js); customers read their own. */
  { path: "travel", read: "admin", write: "owner" },
  { path: "travel/{self}", read: "interact", write: "owner" },
  /* Destination photos: everyone reads; only the server writes (owner edits go through /api/photos). */
  { path: "photos", read: "view", write: "owner" }
];

const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function splitPath(p) {
  const segs = String(p || "").split("/");
  if (!segs.length || segs.length > 16 || segs.some(s => !SEG.test(s) || s === "." || s === "..")) {
    throw Object.assign(new Error("Invalid path"), { status: 400 });
  }
  return segs;
}

/* Effective {read, write} levels for a path, as seen by user `uid`. */
function levelsFor(path, uid, rules = RULES) {
  const segs = splitPath(path);
  let best = { read: "view", write: "interact", depth: -1 };
  let own = null;
  for (const r of rules) {
    const rs = r.path ? r.path.split("/") : [];
    if (rs.length > segs.length) continue;
    let ok = true, selfMatch = false;
    for (let i = 0; i < rs.length; i++) {
      if (rs[i] === "{self}") { if (uid && segs[i] === uid) selfMatch = true; else { ok = false; break; } }
      else if (rs[i] !== segs[i]) { ok = false; break; }
    }
    if (!ok) continue;
    const entry = { read: r.read, write: r.write, depth: rs.length };
    if (selfMatch) { if (!own || entry.depth > own.depth) own = entry; }
    else if (entry.depth > best.depth) best = { read: r.read || best.read, write: r.write || best.write, depth: entry.depth };
  }
  if (own) {
    const pick = (a, b) => (RANK[a] <= RANK[b] ? a : b); // the more permissive of the two
    return { read: pick(own.read, best.read), write: pick(own.write, best.write) };
  }
  return { read: best.read, write: best.write };
}

const allowed = (needed, level) => needed !== "self" && RANK[level] >= RANK[needed];
const canRead = (path, uid, level) => allowed(levelsFor(path, uid).read, level);
const canWrite = (path, uid, level) => allowed(levelsFor(path, uid).write, level) && allowed(levelsFor(path, uid).read, level);

module.exports = { RULES, RANK, levelsFor, canRead, canWrite, splitPath };
