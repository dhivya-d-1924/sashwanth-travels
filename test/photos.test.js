"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const PP = require("../server/photopick.js");
const { createPhotos, DESTS } = require("../server/photos.js");
const { createApp } = require("../server/server.js");

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
const page = (title, o = {}) => ({ title: "File:" + title, categories: (o.cats || []).map(c => ({ title: "Category:" + c })),
  imageinfo: [{ mime: o.mime || "image/jpeg", width: o.w || 4000, height: o.h || 2600, thumburl: `https://upload.wikimedia.org/thumb/${encodeURIComponent(title)}/1920px-${encodeURIComponent(title)}`, descriptionurl: "https://commons.wikimedia.org/wiki/File:" + encodeURIComponent(title),
    extmetadata: { LicenseShortName: { value: o.lic || "CC BY-SA 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" }, Artist: { value: o.artist || '<a href="//commons.wikimedia.org/wiki/User:Ravi">Ravi K</a>' } } }] });

test("selection rules: licence, size, orientation, file type, maps/archive scans, relevance", () => {
  const ctx = { from: "category", kw: ["pamban"], placeKw: ["rameswaram", "pamban"] };
  assert.ok(PP.candidate(page("Pamban Bridge at dawn.jpg"), ctx));
  assert.equal(PP.candidate(page("Pamban bridge.jpg", { lic: "CC BY-NC 2.0" }), ctx), null, "non-commercial licence rejected");
  assert.equal(PP.candidate(page("Pamban bridge.jpg", { lic: "Copyrighted" }), ctx), null);
  assert.equal(PP.candidate(page("Pamban bridge portrait.jpg", { w: 2000, h: 3000 }), ctx), null, "portrait rejected");
  assert.equal(PP.candidate(page("Pamban small.jpg", { w: 1200, h: 800 }), ctx), null, "low resolution rejected");
  assert.equal(PP.candidate(page("Pamban bridge map.jpg"), ctx), null, "maps rejected");
  assert.equal(PP.candidate(page("Pamban bridge 1914.jpg"), ctx), null, "archive photo rejected");
  assert.equal(PP.candidate(page("Pamban.svg", { mime: "image/svg+xml" }), ctx), null);
  const s = { from: "search", kw: ["tea"], placeKw: ["valparai"], kwIsPlace: false };
  assert.equal(PP.candidate(page("Tea garden in Munnar Kerala.jpg"), s), null, "search result naming another place rejected");
  assert.ok(PP.candidate(page("Tea estate near Valparai.jpg"), s));
  const c = PP.candidate(page("Pamban Bridge at dawn.jpg"), ctx);
  assert.equal(c.author, "Ravi K"); assert.equal(c.license, "CC BY-SA 4.0"); assert.match(c.attribution, /Ravi K \/ CC BY-SA 4\.0, via Wikimedia Commons/);
  assert.match(c.thumb, /\/960px-/); assert.match(c.small, /\/500px-/);
});

/* Fake Commons: each category returns a few files; a couple of files are shared between destinations. */
function fakeCommons(opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    if ((init.method || "GET") === "HEAD") { const broken = (opts.broken || []).some(b => url.includes(encodeURIComponent(b))); return { ok: !broken, status: broken ? 404 : 200, headers: { get: () => "image/jpeg" } }; }
    const u = new URL(url), cat = (u.searchParams.get("gcmtitle") || "").replace("Category:", ""), q = u.searchParams.get("gsrsearch") || "";
    const name = cat || q.replace(" filetype:bitmap", "");
    const pages = [1, 2, 3].map(i => page(`${name} view ${i}.jpg`, { cats: [cat || name] }));
    if (/Vivekananda|Thiruvalluvar/.test(name)) pages.push(page("Vivekananda Rock and Valluvar Statue at sunrise.jpg", { cats: ["Vivekananda Rock Memorial", "Thiruvalluvar Statue, Kanyakumari", "Kanyakumari"] }));
    return { ok: true, status: 200, json: async () => ({ query: { pages } }) };
  };
  return { fetchImpl, calls };
}
const mkD = () => ({ meta: {}, docs: {}, users: {} });

test("every destination gets a featured hero and 4–8 verified photos; no file used twice anywhere", async () => {
  const D = mkD(), fc = fakeCommons({ broken: ["Pamban Bridge view 1.jpg"] });
  const ph = createPhotos({ D, store: { save() {} }, changed() {}, HttpError, fetchImpl: fc.fetchImpl, log: { warn() {} }, delayMs: 0 });
  await ph.refresh();
  while (ph.status().running) await new Promise(r => setTimeout(r, 20));
  const view = ph.publicView();
  assert.equal(view.length, 12);
  const seen = new Map();
  for (const d of view) {
    assert.ok(d.images.length >= 4 && d.images.length <= 8, `${d.name}: ${d.images.length}`);
    assert.equal(d.images.filter(i => i.featured).length, 1, `${d.name} has exactly one hero`);
    for (const i of d.images) {
      for (const k of ["destinationId", "destinationName", "district", "attraction", "url", "source", "attribution", "license", "category"]) assert.ok(i[k] !== undefined && i[k] !== "", `${d.name} image missing ${k}`);
      assert.equal(typeof i.featured, "boolean");
      assert.ok(!seen.has(i.url), `photo reused: ${i.url} in ${d.name} and ${seen.get(i.url)}`); seen.set(i.url, d.name);
    }
  }
  assert.ok(![...seen.keys()].some(u => u.includes(encodeURIComponent("Pamban Bridge view 1.jpg"))), "a link that doesn't load is never shown");
  const ky = view.find(d => d.id === "kanyakumari");
  assert.ok(ky.images.some(i => /Vivekananda Rock and Valluvar/.test(decodeURIComponent(i.url))));
  assert.equal(view.find(d => d.id === "chennai").images.find(i => i.attractionId === "mahabalipuram")?.district ?? "Chengalpattu", "Chengalpattu");
});

test("owner choices: feature, hide, add a licensed photo (validated), broken reports hide dead links", async () => {
  const D = mkD(), fc = fakeCommons();
  const ph = createPhotos({ D, store: { save() {} }, changed() {}, HttpError, fetchImpl: fc.fetchImpl, log: { warn() {} }, delayMs: 0 });
  await ph.refresh(["ooty"]); while (ph.status().running) await new Promise(r => setTimeout(r, 20));
  let imgs = ph.publicView().find(d => d.id === "ooty").images;
  ph.update("ooty", imgs[2].id, { featured: true });
  ph.update("ooty", imgs[1].id, { hidden: true });
  imgs = ph.publicView().find(d => d.id === "ooty").images;
  assert.equal(imgs.find(i => i.featured).id, imgs.find(i => i.ownerFeatured).id);
  assert.ok(!ph.publicView().find(d => d.id === "ooty").images.some(i => i.hidden), "hidden photos are not public");
  assert.ok(ph.publicView(true).find(d => d.id === "ooty").images.some(i => i.hidden), "staff still see them");
  await assert.rejects(ph.addManual("ooty", { url: "http://x.com/a.jpg", author: "A", license: "Licensed", source: "TN Tourism" }), /https/);
  await assert.rejects(ph.addManual("ooty", { url: "https://x.com/a.jpg", author: "", license: "L", source: "S" }), /photographer/);
  const m = await ph.addManual("ooty", { url: "https://tourism.example/ooty-lake.jpg", attractionId: "ooty-botanical", author: "TN Tourism", license: "Licensed for Sashwanth Travels", source: "Tamil Nadu Tourism" });
  assert.equal(m.manual, true); assert.equal(m.attraction, "Government Botanical Garden");
  /* the featured choice survives an automatic refresh */
  const featuredId = imgs.find(i => i.featured).id;
  await ph.refresh(["ooty"]); while (ph.status().running) await new Promise(r => setTimeout(r, 20));
  assert.equal(ph.publicView(true).find(d => d.id === "ooty").images.find(i => i.featured).id, featuredId);
  assert.ok(ph.publicView(true).find(d => d.id === "ooty").images.some(i => i.manual), "owner photos are kept on refresh");
  /* broken link */
  const D2 = mkD(), fc2 = fakeCommons(); const ph2 = createPhotos({ D: D2, store: { save() {} }, changed() {}, HttpError, fetchImpl: fc2.fetchImpl, log: { warn() {} }, delayMs: 0 });
  await ph2.refresh(["hogenakkal"]); while (ph2.status().running) await new Promise(r => setTimeout(r, 20));
  const h = ph2.publicView().find(d => d.id === "hogenakkal").images[0];
  const dead = createPhotos({ D: D2, store: { save() {} }, changed() {}, HttpError, fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => "" } }), log: { warn() {} } });
  assert.equal((await dead.reportBroken("hogenakkal", h.id)).hidden, true);
  assert.ok(!dead.publicView().find(d => d.id === "hogenakkal").images.some(i => i.id === h.id));
});

test("photo documents can't be written by visitors; API is public read, staff-only actions", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-ph-")), fc = fakeCommons();
  const app = createApp({ dataDir: dir, fetchImpl: fc.fetchImpl, limitScale: 20, owner: { name: "Owner", email: "o@st.in", phone: "9000000001", password: "owner-pass-123" } });
  await app.locals.ready; const server = await new Promise(r => { const s = app.listen(0, () => r(s)); }); const base = "http://127.0.0.1:" + server.address().port;
  const call = async (p, { method = "GET", body, cookie } = {}) => { const h = { "X-SST": "1" }; if (body) h["Content-Type"] = "application/json"; if (cookie) h.Cookie = cookie; const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})), cookie: (/sst_sid=([^;]*)/.exec(r.headers.get("set-cookie") || "") || [])[0] }; };
  try {
    assert.equal((await call("/api/photos")).body.destinations.length, 12);
    assert.equal((await call("/api/photos/refresh", { method: "POST", body: {} })).status, 401);
    const own = await call("/api/auth/login", { method: "POST", body: { login: "o@st.in", password: "owner-pass-123" } });
    assert.equal((await call("/api/db/doc", { method: "POST", body: { path: "photos/ooty", op: "set", data: { images: [] } }, cookie: own.cookie })).status, 403);
    assert.equal((await call("/api/photos/refresh", { method: "POST", body: { destinationId: "madurai" }, cookie: own.cookie })).body.started, true);
    for (let i = 0; i < 100 && (await call("/api/photos?all=1", { cookie: own.cookie })).body.job.running; i++) await new Promise(r => setTimeout(r, 30));
    assert.ok((await call("/api/photos")).body.destinations.find(d => d.id === "madurai").images.length >= 4);
  } finally { app.locals.store.flushNow(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});
