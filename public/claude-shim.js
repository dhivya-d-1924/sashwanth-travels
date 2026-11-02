/*
 * Self-hosted adapter. The site's page was written against Claude's artifact runtime
 * (window.claude.use("db" | "user" | "assets" | "sample")). This file provides the same
 * interfaces backed by this server, so one page source runs in both places.
 * Access rules are enforced by the server, not here.
 */
(() => {
  "use strict";
  const H = { "Content-Type": "application/json", "X-SST": "1" };
  async function http(method, url, body) {
    let res;
    try { res = await fetch(url, { method, headers: body !== undefined ? H : { "X-SST": "1" }, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: "same-origin" }); }
    catch { throw { code: "unavailable", message: "Can't reach the server. Check your connection." }; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw { code: data.code || (res.status === 403 || res.status === 400 ? "invalid_argument" : res.status === 429 ? "rate_limited" : "unavailable"), message: data.error || "Request failed", status: res.status };
    return data;
  }
  const sessionP = http("GET", "/api/session").catch(() => ({ user: null, agent: false }));
  sessionP.then(s => {
    if (!window.claude) return;
    if (s.payments) window.claude.payments = payments;
    if (s.travel) { travel.status = s.travel; travel.canPay = !!s.payments; window.claude.travel = travel; }
    if (s.geo) window.claude.geo = geo;
    window.dispatchEvent(new Event("sst-payments"));
  });

  /* ---------------- db ---------------- */
  const subs = new Set();
  const parentOf = p => p.split("/").slice(0, -1).join("/");
  const snapDoc = (path, r) => ({ id: path.split("/").pop(), exists: !!r.exists, data: () => r.exists ? r.data : undefined, metadata: { fromCache: false, hasPendingWrites: false } });
  async function refresh(sub) {
    try {
      if (sub.kind === "doc") { const r = await http("GET", "/api/db/doc?path=" + encodeURIComponent(sub.path)); if (sub.alive) sub.next(snapDoc(sub.path, r)); }
      else {
        const r = await http("GET", "/api/db/collection?path=" + encodeURIComponent(sub.path));
        const docs = r.docs.map(d => ({ id: d.id, exists: true, data: () => d.data, metadata: { fromCache: false, hasPendingWrites: false } }));
        if (sub.alive) sub.next({ docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((doc, i) => ({ type: "added", doc, oldIndex: -1, newIndex: i })), metadata: { fromCache: false, hasPendingWrites: false } });
      }
    } catch (e) { if (sub.alive && sub.error && e.code === "invalid_argument") { sub.alive = false; sub.error(e); } }
  }
  function touch(p) { for (const s of subs) if ((s.kind === "doc" && s.path === p) || (s.kind === "col" && s.path === parentOf(p))) refresh(s); }
  let es = null;
  function connect() {
    if (es) return;
    es = new EventSource("/api/events");
    es.addEventListener("change", e => { try { touch(JSON.parse(e.data).path); } catch {} });
    let wasDown = false;
    es.onerror = () => { wasDown = true; };
    es.addEventListener("hello", () => { if (wasDown) { wasDown = false; subs.forEach(refresh); } });
  }
  function subscribe(kind, path, next, error) {
    const s = { kind, path, next, error, alive: true }; subs.add(s); connect();
    setTimeout(() => refresh(s), 0);
    return () => { s.alive = false; subs.delete(s); };
  }
  async function write(path, op, data) { await http("POST", "/api/db/doc", { path, op, data }); touch(path); }
  function docRef(path) {
    return {
      id: path.split("/").pop(), path,
      get: async () => snapDoc(path, await http("GET", "/api/db/doc?path=" + encodeURIComponent(path))),
      set: data => write(path, "set", data),
      update: data => write(path, "update", data),
      delete: () => write(path, "delete"),
      onSnapshot: (next, error) => subscribe("doc", path, next, error),
      collection: sub => colRef(path + "/" + sub)
    };
  }
  function colRef(path) {
    const self = {
      path,
      doc: id => docRef(path + "/" + (id || Date.now().toString(36) + Math.random().toString(36).slice(2, 8))),
      add: async data => { const d = self.doc(); await d.set(data); return d; },
      get: async () => new Promise((res, rej) => { const s = { kind: "col", path, alive: true, next: v => { s.alive = false; res(v); }, error: rej }; refresh(s); }),
      onSnapshot: (next, error) => subscribe("col", path, next, error),
      where: () => self, orderBy: () => self, limit: () => self
    };
    return self;
  }
  const db = { doc: docRef, collection: colRef };

  /* ---------------- user ---------------- */
  const userApi = {
    id: async () => (await sessionP).user?.id || null,
    isOwner: async () => !!(await sessionP).user?.isOwner,
    canEdit: async () => !!(await sessionP).user?.canEdit,
    can: async n => n === "data.write" ? !!(await sessionP).user : null,
    me: async () => { const u = (await sessionP).user; return u ? { id: u.id, name: u.name, avatarUrl: "", color: "", email: u.email, phone: u.phone, isOwner: u.isOwner, canEdit: u.canEdit, mustChange: !!u.mustChange, twoFactor: !!u.twoFactor } : { id: null, name: "", avatarUrl: "", color: "", email: null, isOwner: false, canEdit: false }; },
    name: async () => (await sessionP).user?.name || "",
    avatarUrl: async () => null,
    email: async () => (await sessionP).user?.email || null,
    search: async q => http("GET", "/api/users/search?q=" + encodeURIComponent(q || "")),
    profiles: async ids => http("POST", "/api/users/profiles", { ids })
  };

  /* ---------------- assets ---------------- */
  const assets = {
    async upload(blob, opt = {}) {
      const type = (opt.type || blob.type || "image/jpeg").split(";")[0];
      let res;
      try { res = await fetch("/api/assets", { method: "POST", headers: { "Content-Type": type, "X-SST": "1" }, body: blob, credentials: "same-origin" }); }
      catch { throw { code: "unavailable", message: "Upload failed. Check your connection." }; }
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw { code: "invalid_request", message: d.error || "Upload failed." };
      return d;
    },
    list: async () => ({ assets: [], usage: {} }),
    delete: async () => {}
  };

  /* ---------------- sample (Saarathi agent) ----------------
     Runs the tool loop here in the page; the server only relays each round to the Claude API. */
  async function sample(input, opts = {}) {
    const msgs = (typeof input === "string" ? [{ role: "user", content: input }] : input).map(m => ({ role: m.role, content: m.content }));
    const merged = [];
    for (const m of msgs) { if (merged.length && merged[merged.length - 1].role === m.role && typeof m.content === "string") merged[merged.length - 1].content += "\n\n" + m.content; else merged.push({ ...m }); }
    const tools = opts.tools || [];
    const defs = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: "object", properties: {} } }));
    let text = "";
    for (let round = 0; round < 6; round++) {
      if (opts.signal?.aborted) throw { code: "cancelled", text };
      let r;
      try {
        const res = await fetch("/api/llm", { method: "POST", headers: H, credentials: "same-origin", signal: opts.signal, body: JSON.stringify({ messages: merged, tools: defs, tier: opts.modelTier }) });
        r = await res.json().catch(() => ({}));
        if (!res.ok) throw { code: r.code || "upstream_error", message: r.error, text };
      } catch (e) { if (e?.name === "AbortError") throw { code: "cancelled", text }; throw e.code ? e : { code: "upstream_error", text }; }
      merged.push({ role: "assistant", content: r.content });
      const said = r.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      if (said) { const delta = (text ? "\n\n" : "") + said; text += delta; opts.onText?.({ text, delta }); }
      if (r.stop_reason !== "tool_use") break;
      const results = [];
      for (const b of r.content) {
        if (b.type !== "tool_use") continue;
        const t = tools.find(x => x.name === b.name);
        try { const out = t ? await t.execute(b.input || {}, { signal: opts.signal }) : (() => { throw new Error("Unknown tool"); })(); results.push({ type: "tool_result", tool_use_id: b.id, content: typeof out === "string" ? out : JSON.stringify(out ?? null) }); }
        catch (e) { results.push({ type: "tool_result", tool_use_id: b.id, content: "Error: " + (e.message || e), is_error: true }); }
      }
      merged.push({ role: "user", content: results });
    }
    if (!text) throw { code: "empty_completion" };
    return { text, truncated: false, modelTierApplied: opts.modelTier || "default" };
  }


  /* ---------------- payments (Razorpay Checkout) ---------------- */
  let rzpLoad = null;
  const loadCheckout = () => rzpLoad || (rzpLoad = new Promise((res, rej) => {
    if (window.Razorpay) return res();
    const sc = document.createElement("script"); sc.src = "https://checkout.razorpay.com/v1/checkout.js"; sc.async = true;
    sc.onload = () => res(); sc.onerror = () => { rzpLoad = null; rej({ message: "Couldn't load the payment window. Check your connection and try again." }); };
    document.head.appendChild(sc);
  }));
  const payments = {
    /* Opens Razorpay for a booking's advance. Resolves {status} once the server has verified it. */
    pay(bookingId) { return this.payOrder(() => http("POST", "/api/pay/order", { bookingId })); },
    /* Generic checkout: makeOrder() returns the server-priced Razorpay order. */
    async payOrder(makeOrder) {
      const o = await makeOrder();
      await loadCheckout();
      return new Promise((resolve, reject) => {
        const rz = new window.Razorpay({
          key: o.keyId, order_id: o.orderId, amount: o.amount, currency: o.currency,
          name: o.name, description: o.description, prefill: o.prefill,
          theme: { color: "#E39E12" }, timeout: 900, retry: { enabled: true, max_count: 3 },
          modal: { confirm_close: true, ondismiss: () => reject({ cancelled: true, message: "Payment window closed. You have not been charged." }) },
          handler: r => http("POST", "/api/pay/verify", { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }).then(resolve, reject)
        });
        rz.on("payment.failed", e => { /* Checkout lets the customer retry; we only report the reason. */ window.dispatchEvent(new CustomEvent("sst-payfail", { detail: (e && e.error && e.error.description) || "Payment failed" })); });
        rz.open();
      });
    },
    refund: (uid, bookingId, amount) => http("POST", "/api/pay/refund", { uid, bookingId, amount })
  };

  /* ---------------- places, routes, weather (server-proxied) ---------------- */
  const qs = o => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
  const geo = {
    search: q => http("GET", "/api/geo/search?" + qs({ q })),
    reverse: (lat, lon) => http("GET", "/api/geo/reverse?" + qs({ lat, lon })),
    ipLocate: () => http("GET", "/api/geo/ip"),
    route: (from, to) => http("GET", "/api/geo/route?" + qs({ from, to })),
    weather: (place, start, days) => http("GET", "/api/weather?" + qs({ place, start, days })),
    weatherAt: (lat, lon, name, start, days) => http("GET", "/api/weather?" + qs({ lat, lon, name, start, days }))
  };

  /* ---------------- flights & hotels ---------------- */
  const travel = {
    places: q => http("GET", "/api/travel/places?q=" + encodeURIComponent(q || "")),
    searchFlights: b => http("POST", "/api/travel/flights/search", b),
    searchHotels: b => http("POST", "/api/travel/hotels/search", b),
    hold: b => http("POST", "/api/travel/hold", b),
    pay: bookingId => payments.payOrder(() => http("POST", "/api/travel/pay", { bookingId })),
    cancelQuote: bookingId => http("POST", "/api/travel/cancel/quote", { bookingId }),
    cancelConfirm: bookingId => http("POST", "/api/travel/cancel/confirm", { bookingId }),
    attention: () => http("GET", "/api/travel/attention"),
    retryRefund: (uid, bookingId) => http("POST", "/api/travel/refund-retry", { uid, bookingId }),
    invoiceUrl: (uid, id) => "/api/travel/invoice/" + encodeURIComponent(uid) + "/" + encodeURIComponent(id)
  };

  /* ---------------- auth (self-hosted only) ---------------- */
  /* Two-step verification: after the password, ask for the 6-digit code (or a backup code) in a small dialog. */
  function mfaPrompt(ticket, recoveryLeft) {
    return new Promise((resolve, reject) => {
      const ov = document.createElement("div"); ov.className = "mfa-ov"; ov.setAttribute("role", "dialog"); ov.setAttribute("aria-modal", "true"); ov.setAttribute("aria-labelledby", "mfaTitle");
      ov.innerHTML = '<form class="panel mfa-box" novalidate><div class="mfa-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M10 18h4"/><path d="M9.5 9.5l2 2 3.5-3.5"/></svg></div><h3 id="mfaTitle">Two-step verification</h3><p class="small muted">Open your authenticator app and enter the 6-digit code for this site.</p><label class="f"><span>Code</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="11" placeholder="123 456" required></label><p class="ferr" hidden></p><button class="btn primary" type="submit">Verify &amp; sign in</button><button class="linkbtn" type="button" data-rc>Use a backup code instead</button><button class="btn ghost sm" type="button" data-cancel>Cancel</button></form>';
      document.body.appendChild(ov);
      const f = ov.querySelector("form"), inp = f.querySelector("input"), err = f.querySelector(".ferr");
      setTimeout(() => inp.focus(), 50);
      const close = () => ov.remove();
      f.querySelector("[data-cancel]").onclick = () => { close(); reject({ message: "Sign-in cancelled.", cancelled: true }); };
      f.querySelector("[data-rc]").onclick = () => { inp.removeAttribute("inputmode"); inp.placeholder = "abcd-efgh"; inp.parentElement.querySelector("span").textContent = "Backup code" + (recoveryLeft != null ? " (" + recoveryLeft + " left)" : ""); inp.focus(); };
      f.onsubmit = async e => {
        e.preventDefault(); e.stopImmediatePropagation();
        const btn = f.querySelector("button[type=submit]"); btn.disabled = true; err.hidden = true;
        try { const r = await http("POST", "/api/auth/mfa", { ticket, code: inp.value.trim() }); close(); resolve(r); }
        catch (x) { err.textContent = x.message || "That code didn't work."; err.hidden = false; btn.disabled = false; inp.select(); if (/expired|again/i.test(x.message || "") && /password/i.test(x.message || "")) { setTimeout(() => { close(); reject(x); }, 1500); } }
      };
    });
  }
  const auth = {
    signup: async d => { await http("POST", "/api/auth/signup", d); location.reload(); },
    login: async (login, password) => {
      const r = await http("POST", "/api/auth/login", { login, password });
      if (r && r.mfa) { const v = await mfaPrompt(r.ticket, r.recoveryLeft); if (v && v.usedRecovery) try { sessionStorage.setItem("sst.rcLeft", String(v.recoveryLeft)); } catch { /* optional */ } }
      location.reload();
    },
    logout: async () => { await http("POST", "/api/auth/logout", {}); location.reload(); },
    changePassword: (current, next) => http("POST", "/api/auth/password", { current, next }),
    resetFor: (userId, reset2fa) => http("POST", "/api/auth/reset", { userId, reset2fa: !!reset2fa }),
    security: () => http("GET", "/api/auth/security"),
    passwordCheck: (password, who) => http("POST", "/api/auth/password-check", { password, ...(who || {}) }),
    revokeOthers: () => http("POST", "/api/auth/sessions/revoke-others", {}),
    twofa: {
      setup: password => http("POST", "/api/auth/2fa/setup", { password }),
      enable: code => http("POST", "/api/auth/2fa/enable", { code }),
      disable: (password, code) => http("POST", "/api/auth/2fa/disable", { password, code }),
      recovery: password => http("POST", "/api/auth/2fa/recovery", { password })
    }
  };

  window.claude = {
    selfHosted: true,
    auth,
    payments: null,
    async use(name) {
      const s = await sessionP;
      if (name === "db") return db;
      if (name === "user") return userApi;
      if (name === "assets") return s.user ? assets : null;
      if (name === "sample") return s.agent ? sample : null;
      if (name === "payments") return s.payments ? payments : null;
      return null;
    }
  };
})();
