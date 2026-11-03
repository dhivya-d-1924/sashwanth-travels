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

function createGeminiClient({ apiKey, fetchImpl = fetch, timeoutMs = 60000 }) {
  /* Gemini 3 models return a "thought signature" with each function call that must be sent back on the next turn.
     The page doesn't keep it, so it is remembered here by the call id for an hour. */
  const sigs = new Map();
  const remember = (id, sig) => { if (!sig) return; sigs.set(id, { sig, at: Date.now() }); if (sigs.size > 5000) { const cut = Date.now() - 36e5; for (const [k, v] of sigs) if (v.at < cut) sigs.delete(k); } };

  function toContents(messages) {
    const names = {};
    for (const m of messages) if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b && b.type === "tool_use") names[b.id] = b.name;
    const contents = [];
    for (const m of messages) {
      const role = m.role === "assistant" ? "model" : "user", parts = [];
      if (typeof m.content === "string") parts.push({ text: m.content || " " });
      else for (const b of m.content || []) {
        if (!b) continue;
        if (b.type === "text" && b.text) parts.push({ text: b.text });
        else if (b.type === "tool_use") { const s = sigs.get(b.id); parts.push({ functionCall: { name: b.name, args: b.input || {} }, thoughtSignature: s ? s.sig : "skip_thought_signature_validator" }); }
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

  return {
    provider: "gemini",
    messages: {
      async create({ model, max_tokens, system, messages, tools }) {
        const body = { contents: toContents(messages), generationConfig: { maxOutputTokens: Math.max(256, Math.min(Number(max_tokens) || 2048, 8192)) } };
        if (system) body.systemInstruction = { parts: [{ text: String(system) }] };
        if (tools && tools.length) body.tools = [{ functionDeclarations: tools.map(t => ({ name: t.name, description: String(t.description || "").slice(0, 1024), parameters: cleanSchema(t.input_schema) })) }];
        const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs);
        let r, j;
        try {
          r = await fetchImpl(API + encodeURIComponent(model) + ":generateContent", { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey }, body: JSON.stringify(body), signal: ctl.signal });
          j = await r.json().catch(() => ({}));
        } finally { clearTimeout(timer); }
        if (!r.ok) { const e = new Error((j.error && j.error.message) || "Gemini HTTP " + r.status); e.status = r.status; throw e; }
        const cand = (j.candidates || [])[0] || {}, parts = (cand.content && cand.content.parts) || [], content = [];
        for (const p of parts) {
          if (p.thought) continue;
          if (p.functionCall) { const id = "toolu_g" + crypto.randomBytes(9).toString("base64url"); remember(id, p.thoughtSignature); content.push({ type: "tool_use", id, name: p.functionCall.name, input: p.functionCall.args || {} }); }
          else if (typeof p.text === "string" && p.text.trim()) content.push({ type: "text", text: p.text });
        }
        if (!content.length) content.push({ type: "text", text: cand.finishReason === "SAFETY" ? "Sorry, I can't help with that. Ask me about trips, vehicles or bookings." : "Sorry, I couldn't answer that. Could you rephrase it?" });
        return { content, stop_reason: content.some(b => b.type === "tool_use") ? "tool_use" : cand.finishReason === "MAX_TOKENS" ? "max_tokens" : "end_turn" };
      }
    }
  };
}

module.exports = { createGeminiClient, cleanSchema };
