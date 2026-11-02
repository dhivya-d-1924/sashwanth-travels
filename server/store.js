"use strict";
/* JSON-file store with atomic writes: documents, user accounts and photo metadata.
   Swap for PostgreSQL when volume grows (see README). */
const fs = require("fs");
const path = require("path");

function createStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data = { docs: {}, users: {}, assets: {}, meta: {} };
  if (fs.existsSync(file)) {
    try { data = Object.assign(data, JSON.parse(fs.readFileSync(file, "utf8"))); }
    catch (e) { throw new Error(`Could not read ${file}: ${e.message}`); }
  }
  for (const k of ["docs", "users", "assets", "meta"]) if (!data[k] || typeof data[k] !== "object") data[k] = {};

  let timer = null;
  const flush = () => {
    timer = null;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  };
  return {
    get data() { return data; },
    save() { if (!timer) timer = setTimeout(flush, 30); },
    flushNow() { if (timer) { clearTimeout(timer); flush(); } }
  };
}

/* Firestore-style merge: nested objects merge, everything else (arrays included) replaces. */
function deepMerge(target, patch) {
  const out = Object.assign({}, target);
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

module.exports = { createStore, deepMerge };
