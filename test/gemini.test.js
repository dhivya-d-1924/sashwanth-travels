"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createGeminiClient, cleanSchema } = require("../server/gemini.js");
const { createApp } = require("../server/server.js");

test("Gemini adapter: tools, function calls with thought signatures, tool results, back to Claude format", async () => {
  const calls = [];
  const replies = [
    { candidates: [{ content: { parts: [{ functionCall: { name: "lookup_route", args: { from: "Chennai", to: "Madurai" } }, thoughtSignature: "SIG-1" }] }, finishReason: "STOP" }] },
    { candidates: [{ content: { parts: [{ text: "Chennai to Madurai is 462 km one way." }] }, finishReason: "STOP" }] }
  ];
  const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => replies.shift() }; };
  const g = createGeminiClient({ apiKey: "k", fetchImpl });
  const tools = [{ name: "lookup_route", description: "Route km", input_schema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, type: { type: "string", enum: ["round", "oneway"] } }, required: ["from", "to"], additionalProperties: false } }];
  const msgs = [{ role: "user", content: "How far is Madurai from Chennai?" }];
  const r1 = await g.messages.create({ model: "gemini-3.8-flash", max_tokens: 1024, system: "Travel only", messages: msgs, tools });
  assert.equal(r1.stop_reason, "tool_use");
  const tu = r1.content[0];
  assert.equal(tu.type, "tool_use"); assert.equal(tu.name, "lookup_route"); assert.deepEqual(tu.input, { from: "Chennai", to: "Madurai" });
  /* request shape */
  const b1 = calls[0].body;
  assert.match(calls[0].url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.equal(calls[0].init.headers["x-goog-api-key"], "k");
  assert.equal(b1.systemInstruction.parts[0].text, "Travel only");
  assert.deepEqual(b1.tools[0].functionDeclarations[0].parameters, { type: "OBJECT", properties: { from: { type: "STRING" }, to: { type: "STRING" }, type: { type: "STRING", enum: ["round", "oneway"] } }, required: ["from", "to"] });
  /* second turn: the signature is sent back and the tool result becomes a functionResponse */
  msgs.push({ role: "assistant", content: r1.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ found: true, one_way_km: 462 }) }] });
  const r2 = await g.messages.create({ model: "gemini-3.8-flash", max_tokens: 1024, system: "Travel only", messages: msgs, tools });
  assert.equal(r2.stop_reason, "end_turn"); assert.match(r2.content[0].text, /462 km/);
  const c = calls[1].body.contents;
  assert.deepEqual(c.map(x => x.role), ["user", "model", "user"]);
  assert.equal(c[1].parts[0].thoughtSignature, "SIG-1");
  assert.deepEqual(c[2].parts[0].functionResponse, { name: "lookup_route", response: { result: { found: true, one_way_km: 462 } } });
});

test("Gemini errors: rate limit passes through as 429; empty or blocked answers get a polite reply", async () => {
  const g429 = createGeminiClient({ apiKey: "k", retryDelayMs: 0, log: {}, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "Quota exceeded" } }) }) });
  await assert.rejects(g429.messages.create({ model: "m", messages: [{ role: "user", content: "hi" }] }), e => e.status === 429);
  const gs = createGeminiClient({ apiKey: "k", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] }) }) });
  const r = await gs.messages.create({ model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.match(r.content[0].text, /trips, vehicles or bookings/);
  assert.deepEqual(cleanSchema({ type: ["string", "null"] }), { type: "STRING" });
});

test("server: AI_PROVIDER=gemini runs the agent on Gemini and health says so", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sst-gm-"));
  const fetchImpl = async (url, init) => {
    if (String(url).includes("generativelanguage.googleapis.com")) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "Vanakkam! How can I help with your trip?" }] }, finishReason: "STOP" }] }) };
    throw new Error("unexpected " + url);
  };
  const app = createApp({ dataDir: dir, fetchImpl, aiEnv: { AI_PROVIDER: "gemini", GEMINI_API_KEY: "test" } });
  await app.locals.ready; const server = await new Promise(r => { const s = app.listen(0, () => r(s)); }); const base = "http://127.0.0.1:" + server.address().port;
  try {
    const h = await (await fetch(base + "/api/health")).json();
    assert.equal(h.agent, true); assert.equal(h.ai, "gemini"); assert.equal(h.aiModel, "gemini-3.8-flash");
    const r = await fetch(base + "/api/llm", { method: "POST", headers: { "Content-Type": "application/json", "X-SST": "1" }, body: JSON.stringify({ messages: [{ role: "user", content: "Hi" }] }) });
    const j = await r.json();
    assert.equal(r.status, 200); assert.match(j.content[0].text, /Vanakkam/);
  } finally { app.locals.store.flushNow(); server.closeAllConnections(); await new Promise(r => server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Gemini busy (503) or slow: retries, then falls back to another model and answers", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    const m = /models\/([^:]+):/.exec(url)[1]; seen.push(m);
    if (m === "gemini-3.8-flash") return { ok: false, status: 503, json: async () => ({ error: { message: "This model is currently experiencing high demand." } }) };
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "Hello from " + m }] }, finishReason: "STOP" }] }) };
  };
  const g = createGeminiClient({ apiKey: "k", fetchImpl, retryDelayMs: 0, log: {} });
  const r = await g.messages.create({ model: "gemini-3.8-flash", messages: [{ role: "user", content: "hi" }] });
  assert.deepEqual(seen, ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3.6-flash"]);
  assert.match(r.content[0].text, /Hello from gemini-3.6-flash/);
  /* a bad key is not retried */
  let n = 0; const bad = createGeminiClient({ apiKey: "k", retryDelayMs: 0, log: {}, fetchImpl: async () => { n++; return { ok: false, status: 400, json: async () => ({ error: { message: "API key not valid" } }) }; } });
  await assert.rejects(bad.messages.create({ model: "m", messages: [{ role: "user", content: "hi" }] }), /API key not valid/);
  assert.equal(n, 1);
});
