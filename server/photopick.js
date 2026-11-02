/* Photo selection rules shared by the server and the page (copied into src/site.html by scripts/sync-shared.js).
   A photo is used only if it is: from the place's own Commons category (or names the place in its title/categories),
   freely licensed (CC0 / public domain / CC BY / CC BY-SA), a real photograph (JPEG/PNG/WebP), landscape and high resolution,
   not a map/diagram/logo/old archive scan, and not already used for another destination. */
(function (root, factory) { if (typeof module === "object" && module.exports) module.exports = factory(); else root.PhotoPick = factory(); })(typeof self !== "undefined" ? self : this, function () {
  const API = "https://commons.wikimedia.org/w/api.php";
  const BAD_TITLE = /\b(map|plan|diagram|logo|emblem|seal|flag|sign ?board|signage|ticket|chart|svg|drawing|sketch|painting|stamp|coin|poster|screenshot|selfie)\b|\.(svg|tif|tiff|gif|pdf|djvu)$/i;
  const OLD = /\b1[89]\d\d\b/; /* archive photos (1800s–1999 in the title) */
  const OK_LICENSE = /^(cc0|public domain|pd\b|pd-|cc[ -]by(-sa)?[ -]?\d|cc[ -]by(-sa)?$|attribution)/i;
  const strip = html => String(html || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, " ").trim();
  const norm = s => String(s || "").toLowerCase().replace(/_/g, " ");

  /* Query: all files in a category (or a search), with size, licence, author and categories, plus a 1920 px thumbnail. */
  function apiUrl(kind, value, origin) {
    const p = { action: "query", format: "json", formatversion: "2", prop: "imageinfo|categories", iiprop: "url|size|mime|extmetadata", iiurlwidth: "1920",
      iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist|Credit|ObjectName|DateTimeOriginal", cllimit: "max" };
    if (kind === "category") Object.assign(p, { generator: "categorymembers", gcmtitle: "Category:" + value, gcmtype: "file", gcmlimit: "60" });
    else Object.assign(p, { generator: "search", gsrsearch: value + " filetype:bitmap", gsrnamespace: "6", gsrlimit: "40" });
    if (origin) p.origin = "*";
    return API + "?" + Object.entries(p).map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  }
  /* One Commons file → a candidate photo (or null if it fails any rule). */
  function candidate(page, ctx) {
    const ii = page.imageinfo && page.imageinfo[0]; if (!ii) return null;
    const title = page.title || "", t = norm(title), cats = (page.categories || []).map(c => norm(c.title)).join(" | ");
    const m = ii.extmetadata || {}, lic = strip(m.LicenseShortName && m.LicenseShortName.value);
    if (!/^image\/(jpeg|png|webp)$/.test(ii.mime || "")) return null;
    if (BAD_TITLE.test(title) || OLD.test(title) || /historical|archival|old photo/.test(cats)) return null;
    if (!(ii.width >= 1600 && ii.width >= ii.height * 1.25)) return null; /* landscape, high resolution */
    if (!OK_LICENSE.test(lic) || /\bnc\b|\bnd\b|non-?commercial|noderiv/i.test(lic)) return null;
    /* relevance: category files are already location-filed; search results (and broad categories) must name the place */
    const hay = t + " | " + cats;
    const placeOk = (ctx.placeKw || []).some(k => hay.includes(k)), attrOk = (ctx.kw || []).some(k => hay.includes(k));
    if (ctx.from === "search" && !(attrOk && (placeOk || ctx.kwIsPlace))) return null;
    if (ctx.from === "category" && ctx.needPlace && !(placeOk && attrOk)) return null;
    if (!ii.thumburl) return null;
    const quality = /featured pictures|quality images|valued images|pictures of the day/.test(cats) ? 1 : 0;
    const author = strip(m.Artist && m.Artist.value).slice(0, 120) || "Unknown photographer";
    const licUrl = strip(m.LicenseUrl && m.LicenseUrl.value);
    return {
      fileTitle: title, url: ii.thumburl, thumb: ii.thumburl.replace(/\/1920px-/, "/960px-"), small: ii.thumburl.replace(/\/1920px-/, "/500px-"),
      width: ii.width, height: ii.height, sourceUrl: ii.descriptionurl || ("https://commons.wikimedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_"))),
      source: "Wikimedia Commons", author, license: lic, licenseUrl: /^https?:\/\//.test(licUrl) ? licUrl : "",
      attribution: `Photo: ${author} / ${lic}, via Wikimedia Commons`,
      score: quality * 100 + Math.min(ii.width, 6000) / 100 + (Math.abs(ii.width / ii.height - 1.5) < .25 ? 10 : 0) + (attrOk ? 15 : 0)
    };
  }
  /* Pick a hero + 4–8 gallery photos for one destination from per-attraction candidate lists. No file is used twice site-wide. */
  function assemble(dest, perAttraction, used, maxTotal = 8) {
    const out = [], take = (c, a, category, featured) => { used.add(c.fileTitle); out.push({ ...c, destinationId: dest.id, destinationName: dest.name, district: a.district || dest.district, attraction: a.name, attractionId: a.id, category, featured: !!featured }); };
    const lists = dest.attractions.map(a => ({ a, list: (perAttraction[a.id] || []).filter(c => !used.has(c.fileTitle)).sort((x, y) => y.score - x.score) }));
    /* hero: the best photo of the first attraction that has one */
    const heroFrom = lists.find(l => l.list.length);
    if (heroFrom) take(heroFrom.list.shift(), heroFrom.a, heroFrom.a.type, true);
    /* round-robin so every attraction is represented */
    let added = true;
    while (out.length < maxTotal && added) { added = false; for (const l of lists) { while (l.list.length && used.has(l.list[0].fileTitle)) l.list.shift(); if (l.list.length && out.length < maxTotal) { take(l.list.shift(), l.a, l.a.type, false); added = true; } } }
    return out;
  }
  return { apiUrl, candidate, assemble, strip, OK_LICENSE };
});
