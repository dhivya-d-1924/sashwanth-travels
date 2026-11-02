"use strict";
/* Copies the shared destination catalogue and photo rules into src/site.html (between marker comments),
   so the self-hosted site and the page published in Claude use exactly the same data and rules. */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const file = path.join(ROOT, "src", "site.html");
let html = fs.readFileSync(file, "utf8");
const put = (name, code) => {
  const a = `/*<${name}>*/`, b = `/*</${name}>*/`;
  const i = html.indexOf(a), j = html.indexOf(b);
  if (i < 0 || j < 0) throw new Error(`Marker ${a} missing in src/site.html`);
  html = html.slice(0, i + a.length) + code + html.slice(j);
};
const dests = JSON.parse(fs.readFileSync(path.join(ROOT, "server", "destinations.json"), "utf8"));
put("destinations", "const DESTS=" + JSON.stringify(dests) + ";");
put("photopick", "const PhotoPick=(()=>{const module={exports:{}};" + fs.readFileSync(path.join(ROOT, "server", "photopick.js"), "utf8").replace(/\(typeof self !== "undefined" \? self : this\)/, "(module)") + ";return module.exports})();");
fs.writeFileSync(file, html);
if (require.main === module) console.log("[sync] destinations and photo rules copied into src/site.html");
