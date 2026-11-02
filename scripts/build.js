"use strict";
/*
 * Builds public/index.html from src/site.html — the same page that is published inside Claude.
 * The page's script and styles are split into files so the server can send a strict
 * Content-Security-Policy, and the self-hosted adapter (claude-shim.js) loads first.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "src", "site.html"), "utf8");
/* Version stamp on file URLs so browsers always load the new files after an update. */
const V = require(path.join(ROOT, "package.json")).version + "-" + Date.now().toString(36);

const styleStart = src.indexOf("<style>"), styleEnd = src.indexOf("</style>");
const scriptStart = src.lastIndexOf("<script>"), scriptEnd = src.lastIndexOf("</script>");
if (styleStart < 0 || scriptStart < 0) throw new Error("src/site.html must contain one <style> and one <script> block");
const css = src.slice(styleStart + 7, styleEnd);
const js = src.slice(scriptStart + 8, scriptEnd);
const title = (/<title>([^<]*)<\/title>/.exec(src) || [, "Sashwanth Travels"])[1];
const head = src.slice(0, styleStart).replace(/<title>[^<]*<\/title>\s*/, "").replace(/<meta name="claude:viewport-fit-sides"[^>]*>\s*/, "");
const body = src.slice(styleEnd + 8, scriptStart);

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="Book cabs, Tempo Travellers and tour trips across Tamil Nadu with Saarathi, our AI booking agent.">
<meta name="theme-color" content="#13213A">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%2313213A' stroke='%23E39E12' stroke-width='2'/%3E%3Cpath d='M16 4L19 16L16 28L13 16Z' fill='%23E39E12'/%3E%3C/svg%3E">
${head.trim()}
<link rel="stylesheet" href="/site.css?v=${V}">
<script src="/claude-shim.js?v=${V}"></script>
</head>
<body>
${body.trim()}
<script src="/site.js?v=${V}"></script>
</body>
</html>
`;
const reset = `:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px/1.5 system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}\n`;
fs.writeFileSync(path.join(ROOT, "public", "index.html"), html);
fs.writeFileSync(path.join(ROOT, "public", "site.css"), reset + css);
fs.writeFileSync(path.join(ROOT, "public", "site.js"), js);
console.log("[build] public/index.html, site.css, site.js generated from src/site.html");

/* Map library (Leaflet) served from our own origin so the strict CSP stays 'self'. */
try {
  const L = path.join(ROOT, "node_modules", "leaflet", "dist"), out = path.join(ROOT, "public", "vendor", "leaflet");
  fs.mkdirSync(path.join(out, "images"), { recursive: true });
  for (const f of ["leaflet.js", "leaflet.css"]) fs.copyFileSync(path.join(L, f), path.join(out, f));
  for (const f of fs.readdirSync(path.join(L, "images"))) fs.copyFileSync(path.join(L, "images", f), path.join(out, "images", f));
} catch (e) { console.warn("[build] Leaflet not found — run npm install to enable maps."); }
