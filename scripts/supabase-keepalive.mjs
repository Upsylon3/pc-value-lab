// Keeps the free Supabase project from pausing, and wakes it up if it paused anyway.
//
// WHY it works this way:
//  - Supabase pauses free projects after about a week with no API calls. Any API call resets that timer, so a daily
//    request is enough. It uses the public URL + key already in config.js, so no secret is needed for this part.
//  - Any HTTP answer below 500 counts as "alive" (even a 401 or 404 is the project answering, and it still counts as
//    activity). Only silence or a 5xx means "probably paused", because a paused project does not answer normally.
//  - If it does look paused, the Management API can restore it, but that needs a personal access token. It is optional:
//    without SUPABASE_ACCESS_TOKEN the run just fails, and GitHub emails you that it failed.
//  - A paused project can only be restored for 90 days, so a failure here is worth acting on the same week.
//
// Exit code 0 = project is up. Anything else = the run is marked failed on purpose so that GitHub notifies you.

import { readFileSync } from "node:fs";

const CONFIG_FILE = process.env.PVL_CONFIG_FILE || "config.js";
const API_BASE = process.env.SUPABASE_API_BASE || "https://api.supabase.com";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || "";
const POLL_MS = Number(process.env.KEEPALIVE_POLL_MS || 20000);   // how often to check a restore
const MAX_WAIT_MS = Number(process.env.KEEPALIVE_MAX_WAIT_MS || 15 * 60 * 1000);

const log = (m) => console.log(m);
const fail = (m) => { console.error("FAILED: " + m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- read the public settings out of config.js (the same file the site uses)
let cfg;
try { cfg = readFileSync(CONFIG_FILE, "utf8"); } catch { fail(`cannot read ${CONFIG_FILE}`); }
const pick = (name) => (cfg.match(new RegExp(name + "\\s*:\\s*[\"']([^\"']+)[\"']")) || [])[1];
const url = (process.env.SUPABASE_URL || pick("supabaseUrl") || "").replace(/\/+$/, "");
const key = process.env.SUPABASE_KEY || pick("supabaseKey");
if (!url || !key) fail("supabaseUrl / supabaseKey not found in " + CONFIG_FILE);
// the project ref is the first part of the host name: https://<ref>.supabase.co
const ref = process.env.SUPABASE_PROJECT_REF || new URL(url).hostname.split(".")[0];

// ---- 1. the ping
async function ping() {
  try {
    const r = await fetch(`${url}/rest/v1/app_settings?select=key&limit=1`, {
      headers: { apikey: key }, signal: AbortSignal.timeout(20000),
    });
    return r.status;           // 0 below means "no answer at all"
  } catch { return 0; }
}

const alive = (s) => s > 0 && s < 500;
const first = await ping();
if (alive(first)) {
  log(`Project ${ref} answered (HTTP ${first}). Inactivity timer reset.`);
  if (first !== 200) log("Note: it did not answer 200. Not a pause problem, but check that setup.sql has been run.");
  process.exit(0);
}
log(`No normal answer from ${ref} (${first || "no response"}). It may be paused.`);

// ---- 2. it may be paused: try to restore it
if (!TOKEN) {
  fail("the project looks paused and no SUPABASE_ACCESS_TOKEN is set, so it cannot be restored automatically. " +
       "Restore it from the Supabase dashboard (Restore project), or add the token as a repository secret.");
}
const mgmt = async (method, path) => {
  const r = await fetch(API_BASE + path, {
    method, headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: method === "POST" ? "{}" : undefined, signal: AbortSignal.timeout(30000),
  });
  let body = null; try { body = await r.json(); } catch { /* empty body */ }
  return { status: r.status, body };
};

const deadline = Date.now() + MAX_WAIT_MS;
let restoreSent = false;
while (Date.now() < deadline) {
  const s = await mgmt("GET", `/v1/projects/${ref}`);
  if (s.status === 401 || s.status === 403) fail(`the access token was refused (HTTP ${s.status}). Create a new one and update the secret.`);
  if (s.status !== 200) fail(`could not read the project status (HTTP ${s.status}) ${JSON.stringify(s.body)}`);
  const status = s.body && s.body.status;
  log(`Project status: ${status}`);

  if (status === "ACTIVE_HEALTHY") {
    // up according to the platform: the first ping may just have been unlucky. Check again properly.
    const again = await ping();
    if (alive(again)) { log(`Project ${ref} is up (HTTP ${again}).`); process.exit(0); }
    await sleep(POLL_MS); continue;
  }
  if (status === "INACTIVE" && !restoreSent) {
    const r = await mgmt("POST", `/v1/projects/${ref}/restore`);
    if (r.status >= 300) fail(`restore request refused (HTTP ${r.status}) ${JSON.stringify(r.body)}. ` +
                              "If it has been paused for more than 90 days, it can no longer be restored this way.");
    restoreSent = true; log("Restore requested."); await sleep(POLL_MS); continue;
  }
  if (["COMING_UP", "RESTORING", "UPGRADING", "PAUSING", "GOING_DOWN", "INACTIVE", "ACTIVE_UNHEALTHY"].includes(status)) {
    await sleep(POLL_MS); continue;    // in transition (or INACTIVE right after we asked): just wait
  }
  fail(`unexpected project status "${status}". Look at the project in the Supabase dashboard.`);
}
fail("the project did not come back within " + Math.round(MAX_WAIT_MS / 60000) + " minutes. Check the dashboard.");
