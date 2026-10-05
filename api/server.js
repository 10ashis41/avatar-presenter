/**
 * Presence API — job broker between the phone front end and the GPU worker.
 *
 *   phone  ──POST /jobs──────────▶  job created (queued for upload)
 *   phone  ──PUT  /jobs/:id/upload▶  take stored
 *   phone  ──POST /jobs/:id/start ▶  job queued for rendering
 *   worker ──GET  /work───────────▶  claims the oldest queued job   (bearer: WORKER_TOKEN)
 *   worker ──PUT  /jobs/:id/result▶  uploads preview.mp4 + final.mp4
 *   phone  ──GET  /jobs/:id───────▶  polls status
 *
 * PAYWALL — the whole point of the split render:
 *   /jobs/:id/preview  always served once rendered (watermarked, half-res)
 *   /jobs/:id/final    404s until job.paid === true. The clean file is never
 *                      reachable from the browser before payment; it isn't in
 *                      any static directory and isn't linked anywhere.
 */
import express from "express";
import crypto from "crypto";
import fs from "fs";
// server.js is an ES module (see the import syntax), so child_process must be
// imported rather than require()d — require() is not defined here and throws at
// request time, which 500s every worker poll.
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const PORT = process.env.PORT || 4010;
const PUBLIC_BASE = process.env.PUBLIC_BASE || "https://api.aiguyonthefly.com/presenter";
const WORKER_TOKEN = process.env.WORKER_TOKEN || "";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
// A worker that dies mid-render leaves its job stuck in "rendering" forever,
// because /work only ever hands out "queued" jobs — the customer's render would
// silently strand with no recovery. Any claim that goes this long without a
// progress heartbeat is treated as dead and returned to the queue.
// Generous by default: a long LatentSync render legitimately takes many minutes.
const STALE_CLAIM_MS = Number(process.env.STALE_CLAIM_MS || 30 * 60 * 1000);

fs.mkdirSync(DATA, { recursive: true });
const jobDir = (id) => path.join(DATA, id);
const metaPath = (id) => path.join(jobDir(id), "job.json");

function readJob(id) {
  if (!/^[a-f0-9]{16}$/.test(id || "")) return null;          // reject path tricks
  try { return JSON.parse(fs.readFileSync(metaPath(id), "utf8")); } catch { return null; }
}
function writeJob(job) {
  fs.writeFileSync(metaPath(job.id), JSON.stringify(job, null, 2));
  return job;
}

/* ---------- config: pricing + Stripe (all optional) -------------------- */
// PRICE_USD = 0 / unset  -> no payment gate (invite-only manual flow, as before)
// PRICE_USD > 0           -> job must be PAID before the worker may claim it
const PRICE_USD = Number(process.env.PRICE_USD || 0);
const PRICE_CENTS = Math.round(PRICE_USD * 100);
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_CURRENCY = (process.env.STRIPE_CURRENCY || "usd").toLowerCase();
const PRODUCT_NAME = process.env.PRODUCT_NAME || "AI Clone Presenter — avatar video (AI Guy on the Fly)";
const SITE_URL = process.env.SITE_URL || "https://aiguyonthefly.com/aiclone/";
const priceConfigured = () => PRICE_CENTS > 0 && !!STRIPE_SECRET_KEY;

/* ---------- invites: invite-only access ------------------------------- */
const invitesPath = () => path.join(DATA, "invites.json");
function readInvites() {
  try { return JSON.parse(fs.readFileSync(invitesPath(), "utf8")); } catch { return {}; }
}
function writeInvites(inv) {
  const tmp = invitesPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(inv, null, 2));
  fs.renameSync(tmp, invitesPath());
  return inv;
}
function findInvite(code) {
  if (!code || typeof code !== "string") return null;
  const key = code.trim();
  const inv = readInvites();
  // Clients type these by hand and in URLs, so match case-insensitively —
  // exact key first, then a case-folded lookup over the stored codes.
  let rec = inv[key];
  let stored = key;
  if (!rec) {
    const lower = key.toLowerCase();
    const hit = Object.keys(inv).find((k) => k.toLowerCase() === lower);
    if (hit) { rec = inv[hit]; stored = hit; }
  }
  if (!rec || rec.revoked) return null;
  if (typeof rec.maxUses === "number" && rec.maxUses > 0 && (rec.uses || 0) >= rec.maxUses) return null;
  return { code: stored, rec, all: inv };
}

/* ---------- Stripe: hosted Checkout (no SDK needed) ------------------- */
async function createCheckoutSession(job) {
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": STRIPE_CURRENCY,
    "line_items[0][price_data][unit_amount]": String(PRICE_CENTS),
    "line_items[0][price_data][product_data][name]": PRODUCT_NAME,
    "metadata[jobId]": job.id,
    "metadata[inviteCode]": job.inviteCode || "",
    "client_reference_id": job.id,
    "success_url": SITE_URL + "?paid=1&job=" + job.id,
    "cancel_url": SITE_URL + "?cancelled=1&job=" + job.id,
  });
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
               "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || "stripe error");
  return d;
}

// Stripe signature scheme: header "t=<ts>,v1=<hmac>"; signed payload "<ts>.<rawBody>"
function verifyStripeSignature(rawBody, sigHeader) {
  if (!STRIPE_WEBHOOK_SECRET) return false;
  const parts = Object.fromEntries((sigHeader || "").split(",").map((p) => p.split("=")));
  if (!parts.t || !parts.v1) return false;
  const expected = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET)
                         .update(`${parts.t}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const app = express();
app.set("etag", false);              // no conditional 304s on a polled API

/* Job status is polled every few seconds and every response is different.
   Without no-store, browsers revalidate with If-None-Match and a 304 comes
   back with an EMPTY body — fetch() then throws instead of reporting status,
   which killed the render screen mid-poll. Never cache API responses. */
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate");
  res.set("Pragma", "no-cache");
  next();
});

/* ---------- Stripe webhook (RAW body — must precede the JSON parser) -- */
app.post("/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const raw = req.body ? req.body.toString("utf8") : "";
  if (!verifyStripeSignature(raw, req.headers["stripe-signature"])) {
    return res.status(400).json({ error: "bad signature" });
  }
  let evt;
  try { evt = JSON.parse(raw); } catch { return res.status(400).json({ error: "bad json" }); }
  const paidEvent = ["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(evt.type);
  if (paidEvent) {
    const s = (evt.data && evt.data.object) || {};
    const jobId = (s.metadata && s.metadata.jobId) || s.client_reference_id;
    const job = jobId ? readJob(jobId) : null;
    if (job && !job.paid) {
      job.paid = true;
      job.paidAt = new Date().toISOString();
      job.paidVia = "stripe";
      job.paymentRef = s.id || "";
      job.amountCents = typeof s.amount_total === "number" ? s.amount_total : PRICE_CENTS;
      if (["awaiting-payment", "uploaded", "rendering"].includes(job.state)) {
        job.state = "queued"; job.step = 1;
      }
      writeJob(job);
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: "1mb" }));

// The front end is served from Netlify, so it's cross-origin.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", process.env.ALLOW_ORIGIN || "*");
  res.set("Access-Control-Allow-Headers", "content-type,authorization");
  res.set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

const bearer = (req) => (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
const needToken = (tok) => (req, res, next) =>
  tok && bearer(req) === tok ? next() : res.status(401).json({ error: "unauthorized" });

/* ---------- phone: create job (invite-only + consent attestation) ----- */
app.post("/jobs", (req, res) => {
  const { script, contentType, ext, bytes, language, invite, consent, parts, mode } = req.body || {};
  if (!script || script.trim().length < 20) return res.status(400).json({ error: "script too short" });
  if (bytes && bytes > 600 * 1024 * 1024) return res.status(413).json({ error: "file too large" });

  // Two ways to make a talking face. "lipsync" (the default, unchanged) rewrites the
  // mouth on footage the client recorded, so the pixels are genuinely theirs.
  // "generate" takes a single still photo and synthesises the whole frame with
  // EchoMimicV3 — the client needs no camera, but the output is a likeness, not a
  // recording, and the ordering flow must say so.
  const jobMode = mode === "generate" ? "generate" : "lipsync";
  const defaultExt = jobMode === "generate" ? "jpg" : "mp4";

  // Shard count: how many workers may render this job in parallel. 1 (the
  // default) is the original single-worker path. Above 1 the job goes through
  // prepare -> part... -> assemble -> finish. Splitting does not reduce cost,
  // only wall-clock time: see the sharding notes further down.
  const nParts = Math.max(1, Math.min(64, parseInt(parts, 10) || 1));

  // invite-only: no valid invite code, no job
  const found = findInvite(invite);
  if (!found) return res.status(403).json({ error: "invite code required or no longer valid" });

  // consent attestation (the person in the video has authorised this use)
  if (consent !== true) return res.status(400).json({ error: "consent confirmation required" });

  const id = crypto.randomBytes(8).toString("hex");
  fs.mkdirSync(jobDir(id), { recursive: true });
  writeJob({
    id,
    state: "awaiting-upload",
    step: 0,
    script: script.trim(),
    // Script direction/language is detected client-side; the worker re-detects
    // independently, so this is a hint rather than a contract.
    language: ["en", "he", "ar"].includes(language) ? language : null,
    ext: /^[a-z0-9]{2,5}$/i.test(ext || "") ? ext.toLowerCase() : defaultExt,
    contentType: contentType || (jobMode === "generate" ? "image/jpeg" : "video/mp4"),
    mode: jobMode,
    paid: false,
    paidVia: null,
    inviteCode: found.code,
    invitedEmail: found.rec.email || "",
    consentAt: new Date().toISOString(),
    parts: nParts,
    requestIp: (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim(),
    createdAt: new Date().toISOString(),
  });

  // count the use only after the job is really created
  const inv = readInvites();
  if (inv[found.code]) {
    inv[found.code].uses = (inv[found.code].uses || 0) + 1;
    inv[found.code].lastUsedAt = new Date().toISOString();
    writeInvites(inv);
  }

  res.json({ jobId: id, uploadUrl: `${PUBLIC_BASE}/jobs/${id}/upload`,
             priceUsd: PRICE_USD || 0, paymentRequired: priceConfigured() });
});

/* ---------- phone: upload the take ------------------------------------ */
app.put("/jobs/:id/upload", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  if (job.state !== "awaiting-upload") return res.status(409).json({ error: "already uploaded" });

  const dest = path.join(jobDir(job.id), "take." + job.ext);
  const out = fs.createWriteStream(dest);
  req.pipe(out);
  out.on("finish", () => {
    job.state = "uploaded";
    job.takeBytes = fs.statSync(dest).size;
    writeJob(job);
    res.json({ ok: true, bytes: job.takeBytes });
  });
  out.on("error", (e) => res.status(500).json({ error: e.message }));
});

/* ---------- phone: queue for rendering (payment gate lives here) ------ */
app.post("/jobs/:id/start", async (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  if (job.state === "awaiting-upload") return res.status(409).json({ error: "no take uploaded yet" });

  // Payment BEFORE render: with a price configured, the worker may not claim
  // this job until Stripe confirms payment — so no compute is spent on
  // visitors who never pay.
  if (priceConfigured() && !job.paid) {
    try {
      const s = await createCheckoutSession(job);
      job.state = "awaiting-payment";
      job.step = 1;
      job.checkoutSessionId = s.id;
      job.checkoutUrl = s.url;
      job.checkoutCreatedAt = new Date().toISOString();
      writeJob(job);
      return res.json({ ok: true, state: job.state, needsPayment: true,
                        checkoutUrl: s.url, priceUsd: PRICE_USD });
    } catch (e) {
      return res.status(502).json({ error: "could not start checkout: " + e.message });
    }
  }

  if (["uploaded", "awaiting-payment"].includes(job.state)) {
    job.state = "queued"; job.step = 1; writeJob(job);
  }
  res.json({ ok: true, state: job.state, needsPayment: false, priceUsd: PRICE_USD || 0 });
});

/* ---------- phone: (re)get a payment link ----------------------------- */
app.get("/jobs/:id/checkout", async (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  if (job.paid) return res.json({ ok: true, paid: true });
  if (!priceConfigured()) return res.status(409).json({ error: "no price configured" });
  if (job.checkoutUrl && job.state === "awaiting-payment") {
    return res.json({ ok: true, checkoutUrl: job.checkoutUrl, priceUsd: PRICE_USD });
  }
  try {
    const s = await createCheckoutSession(job);
    job.state = job.state === "uploaded" ? "awaiting-payment" : job.state;
    job.checkoutSessionId = s.id; job.checkoutUrl = s.url;
    job.checkoutCreatedAt = new Date().toISOString();
    writeJob(job);
    res.json({ ok: true, checkoutUrl: s.url, priceUsd: PRICE_USD });
  } catch (e) {
    res.status(502).json({ error: "stripe: " + e.message });
  }
});

/* ---------- phone: poll ----------------------------------------------- */
app.get("/jobs/:id", (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  res.json({
    state: job.state, step: job.step, paid: !!job.paid,
    message: job.message || "",
    // Sharding progress, so a parallel render is observable while it runs.
    parts: job.parts || 1,
    partsDone: (job.partState || []).filter((s) => s === "done").length,
    partState: job.partState || null,
    assembled: !!job.assembled,
    // Only ever the PREVIEW url here. The clean file is deliberately not
    // referenced, so nothing in the browser knows a path to it.
    url: job.state === "done" ? `${PUBLIC_BASE}/jobs/${job.id}/preview` : null,
    // "Locked" only means anything when there is a price to pay.
    locked: job.state === "done" && !job.paid && priceConfigured(),
  });
});

/* ---------- sharded workers: narration, parts, assembled file --------- */

// Pinned narration: generated once by whichever worker gets the `prepare` task.
// First writer wins — a second prepare (after a stale-claim timeout) must not
// overwrite the track the parts are already being rendered against.
app.put("/jobs/:id/narration", needToken(WORKER_TOKEN), (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).end();
  const dest = path.join(jobDir(job.id), "narration.wav");
  if (fs.existsSync(dest)) { req.resume(); return res.json({ ok: true, already: true }); }
  const tmp = dest + ".incoming";
  const out = fs.createWriteStream(tmp);
  req.pipe(out);
  out.on("finish", () => {
    try { fs.renameSync(tmp, dest); } catch (e) { return res.status(500).json({ error: e.message }); }
    delete job.narrationClaimedAt;
    writeJob(job);
    res.json({ ok: true });
  });
  out.on("error", (e) => res.status(500).json({ error: e.message }));
});

app.get("/jobs/:id/narration", needToken(WORKER_TOKEN), (req, res) => {
  const p = path.join(jobDir(req.params.id), "narration.wav");
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

// One rendered frame range. Written to a temp name and renamed, so a part that is
// still uploading can never be picked up by the assembler.
app.put("/jobs/:id/part/:i", needToken(WORKER_TOKEN), (req, res) => {
  const job = readJob(req.params.id);
  const i = parseInt(req.params.i, 10);
  if (!job || !job.parts || !(i >= 0 && i < job.parts)) return res.status(404).end();
  const dest = path.join(jobDir(job.id), `part${i}.mp4`);
  const tmp = dest + ".incoming";
  const out = fs.createWriteStream(tmp);
  req.pipe(out);
  out.on("finish", () => {
    try { fs.renameSync(tmp, dest); } catch (e) { return res.status(500).json({ error: e.message }); }
    if (job.partState) job.partState[i] = "done";
    job.partDoneAt = job.partDoneAt || [];
    job.partDoneAt[i] = new Date().toISOString();
    writeJob(job);
    res.json({ ok: true });
  });
  out.on("error", (e) => res.status(500).json({ error: e.message }));
});

// Release a part whose worker died or errored, so another worker can retry it
// rather than the job hanging until the 45-minute stale timeout.
app.post("/jobs/:id/part/:i/fail", needToken(WORKER_TOKEN), (req, res) => {
  const job = readJob(req.params.id);
  const i = parseInt(req.params.i, 10);
  if (!job || !job.parts || !(i >= 0 && i < job.parts)) return res.status(404).end();
  if (job.partState) job.partState[i] = "pending";
  if (job.partClaimedAt) job.partClaimedAt[i] = null;
  job.message = `part ${i} failed: ${String(req.body?.error || "").slice(0, 250)}`;
  writeJob(job);
  res.json({ ok: true });
});

app.post("/jobs/:id/narration/fail", needToken(WORKER_TOKEN), (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).end();
  delete job.narrationClaimedAt;
  job.message = `narration failed: ${String(req.body?.error || "").slice(0, 250)}`;
  writeJob(job);
  res.json({ ok: true });
});

// The concatenated file, for the worker that runs the finishing step (watermark +
// matte). Worker-token only: the public route is the paywalled /final.
app.get("/jobs/:id/assembled", needToken(WORKER_TOKEN), (req, res) => {
  const p = path.join(jobDir(req.params.id), "final.mp4");
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

/* ---------- worker: which code + settings is the pod running? --------- */
// Lets us verify from outside that a pod restart actually picked up a new
// worker revision or changed env, instead of inferring it from render duration.
app.post("/worker/hello", needToken(WORKER_TOKEN), (req, res) => {
  const info = {
    at: new Date().toISOString(),
    ip: (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim(),
    ...(req.body || {}),
  };
  try {
    fs.writeFileSync(path.join(DATA, "worker.json"), JSON.stringify(info, null, 2));
  } catch (e) { /* best effort */ }
  res.json({ ok: true });
});

/* ---------- worker liveness ----------
   The startup beacon is NOT a liveness signal: a healthy worker can run for
   hours without re-beaconing, so its age says nothing about whether the pod is
   up. Every poll does, so track those separately in their own file. */
function touchPoll(req) {
  try {
    fs.writeFileSync(path.join(DATA, "worker-poll.json"), JSON.stringify({
      at: new Date().toISOString(),
      ip: (req.headers["x-forwarded-for"] || req.ip || "").toString().split(",")[0].trim(),
    }));
  } catch (e) { /* best effort */ }
}

app.get("/admin/worker", needToken(ADMIN_TOKEN), (_, res) => {
  let poll = null;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DATA, "worker-poll.json"), "utf8"));
    const pAge = Math.round((Date.now() - Date.parse(p.at)) / 1000);
    poll = { ...p, secondsAgo: pAge, stale: pAge > 120 };
  } catch { /* no polls seen since last restart */ }
  try {
    const w = JSON.parse(fs.readFileSync(path.join(DATA, "worker.json"), "utf8"));
    const age = Math.round((Date.now() - Date.parse(w.at)) / 1000);
    res.json({ ...w, secondsAgo: age, stale: age > 300, poll });
  } catch {
    res.json({ error: "no worker has checked in since the API last restarted", poll });
  }
});

/* ---------- sharding: render one job across several workers -------------
 *
 * Why this is possible at all: LatentSync processes the video in independent
 * 16-frame chunks — no state passes between them — and its noise tensor is
 * generated once and repeated identically for every frame. So a worker given
 * frames [start, end) produces the same pixels it would have produced as part of
 * a whole-video render, as long as `start` lands on a 16-frame boundary.
 *
 * Splitting does NOT reduce GPU work or cost. It only converts a serial render
 * into a parallel one: ~64 GPU-minutes per minute of video either way, so an
 * 8-way split turns a 10.7-hour job into ~80 minutes for the same money.
 *
 * Flow, driven entirely by what workers ask for:
 *   prepare  one worker runs TTS, uploads the narration (pinned, shared)
 *   part     each worker renders one frame range and uploads it
 *   assemble the API concatenates the parts (stream copy) + the pinned narration
 *   finish   one worker watermarks and mattes the assembled file
 *
 * A job without `parts` keeps the original single-worker path untouched.
 */
const FPS = 25;              // LatentSync works at 25 fps; part maths depend on it
const CHUNK = 16;            // LatentSync's chunk size — part starts must align to it
const PART_STALE_MS = 45 * 60 * 1000;   // a claimed part older than this is re-queued

function framePlan(totalFrames, parts) {
  // Split into `parts` ranges whose starts are multiples of CHUNK, so each part's
  // internal chunking matches what a whole-render would have done.
  const per = Math.ceil(Math.ceil(totalFrames / parts) / CHUNK) * CHUNK;
  const plan = [];
  for (let start = 0, i = 0; start < totalFrames; start += per, i++) {
    plan.push({ i, start, end: Math.min(start + per, totalFrames) });
  }
  return plan;
}

function narrationDuration(job) {
  // ffprobe the pinned narration so the plan can be sized from the real audio.
  const p = path.join(jobDir(job.id), "narration.wav");
  if (!fs.existsSync(p)) return null;
  const out = execFileSync("ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
    { encoding: "utf8" }).trim();
  const d = parseFloat(out);
  return Number.isFinite(d) ? d : null;
}

function assemble(job) {
  // Concatenate the part videos (video only) and mux the pinned narration, so the
  // finished audio is one continuous track rather than a sequence of clips.
  const list = path.join(jobDir(job.id), "parts.txt");
  const lines = job.partPlan.map((p) => `file '${path.join(jobDir(job.id), `part${p.i}.mp4`)}'`);
  fs.writeFileSync(list, lines.join("\n") + "\n");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", list,
    "-i", path.join(jobDir(job.id), "narration.wav"),
    "-map", "0:v:0", "-map", "1:a:0", "-shortest",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
    path.join(jobDir(job.id), "final.mp4")], { stdio: "inherit" });
  fs.unlinkSync(list);
  job.assembled = true;
  job.assembledAt = new Date().toISOString();
  writeJob(job);
}

function shardedTask() {
  const ids = fs.readdirSync(DATA).filter((d) => /^[a-f0-9]{16}$/.test(d));
  const sharded = ids.map(readJob)
    .filter((j) => j && j.parts > 1 && (j.paid || !priceConfigured())
                   // only once the job has actually been started (state `queued`);
                   // otherwise we would begin a prepare before the client pressed go
                   && ["queued", "rendering", "assembling"].includes(j.state))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!sharded.length) return null;

  for (const job of sharded) {
    // 1. narration first — every part needs the same voice track
    if (!fs.existsSync(path.join(jobDir(job.id), "narration.wav"))) {
      if (job.narrationClaimedAt &&
          Date.now() - Date.parse(job.narrationClaimedAt) < PART_STALE_MS) continue;
      job.narrationClaimedAt = new Date().toISOString();
      job.state = "rendering"; job.step = 2;
      writeJob(job);
      return { task: "prepare", id: job.id, script: job.script, ext: job.ext,
               language: job.language, takeUrl: `${PUBLIC_BASE}/jobs/${job.id}/take` };
    }

    // size the plan from the real narration the first time we see it
    if (!job.partPlan || !job.partPlan.length) {
      const dur = narrationDuration(job);
      if (!dur) { job.message = "narration unreadable; re-running prepare"; delete job.narrationClaimedAt; writeJob(job); continue; }
      job.totalFrames = Math.round(dur * FPS);
      job.partPlan = framePlan(job.totalFrames, job.parts);
      job.partState = job.partPlan.map(() => "pending");
      job.partClaimedAt = job.partPlan.map(() => null);
      writeJob(job);
    }

    // 2. hand out parts (work-stealing: whoever asks first gets the next one)
    for (let i = 0; i < job.partPlan.length; i++) {
      const st = job.partState[i];
      const claimedAt = job.partClaimedAt[i];
      const stale = st === "claimed" && claimedAt &&
                    Date.now() - Date.parse(claimedAt) > PART_STALE_MS;
      if (st === "pending" || stale) {
        job.partState[i] = "claimed";
        job.partClaimedAt[i] = new Date().toISOString();
        job.state = "rendering"; job.step = 3; writeJob(job);
        const p = job.partPlan[i];
        return { task: "part", id: job.id, part: i, startFrame: p.start, endFrame: p.end,
                 fps: FPS, parts: job.partPlan.length, totalFrames: job.totalFrames,
                 takeUrl: `${PUBLIC_BASE}/jobs/${job.id}/take`,
                 narrationUrl: `${PUBLIC_BASE}/jobs/${job.id}/narration` };
      }
    }

    // 3. everything in? concatenate once, then hand off the finishing step
    const allDone = job.partState.every((s) => s === "done");
    if (allDone && !job.assembled) {
      try { assemble(job); }
      catch (e) { job.message = `assemble failed: ${e.message}`; writeJob(job); return null; }
    }
    if (job.assembled && !job.finishing && !job.finished) {
      job.finishing = new Date().toISOString();
      job.step = 4; writeJob(job);
      return { task: "finish", id: job.id, parts: job.partPlan.length,
               assembledUrl: `${PUBLIC_BASE}/jobs/${job.id}/assembled` };
    }
    // a finish that never reported back: let it be claimed again
    if (job.assembled && job.finishing && !job.finished &&
        Date.now() - Date.parse(job.finishing) > PART_STALE_MS) {
      job.finishing = new Date().toISOString(); writeJob(job);
      return { task: "finish", id: job.id, parts: job.partPlan.length,
               assembledUrl: `${PUBLIC_BASE}/jobs/${job.id}/assembled` };
    }
  }
  return null;
}

/* ---------- worker: claim work (paid jobs only when priced) ----------- */
function reclaimStale(jobs) {
  const now = Date.now();
  const revived = [];
  for (const job of jobs) {
    if (!job || job.state !== "rendering") continue;
    // Sharded jobs are progressed by per-part claims, not by progressAt, so the
    // stale-claim sweep must not touch them — resetting one to `queued` would let
    // the single-worker path pick it up and render the whole thing again.
    if (job.parts > 1) continue;
    const last = Date.parse(job.progressAt || job.claimedAt || 0);
    if (!last || now - last < STALE_CLAIM_MS) continue;
    job.state = "queued";
    job.step = 1;
    job.reclaimedAt = new Date().toISOString();
    job.reclaims = (job.reclaims || 0) + 1;
    job.message = "";
    delete job.claimedAt;
    delete job.progressAt;
    writeJob(job);
    console.warn(`reclaimed stale job ${job.id} (stuck rendering, attempt ${job.reclaims})`);
    revived.push(job);
  }
  return revived;
}

app.get("/work", needToken(WORKER_TOKEN), (req, res) => {
  touchPoll(req);
  // Task payloads (prepare/part/finish) are only comprehensible to a worker that
  // knows about them. An older worker would take a `part` task for a normal job
  // and die on the missing `script` field — observed for real: "FAILED:
  // KeyError('script')". So the sharded queue is only served to workers that
  // announce themselves; anyone else sees the original single-job protocol.
  const proto = parseInt(req.query.v, 10) || 1;
  if (proto >= 2) {
    const sharded = shardedTask();
    if (sharded) return res.json(sharded);
  }
  const ids = fs.readdirSync(DATA).filter((d) => /^[a-f0-9]{16}$/.test(d));
  reclaimStale(ids.map(readJob));
  const queued = ids.map(readJob)
                    .filter((j) => j && j.state === "queued" && (j.paid || !priceConfigured())
                                   // sharded jobs are served by shardedTask() above
                                   && !(j.parts > 1)
                                   // A generate job is a photo, not footage: a v1/v2 worker
                                   // would hand it to the lip-sync path and fail on it.
                                   // Withhold it until a worker announces v>=3.
                                   && (proto >= 3 || (j.mode || "lipsync") !== "generate"))
                    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const job = queued[0];
  if (!job) return res.status(204).end();
  job.state = "rendering"; job.step = 2; job.claimedAt = new Date().toISOString();
  writeJob(job);
  res.json({ id: job.id, script: job.script, ext: job.ext, language: job.language,
             // Which pipeline this job wants. An old worker ignores the field and would
             // try to lip-sync a photo, so a generate job is only served to a worker
             // that asks for protocol v>=2 below.
             mode: job.mode || "lipsync",
             takeUrl: `${PUBLIC_BASE}/jobs/${job.id}/take` });
});

/* The client's voice, pinned once from a real recording they sent. The generate path
   has no take to clone a voice from — there is no footage at all — so it reads this
   instead, and the clone speaks the script in the client's own voice. */
app.get("/worker/voice_ref", needToken(WORKER_TOKEN), (req, res) => {
  const p = path.join(DATA, "voice_ref.wav");
  if (!fs.existsSync(p)) return res.status(404).json({ error: "no voice reference pinned" });
  res.sendFile(p);
});

app.get("/jobs/:id/take", needToken(WORKER_TOKEN), (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).end();
  res.sendFile(path.join(jobDir(job.id), "take." + job.ext));
});

app.post("/jobs/:id/progress", needToken(WORKER_TOKEN), (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).end();
  if (typeof req.body.step === "number") job.step = req.body.step;
  // Heartbeat: proves the worker is alive so the stale sweep leaves it be.
  job.progressAt = new Date().toISOString();
  writeJob(job);
  res.json({ ok: true });
});

/* Result kinds and their container. `alpha` is the matted clone as VP9-with-alpha
   in WebM: small and playable in any browser, which is what Eric asked for.
   (ProRes 4444 is available by setting MATTE_FORMAT=prores on the pod, but it is
   roughly 10x the size.) */
const RESULT_EXT = { preview: "mp4", final: "mp4", alpha: "webm" };

app.put("/jobs/:id/result/:kind", needToken(WORKER_TOKEN), (req, res) => {
  const job = readJob(req.params.id);
  const kind = req.params.kind;
  if (!job || !RESULT_EXT[kind]) return res.status(404).end();
  const out = fs.createWriteStream(path.join(jobDir(job.id), kind + "." + RESULT_EXT[kind]));
  req.pipe(out);
  out.on("finish", () => res.json({ ok: true }));
  out.on("error", (e) => res.status(500).json({ error: e.message }));
});

app.post("/jobs/:id/done", needToken(WORKER_TOKEN), (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).end();
  const failed = !!req.body.error;
  job.state = failed ? "error" : "done";
  job.step = failed ? job.step : 5;
  if (failed) job.message = String(req.body.error).slice(0, 300);
  writeJob(job);
  res.json({ ok: true });
});

/* ---------- delivery: preview is free, final is paywalled ------------- */
app.get("/jobs/:id/preview", (req, res) => {
  const job = readJob(req.params.id);
  if (!job || job.state !== "done") return res.status(404).send("Not ready");
  res.sendFile(path.join(jobDir(job.id), "preview.mp4"));
});

app.get("/jobs/:id/final", (req, res) => {
  const job = readJob(req.params.id);
  if (!job || job.state !== "done") return res.status(404).send("Not ready");
  // Only gate when a price is actually configured. With PRICE_USD unset the
  // documented contract is "no payment gate" — gating anyway made a finished
  // render unreachable through the UI (402 on /final, and the "Unlock" button
  // 409s because there is no checkout to create). That is the dead-end that
  // stranded a completed test render.
  if (priceConfigured() && !job.paid) {
    // 402 is the correct signal, and it leaks nothing about the file.
    return res.status(402).json({ error: "payment required" });
  }
  res.download(path.join(jobDir(job.id), "final.mp4"), "presentation.mp4");
});

/* The matted clone (VP9 + alpha in WebM). Same payment gate as the clean file:
   it is a deliverable, not a preview. */
app.get("/jobs/:id/alpha", (req, res) => {
  const job = readJob(req.params.id);
  if (!job || job.state !== "done") return res.status(404).send("Not ready");
  const p = path.join(jobDir(job.id), "alpha.webm");
  if (!fs.existsSync(p)) return res.status(404).send("No alpha for this job");
  if (priceConfigured() && !job.paid) {
    return res.status(402).json({ error: "payment required" });
  }
  res.setHeader("Content-Type", "video/webm");
  res.download(p, "presenter-alpha.webm");
});

/* ---------- admin: unlock after payment ------------------------------- */
app.post("/admin/jobs/:id/pay", needToken(ADMIN_TOKEN), (req, res) => {
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: "no such job" });
  job.paid = true;
  job.paidAt = new Date().toISOString();
  job.paidVia = "admin";
  if (typeof req.body?.amountCents === "number") job.amountCents = req.body.amountCents;
  // A paid job must be claimable regardless of which state it stalled in —
  // e.g. checkout failed and left it at "uploaded".
  if (["awaiting-payment", "uploaded", "rendering"].includes(job.state)) {
    job.state = "queued"; job.step = 1;
  }
  writeJob(job);
  res.json({ ok: true, id: job.id, paid: true, state: job.state });
});

/* ---------- admin: invites -------------------------------------------- */
app.post("/admin/invites", needToken(ADMIN_TOKEN), (req, res) => {
  const { email = "", label = "", maxUses = 0, code } = req.body || {};
  const c = (code && /^[A-Za-z0-9_-]{4,40}$/.test(code)) ? code : crypto.randomBytes(6).toString("hex");
  const inv = readInvites();
  // Codes match case-insensitively, so refuse a near-duplicate rather than
  // ending up with both AIGUYCLONE and aiguyclone in the store.
  const clash = Object.keys(inv).find((k) => k.toLowerCase() === c.toLowerCase());
  if (clash && clash !== c) return res.status(409).json({ error: "invite already exists", code: clash });
  inv[c] = { email: String(email).slice(0, 200), label: String(label).slice(0, 100),
             maxUses: Number(maxUses) || 0, uses: 0, revoked: false,
             createdAt: new Date().toISOString() };
  writeInvites(inv);
  res.json({ ok: true, code: c, invite: inv[c] });
});

app.get("/admin/invites", needToken(ADMIN_TOKEN), (_, res) => res.json(readInvites()));

app.post("/admin/invites/:code/revoke", needToken(ADMIN_TOKEN), (req, res) => {
  const inv = readInvites();
  if (!inv[req.params.code]) return res.status(404).json({ error: "no such invite" });
  inv[req.params.code].revoked = true;
  writeInvites(inv);
  res.json({ ok: true, code: req.params.code, revoked: true });
});

app.get("/admin/jobs", needToken(ADMIN_TOKEN), (req, res) => {
  const ids = fs.readdirSync(DATA).filter((d) => /^[a-f0-9]{16}$/.test(d));
  res.json(ids.map(readJob).filter(Boolean).map((j) => ({
    id: j.id, state: j.state, paid: j.paid, createdAt: j.createdAt,
    claimedAt: j.claimedAt || null, reclaims: j.reclaims || 0,
    chars: (j.script || "").length,
  })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.get("/health", (_, res) => res.json({ ok: true, service: "presence-api" }));

app.listen(PORT, "127.0.0.1", () => console.log(`presence-api on 127.0.0.1:${PORT}`));
