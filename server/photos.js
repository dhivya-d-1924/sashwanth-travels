"use strict";
/*
 * Real destination photos from Wikimedia Commons.
 * - Searches each attraction's own Commons category (and, only if needed, a search whose results must name the place).
 * - Keeps only freely licensed, landscape, high-resolution photographs; records author, licence and source for attribution.
 * - Never uses the same file for two destinations.
 * - Checks every chosen link actually loads before it is shown; a link reported broken later is re-checked and hidden.
 * Stored per destination in the document "photos/<destinationId>" (read by everyone, written only by the server).
 */
const crypto = require("crypto");
const PP = require("./photopick");
const DESTS = require("./destinations.json");

const GENERIC = /^(palace|lake|falls|tea|view|point|seat|peak|pine|sunrise|sunset|dawn|main fall|five fall)$/;
const idOf = t => crypto.createHash("sha1").update(String(t)).digest("hex").slice(0, 12);

function createPhotos({ D, store, changed, HttpError, fetchImpl = fetch, contact = "", log = console, delayMs = 250 }) {
  const UA = `SashwanthTravels/3.2 (${contact || "owner@example.com"}) photo-collector`;
  D.meta.photoJob = D.meta.photoJob || { running: false };
  const job = D.meta.photoJob;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function api(url) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
    try { const r = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctl.signal }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
    finally { clearTimeout(t); }
  }
  /* A link counts as working only if it answers 200 with an image type. */
  async function linkOk(url) {
    try {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 10000);
      const r = await fetchImpl(url, { method: "HEAD", headers: { "User-Agent": UA }, signal: ctl.signal }); clearTimeout(t);
      const ct = (r.headers && typeof r.headers.get === "function" ? r.headers.get("content-type") : "") || "";
      return r.ok && /^image\//.test(ct);
    } catch { return false; }
  }
  const docOf = id => (D.docs["photos/" + id] || {}).data || null;
  function save(id, data) { const cur = D.docs["photos/" + id]; D.docs["photos/" + id] = { data, version: (cur ? cur.version : 0) + 1, updatedAt: Date.now(), by: "system" }; store.save(); changed("photos/" + id); }

  async function collect(dest, used) {
    const per = {};
    const attractions = [...dest.attractions, { id: dest.id + "-views", name: "Around " + dest.name, type: "landscape", cats: dest.cats, kw: dest.kw, district: dest.district }];
    for (const a of attractions) {
      const list = [];
      for (const cat of a.cats || []) {
        try {
          const j = await api(PP.apiUrl("category", cat));
          for (const p of (j.query && j.query.pages) || []) { const c = PP.candidate(p, { from: "category", needPlace: !!a.needPlace, kw: a.kw, placeKw: dest.kw }); if (c) list.push(c); }
        } catch (e) { log.warn(`[photos] ${dest.id}/${a.id} Category:${cat}: ${e.message}`); }
        await sleep(delayMs);
      }
      if (list.length < 2) {
        try {
          const kwIsPlace = !a.needPlace && (a.kw || []).every(k => !GENERIC.test(k));
          const j = await api(PP.apiUrl("search", `${a.name} ${dest.name}`));
          for (const p of (j.query && j.query.pages) || []) { const c = PP.candidate(p, { from: "search", kw: a.kw, placeKw: dest.kw, kwIsPlace }); if (c && !list.some(x => x.fileTitle === c.fileTitle)) list.push(c); }
        } catch (e) { log.warn(`[photos] ${dest.id}/${a.id} search: ${e.message}`); }
        await sleep(delayMs);
      }
      per[a.id] = list;
    }
    return { per, attractions };
  }
  /* Refresh one destination: collect, assemble, verify links, keep the owner's manual photos and hide/feature choices. */
  async function refreshOne(dest, used) {
    const prev = docOf(dest.id) || { images: [] };
    const keep = prev.images.filter(i => i.manual);
    const prefs = Object.fromEntries(prev.images.map(i => [i.id, { hidden: i.hidden, featured: i.featured, ownerFeatured: i.ownerFeatured }]));
    keep.forEach(i => used.add(i.fileTitle || i.url));
    const { per, attractions } = await collect(dest, used);
    const picked = PP.assemble({ ...dest, attractions }, per, used, 12); /* a few spares in case some links fail */
    const verified = [];
    for (const img of picked) {
      if (verified.length >= 8) { used.delete(img.fileTitle); continue; }
      if (!(await linkOk(img.url))) { used.delete(img.fileTitle); continue; }
      if (!(await linkOk(img.thumb))) img.thumb = img.url;
      if (!(await linkOk(img.small))) img.small = img.thumb;
      const id = idOf(img.fileTitle), p = prefs[id] || {};
      verified.push({ id, ...img, score: undefined, hidden: !!p.hidden, featured: p.ownerFeatured ? true : img.featured, ownerFeatured: !!p.ownerFeatured, verifiedAt: Date.now() });
    }
    let images = [...verified, ...keep];
    if (images.some(i => i.ownerFeatured)) images.forEach(i => { i.featured = !!i.ownerFeatured; });
    if (!images.some(i => i.featured && !i.hidden) && images.find(i => !i.hidden)) images.find(i => !i.hidden).featured = true;
    save(dest.id, { destinationId: dest.id, images, updatedAt: Date.now(), source: "Wikimedia Commons" });
    return images.length;
  }
  async function refresh(destIds) {
    if (job.running) return { started: false, running: true };
    const list = destIds && destIds.length ? DESTS.filter(d => destIds.includes(d.id)) : DESTS;
    Object.assign(job, { running: true, total: list.length, done: 0, at: Date.now(), errors: [], current: "" });
    /* files already used by other destinations stay reserved */
    const used = new Set();
    for (const d of DESTS) if (!list.includes(d)) (docOf(d.id) || { images: [] }).images.forEach(i => used.add(i.fileTitle || i.url));
    (async () => {
      for (const d of list) {
        job.current = d.name;
        try { const n = await refreshOne(d, used); if (n < 4) job.errors.push(`${d.name}: only ${n} suitable photos found`); }
        catch (e) { job.errors.push(`${d.name}: ${e.message}`); log.warn("[photos]", d.id, e.message); }
        job.done++; store.save();
      }
      job.running = false; job.current = ""; job.finishedAt = Date.now(); store.save();
    })();
    return { started: true, total: list.length };
  }
  /* Refresh destinations that have no photos or are older than 7 days (called on start and daily). */
  function autoRefresh() {
    if (job.running) return;
    const stale = DESTS.filter(d => { const doc = docOf(d.id); return !doc || !doc.images.length || Date.now() - doc.updatedAt > 7 * 864e5; }).map(d => d.id);
    if (stale.length) refresh(stale);
  }
  function publicView(includeHidden) {
    return DESTS.map(d => { const doc = docOf(d.id) || { images: [] }; return { ...d, cats: undefined, attractions: d.attractions.map(a => ({ id: a.id, name: a.name, type: a.type, district: a.district || d.district })), images: doc.images.filter(i => includeHidden || !i.hidden).map(i => ({ ...i, fileTitle: undefined })), updatedAt: doc.updatedAt || null }; });
  }
  function update(destId, id, patch) {
    const doc = docOf(destId); if (!doc) throw new HttpError(404, "No photos for this destination yet.");
    const img = doc.images.find(i => i.id === id); if (!img) throw new HttpError(404, "Photo not found.");
    if (patch.hidden !== undefined) img.hidden = !!patch.hidden;
    if (patch.featured) { doc.images.forEach(i => { i.featured = false; i.ownerFeatured = false; }); img.featured = true; img.ownerFeatured = true; img.hidden = false; }
    if (!doc.images.some(i => i.featured && !i.hidden)) { const f = doc.images.find(i => !i.hidden); if (f) f.featured = true; }
    save(destId, doc); return img;
  }
  async function addManual(destId, b) {
    const dest = DESTS.find(d => d.id === destId); if (!dest) throw new HttpError(404, "Unknown destination.");
    const a = dest.attractions.find(x => x.id === b.attractionId) || { name: dest.name, type: "landscape" };
    const url = String(b.url || "").trim();
    if (!/^https:\/\/[^\s"'<>]+$/.test(url)) throw new HttpError(400, "Use a full https link to the photo.");
    for (const [k, l] of [["author", "photographer or owner"], ["license", "licence"], ["source", "source"]]) if (!String(b[k] || "").trim()) throw new HttpError(400, `Enter the ${l}.`);
    if (!(await linkOk(url))) throw new HttpError(400, "That link doesn't load as an image. Check it opens in the browser.");
    const doc = docOf(destId) || { destinationId: destId, images: [], updatedAt: Date.now() };
    if (Object.values(D.docs).some(x => x && x.data && Array.isArray(x.data.images) && x.data.images.some(i => i.url === url))) throw new HttpError(409, "This photo is already used on the site.");
    const img = { id: idOf(url), manual: true, destinationId: destId, destinationName: dest.name, district: a.district || dest.district, attraction: a.name, attractionId: a.id || "", url, thumb: url, small: url,
      source: String(b.source).slice(0, 80), sourceUrl: /^https:\/\//.test(b.sourceUrl || "") ? String(b.sourceUrl) : "", author: String(b.author).slice(0, 120), license: String(b.license).slice(0, 80),
      licenseUrl: /^https:\/\//.test(b.licenseUrl || "") ? String(b.licenseUrl) : "", attribution: `Photo: ${String(b.author).slice(0, 120)} / ${String(b.license).slice(0, 80)}, ${String(b.source).slice(0, 80)}`,
      category: a.type || "landscape", featured: !doc.images.some(i => i.featured && !i.hidden), hidden: false, verifiedAt: Date.now() };
    doc.images.push(img); save(destId, doc); return img;
  }
  async function reportBroken(destId, id) {
    const doc = docOf(destId); const img = doc && doc.images.find(i => i.id === id); if (!img || img.hidden) return { ok: true };
    if (Date.now() - (img.checkedAt || 0) < 10 * 60e3) return { ok: true }; /* re-check at most every 10 minutes */
    img.checkedAt = Date.now();
    const ok = await linkOk(img.thumb) || await linkOk(img.url);
    if (!ok) { img.hidden = true; img.brokenAt = Date.now(); if (img.featured) { img.featured = false; const f = doc.images.find(i => !i.hidden); if (f) f.featured = true; } }
    save(destId, doc); return { ok, hidden: !ok };
  }
  return { refresh, autoRefresh, publicView, update, addManual, reportBroken, status: () => ({ ...job }), DESTS };
}

module.exports = { createPhotos, DESTS };
