// Weekly PassMark sync for PC Value Lab.
//
// Makes exactly ONE request to each PassMark page, then rebuilds builtin-parts.js
// from them. If ANYTHING looks wrong, it stops and leaves builtin-parts.js untouched.
//
// No dependencies: needs only Node 18+ (GitHub Actions provides it).

import { readFile, writeFile, appendFile } from "node:fs/promises";
import vm from "node:vm";

const OUT_FILE = "builtin-parts.js";
const FORCE = process.env.FORCE === "true"; // set by the manual "force" checkbox

const SOURCES = {
  cpus: {
    label: "CPU",
    url: "https://www.cpubenchmark.net/cpu-list/all",
    linkMarker: "cpu_lookup.php",
    minCount: 3000, // real list has 5,000+
    testFileEnv: "CPU_HTML_FILE", // only used for offline testing
  },
  gpus: {
    label: "GPU",
    url: "https://www.videocardbenchmark.net/gpu_list.php",
    linkMarker: "video_lookup.php",
    minCount: 1500, // real list has ~2,800
    testFileEnv: "GPU_HTML_FILE",
  },
};

// PassMark's GPU list contains virtual/driver "cards" (remote-desktop drivers,
// cloud vGPU slices) with absurd scores. They are skipped and listed in the report.
// Set this to [] if you want PassMark's list exactly as-is.
const GPU_EXCLUDE = [
  /Display Device$/i,
  /IddDriver/i,
  /Indirect Display/i,
  /Mirror Driver/i,
  /^BASICDISPLAY$/i,
  /^Device$/i,
  /^Microsoft (Basic|Remote)/i,
  /-\d+[QABC]$/i, // vGPU slices like "A40-48Q"
];

// Safety limits
const MAX_SHRINK = 0.9; // new list may not be more than 10% smaller than the old one
const BIG_CHANGE = 0.5; // a score moving by more than 50% counts as a "big change"
const MAX_BIG_SHARE = 0.25; // if more than 25% of shared parts had big changes, the parse is suspect

class SafeStop extends Error {}

// ---------------------------------------------------------------- fetching

async function getPage(src) {
  const testFile = process.env[src.testFileEnv];
  if (testFile) return readFile(testFile, "utf8");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(src.url, {
      headers: {
        "User-Agent": "pc-value-lab weekly sync (https://github.com/upsylon3/pc-value-lab)",
        Accept: "text/html",
      },
      redirect: "follow",
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new SafeStop(`${src.label} page answered HTTP ${res.status} (${src.url}).`);
    }
    return await res.text();
  } catch (err) {
    if (err instanceof SafeStop) throw err;
    throw new SafeStop(`Could not download the ${src.label} page: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------- parsing

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, e) => {
    e = e.toLowerCase();
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    if (e === "nbsp") return " ";
    try {
      const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    } catch {
      return whole;
    }
  });
}

const cleanText = (html) =>
  decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

// Reads every table row whose first cell links to a part page, and returns
// [name, score] pairs. The score is the first purely numeric cell after the name
// (CPU Mark / G3D Mark is always the first number column on both pages).
function parseParts(html, src) {
  const parts = [];
  const rows = html.split(/<tr\b/i).slice(1);
  for (const row of rows) {
    const cells = [
      ...row.matchAll(/<td\b[^>]*>([\s\S]*?)(?=<\/td>|<td\b|<\/tr>|$)/gi),
    ].map((m) => m[1]);
    if (cells.length < 2) continue;
    if (!cells[0].includes(src.linkMarker)) continue;

    const name = cleanText(cells[0]);
    const scoreText = cells.slice(1).map(cleanText).find((c) => /^\d[\d,]*$/.test(c));
    if (!name || scoreText === undefined) continue;

    const score = Number(scoreText.replace(/,/g, ""));
    if (!Number.isFinite(score) || score < 0) continue;
    parts.push([name, score]);
  }
  return parts;
}

function buildList(html, src, exclude) {
  const raw = parseParts(html, src);
  const seen = new Map();
  const skipped = [];
  let duplicates = 0;
  for (const [name, score] of raw) {
    if (exclude.some((re) => re.test(name))) {
      skipped.push(name);
      continue;
    }
    if (seen.has(name)) {
      duplicates++;
      continue;
    }
    seen.set(name, score);
  }
  return { list: [...seen], skipped, duplicates, rawCount: raw.length };
}

// ------------------------------------------------ reading the current file

function evaluateParts(code, expression) {
  const sandbox = { window: {}, self: {}, console: { log() {}, warn() {}, error() {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { timeout: 10_000 });
  return vm.runInContext(expression, sandbox);
}

async function readCurrent() {
  let text;
  try {
    text = await readFile(OUT_FILE, "utf8");
  } catch {
    throw new SafeStop(`${OUT_FILE} was not found in the repo root. Nothing was changed.`);
  }

  // Finds the line that starts the data, e.g. "window.BUILTIN_PARTS = {" or "const PARTS = {"
  const m = text.match(
    /^[ \t]*((?:window\.|globalThis\.|self\.|var\s+|let\s+|const\s+)?)([A-Za-z_$][\w$]*)\s*=\s*\{/m
  );
  if (!m) {
    throw new SafeStop(
      `I don't recognise the layout of the existing ${OUT_FILE}, so I won't overwrite it. ` +
        `Nothing was changed.`
    );
  }
  const prefix = m[1];
  const name = m[2];
  const expression = /\.\s*$/.test(prefix) ? prefix.trim() + name : name;

  let data;
  try {
    data = evaluateParts(text, expression);
  } catch (err) {
    throw new SafeStop(`The existing ${OUT_FILE} could not be read (${err.message}). Nothing was changed.`);
  }
  if (!data || !Array.isArray(data.cpus) || !Array.isArray(data.gpus)) {
    throw new SafeStop(`The existing ${OUT_FILE} has no cpus/gpus lists. Nothing was changed.`);
  }
  const extra = Object.keys(data).filter((k) => k !== "cpus" && k !== "gpus");
  if (extra.length) {
    throw new SafeStop(
      `The existing ${OUT_FILE} also contains "${extra.join('", "')}", which this script would delete. ` +
        `Nothing was changed.`
    );
  }
  for (const key of ["cpus", "gpus"]) {
    for (const row of data[key]) {
      if (!Array.isArray(row) || typeof row[0] !== "string" || !Number.isFinite(row[1])) {
        throw new SafeStop(`The existing ${key} list has a row that is not [name, score]. Nothing was changed.`);
      }
    }
  }
  return { text, prefix, name, expression, data };
}

// --------------------------------------------------------------- comparing

function compare(oldRows, newRows) {
  const oldMap = new Map(oldRows.map((r) => [r[0], r[1]]));
  const newMap = new Map(newRows);
  const added = [];
  const removed = [];
  const changed = [];
  let common = 0;
  let big = 0;
  for (const [name, score] of newMap) {
    if (!oldMap.has(name)) {
      added.push(name);
      continue;
    }
    common++;
    const before = oldMap.get(name);
    if (before !== score) {
      changed.push([name, before, score]);
      if (Math.abs(score - before) > BIG_CHANGE * Math.max(before, 1)) big++;
    }
  }
  for (const name of oldMap.keys()) if (!newMap.has(name)) removed.push(name);
  return { added, removed, changed, common, big, oldCount: oldMap.size, newCount: newMap.size };
}

// --------------------------------------------------------------- rendering

function renderFile(prefix, name, cpus, gpus) {
  const rows = (list) => list.map(([n, s]) => `  [${JSON.stringify(n)}, ${s}]`).join(",\n");
  return (
    `// AUTO-GENERATED by scripts/update-parts.mjs from PassMark (cpubenchmark.net / videocardbenchmark.net).\n` +
    `// Do not edit by hand: this file is rebuilt every Monday and manual edits are overwritten.\n` +
    `${prefix}${name} = {\n` +
    ` cpus: [\n${rows(cpus)}\n ],\n` +
    ` gpus: [\n${rows(gpus)}\n ]\n` +
    `};\n`
  );
}

// ------------------------------------------------------------------- main

async function main() {
  const lines = []; // report shown in the run summary
  const say = (s = "") => {
    console.log(s);
    lines.push(s);
  };

  const current = await readCurrent();

  // ONE request per site.
  const results = {};
  for (const key of ["cpus", "gpus"]) {
    const src = SOURCES[key];
    const html = await getPage(src);
    const exclude = key === "gpus" ? GPU_EXCLUDE : [];
    results[key] = buildList(html, src, exclude);
    const r = results[key];
    if (r.list.length < src.minCount) {
      throw new SafeStop(
        `Only ${r.list.length} ${src.label}s were found on the page (expected at least ${src.minCount}). ` +
          `PassMark probably changed its page layout or blocked the request. Nothing was changed.`
      );
    }
  }

  const problems = [];
  const diffs = {};
  for (const key of ["cpus", "gpus"]) {
    const src = SOURCES[key];
    const d = compare(current.data[key], results[key].list);
    diffs[key] = d;
    if (d.oldCount > 0 && d.newCount < d.oldCount * MAX_SHRINK) {
      problems.push(`${src.label} list shrank from ${d.oldCount} to ${d.newCount} entries.`);
    }
    if (d.common >= 200 && d.big / d.common > MAX_BIG_SHARE) {
      problems.push(
        `${src.label}: ${d.big} of ${d.common} shared parts changed score by more than ${BIG_CHANGE * 100}%, ` +
          `which suggests the page was read wrongly.`
      );
    }
  }

  const newText = renderFile(current.prefix, current.name, results.cpus.list, results.gpus.list);

  // Prove the new file loads and has the right content BEFORE writing it.
  let check;
  try {
    check = evaluateParts(newText, current.expression);
  } catch (err) {
    throw new SafeStop(`The rebuilt file failed its self-test (${err.message}). Nothing was changed.`);
  }
  if (
    !check ||
    check.cpus.length !== results.cpus.list.length ||
    check.gpus.length !== results.gpus.list.length ||
    check.cpus[0][0] !== results.cpus.list[0][0]
  ) {
    throw new SafeStop("The rebuilt file failed its self-test (contents do not match). Nothing was changed.");
  }

  say("# PassMark weekly sync");
  for (const key of ["cpus", "gpus"]) {
    const d = diffs[key];
    const r = results[key];
    const label = SOURCES[key].label;
    say(
      `${label}s: ${d.newCount} in the new list (was ${d.oldCount}). ` +
        `${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} score changes.`
    );
    if (d.changed.length) {
      const sample = d.changed
        .slice(0, 8)
        .map(([n, a, b]) => `${n}: ${a} -> ${b}`)
        .join("; ");
      say(`  e.g. ${sample}`);
    }
    if (r.skipped.length) say(`  Skipped ${r.skipped.length} virtual/driver ${label} entries: ${r.skipped.slice(0, 15).join(", ")}${r.skipped.length > 15 ? ", ..." : ""}`);
    if (r.duplicates) say(`  Ignored ${r.duplicates} duplicate names.`);
  }

  if (problems.length && !FORCE) {
    say();
    say("STOPPED - the old file was kept because:");
    for (const p of problems) say(`- ${p}`);
    say('If you have checked and the change is real, run the workflow manually and tick "force".');
    await writeSummary(lines);
    process.exitCode = 1;
    return;
  }
  if (problems.length && FORCE) {
    say();
    say("Safety checks overridden with force:");
    for (const p of problems) say(`- ${p}`);
  }

  if (newText === current.text) {
    say();
    say("No changes this week - builtin-parts.js is already identical to PassMark.");
    await writeSummary(lines);
    return;
  }

  await writeFile(OUT_FILE, newText, "utf8");
  say();
  say(`Wrote ${OUT_FILE}.`);
  await writeSummary(lines);
}

async function writeSummary(lines) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join("\n\n") + "\n");
}

main().catch(async (err) => {
  const msg = err instanceof SafeStop ? err.message : `Unexpected error: ${err.stack || err.message}`;
  console.error(`\nSYNC FAILED - ${msg}`);
  try {
    await writeSummary([`# PassMark weekly sync FAILED`, msg, `builtin-parts.js was not modified.`]);
  } catch {}
  process.exitCode = 1;
});
