#!/usr/bin/env node
// parly-upload FILE: uploads a file to the hub as this agent and prints its id, to attach with "files" on reply or
// send_message. (The three upload steps in one, so the model passes an id instead of the bytes.)
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: parly-upload FILE");
  process.exit(2);
}
// ZeroClaw's shell doesn't pass the secret env on: read the 0400 agent-token file or ZeroClaw config under /run.
// Only this agent's id (PARLY_AGENT_ID) — never the first token under /run/parly/agents/*.
let hub = process.env.PARLY_HUB_URL;
let token = process.env.PARLY_AGENT_TOKEN;
const agentId = process.env.PARLY_AGENT_ID;
if (!agentId && !token) {
  console.error("parly-upload: set PARLY_AGENT_ID (or PARLY_AGENT_TOKEN) for this agent");
  process.exit(1);
}
if (!token && agentId) {
  const tokenFile = path.join("/run/parly/agents", agentId, "agent-token");
  if (fs.existsSync(tokenFile)) token = fs.readFileSync(tokenFile, "utf8").trim();
}
if ((!hub || !token) && agentId) {
  const conf = path.join("/run/parly/agents", agentId, "zeroclaw", "config.toml");
  if (fs.existsSync(conf)) {
    const toml = fs.readFileSync(conf, "utf8");
    hub ||= toml.match(/url = "(https?:\/\/[^"]+)\/mcp"/)?.[1];
    token ||= toml.match(/Authorization = "Bearer ([^"]+)"/)?.[1];
  }
}
if (!hub || !token) {
  console.error("parly-upload: no hub address or token for this agent");
  process.exit(1);
}

async function call(name, args) {
  const res = await fetch(`${hub}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = await res.json();
  const text = body.result?.content?.[0]?.text ?? "";
  if (!res.ok || body.error || body.result?.isError) throw new Error(`${name}: ${text || JSON.stringify(body.error)}`);
  return JSON.parse(text);
}

const bytes = fs.readFileSync(file);
const ext = path.extname(file).toLowerCase();
const mediaType = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".pdf": "application/pdf", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json" }[ext] ?? "application/octet-stream";
const md5 = createHash("md5").update(bytes).digest("base64");
const { file: made, upload } = await call("create_upload", { name: path.basename(file), mediaType, size: bytes.length, md5 });
const put = await fetch(upload.url, { method: "PUT", headers: upload.headers, body: bytes });
if (!put.ok) throw new Error(`upload: HTTP ${put.status}`);
await call("complete_upload", { fileId: made.id });
console.log(made.id);
