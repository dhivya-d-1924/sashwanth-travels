"use strict";
/*
 * Google Gemini as an alternative brain for the Saarathi agent.
 * The page speaks the Claude Messages format (text, tool_use, tool_result blocks); this adapter turns that into a
 * Gemini generateContent call with function calling and turns the answer back, so nothing else changes.
 * Enable with AI_PROVIDER=gemini and GEMINI_API_KEY (from aistudio.google.com).
 */
const API = "https://generativelanguage.googleapis.com/v1beta/models/";
const crypto = require("crypto");

/* Gemini accepts an OpenAPI-style subset of JSON Schema: keep only the parts it understands. */
function cleanSchema(s) {
  if (!s || typeof s !== "object") return { type: "OBJECT", properties: {} };
  const out = {};
  if (s.type) out.type = String(Array.isArray(s.type) ? s.type.find(t => t !== "null") || "string" : s.type).toUpperCase();
  if (s.description) out.description = String(s.description).slice(0, 1000);
  if (Array.isArray(s.enum)) out.enum = s.enum.map(String);
  if (s.format && ["date-time", "enum"].includes(s.format)) out.format = s.format;
  if (s.properties && typeof s.properties === "object") { out.properties = {}; for (const [k, v] of Object.entries(s.properties)) out.properties[k] = cleanSchema(v); }
  if (Array.isArray(s.required) && s.required.length) out.required = s.required.filter(r => out.properties && out.properties[r]);
  if (s.items) out.items = cleanSchema(s.items);
  if (out.type === "OBJECT" && !out.properties) out.properties = {};
  if (out.type === "ARRAY" && !out.items) out.items = { type: "STRING" };
  return out;
}

const textOf = c => typeof c === "string" ? c : Array.isArray(c) ? c.map(b => b && b.type === "text" ? b.text : "").join("\n") : "";

function createGeminiClient({ apiKey, fetchImpl = fetch, timeoutMs = 45000, fallbacks = ["gemini-3.6-flash", "gemini-3.5-flash-lite"], retryDelayMs = 1200, log = console }) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const busy = e => e && (e.status === 503 || e.status === 500 || e.status === 504 || e.status === 429 || e.name === "AbortError" || e.timeout);
  /* Gemini 3 models return a "thought signature" with each function call that must be sent back on the next turn.
     The page doesn't keep it, so it is remembered here by the call id for an hour. */
  const sigs = new Map();
  const remember = (id, sig, model) => { if (!sig) return; sigs.set(id, { sig, model, at: Date.now() }); if (sigs.size > 5000) { const cut = Date.now() - 36e5; for (const [k, v] of sigs) if (v.at < cut) sigs.delete(k); } };

  function toContents(messages, model) {
    const names = {};
    for (const m of messages) if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b && b.type === "tool_use") names[b.id] = b.name;
    const contents = [];
    for (const m of messages) {
      const role = m.role === "assistant" ? "model" : "user", parts = [];
      if (typeof m.content === "string") parts.push({ text: m.content || " " });
      else for (const b of m.content || []) {
        if (!b) continue;
        if (b.type === "text" && b.text) parts.push({ text: b.text });
        else if (b.type === "tool_use") { const s = sigs.get(b.id); parts.push({ functionCall: { name: b.name, args: b.input || {} }, thoughtSignature: s && s.model === model ? s.sig : "skip_thought_signature_validator" }); }
        else if (b.type === "tool_result") {
          const raw = textOf(b.content); let val; try { val = JSON.parse(raw); } catch { val = raw; }
          parts.push({ functionResponse: { name: names[b.tool_use_id] || "tool", response: b.is_error ? { error: raw } : { result: val } } });
        }
      }
      if (!parts.length) continue;
      const last = contents[contents.length - 1];
      if (last && last.role === role) last.parts.push(...parts); else contents.push({ role, parts });
    }
    return contents;
  }

  const client = {
    provider: "gemini",
    messages: {
      /* Busy (503), overloaded or slow: retry once, then try the fallback models, so customers rarely see an error. */
      async create(req) {
        const order = [req.model, req.model, ...fallbacks.filter(m => m && m !== req.model)];
        let last;
        for (let i = 0; i < order.length; i++) {
          try { return await once({ ...req, model: order[i] }); }
          catch (e) {
            last = e; if (!busy(e)) throw e;
            log.warn && log.warn(`[llm] ${order[i]} busy (${e.status || e.name || "timeout"}), ${i + 1 < order.length ? "trying " + order[i + 1] : "giving up"}`);
            if (i + 1 < order.length) await sleep(i === 0 ? retryDelayMs : 200);
          }
        }
        throw last;
      }
    }
  };
  async function once({ model, max_tokens, system, messages, tools }) {
        const body = { contents: toContents(messages, model), generationConfig: { maxOutputTokens: Math.max(256, Math.min(Number(max_tokens) || 2048, 8192)) } };
        if (system) body.systemInstruction = { parts: [{ text: String(system) }] };
        if (tools && tools.length) body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: String(t.description || "").slice(0, 1024), parameters: cleanSchema(t.input_schema) })) }];
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
        let r, j;
        try {
          r = await fetchImpl(API + encodeURIComponent(model) + ":generateContent", { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify(body), signal: ctl.signal });
          j = await r.json().catch(() => ({}));
        } catch (e) { if (e.name === "AbortError") { const t = new Error("Gemini took too long to answer"); t.timeout = true; throw t; } throw e; } finally { clearTimeout(timer); }
        if (!r.ok) { const e = new Error((j.error && j.error.message) || "Gemini HTTP " + r.status); e.status = r.status; throw e; }
        const cand = (j.candidates || [])[0] || {}, parts = (cand.content && cand.content.parts) || [], content = [];
        for (const p of parts) {
          if (p.thought) continue;
          if (p.functionCall) { const id = "toolu_g" + crypto.randomBytes(9).toString("base64url"); remember(id, p.thoughtSignature, model); content.push({ type: "tool_use", id, name: p.functionCall.name, input: p.functionCall.args || {} }); }
          else if (typeof p.text === "string" && p.text.trim()) content.push({ type: "text", text: p.text });
        }
        if (!content.length) content.push({ type: "text", text: cand.finishReason === "SAFETY" ? "Sorry, I can't help with that. Ask me about trips, vehicles or bookings." : "Sorry, I couldn't answer that. Could you rephrase it?" });
        return { content, stop_reason: content.some(b => b.type === "tool_use") ? "tool_use" : cand.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn" };
  }
  return client;
}

module.exports = { createGeminiClient, cleanSchema };
