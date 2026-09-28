// One-time patch for index.html. Each edit must match EXACTLY ONE place, otherwise
// nothing is written. Safe to run twice (it detects an already-patched file).
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const FILE = "index.html";
let html = readFileSync(FILE, "utf8");

const LIVE =
  'const live=(k,n)=>{const q=String(n||"").toLowerCase(),p=parts[k].find(x=>x[0].toLowerCase()==q);return p?p[1]:null},' +
  "refNow=()=>{const r={...(P.ref||remote.ref||DEF)},c=live(\"cpu\",r.cpuName),g=live(\"gpu\",r.gpuName);if(c!=null)r.cpu=c;if(g!=null)r.gpu=g;return r},W=";

// [what it does, text to find (string or regex), replacement]
const EDITS = [
  ["parts: ignore device-saved parts", 'localParts[k].forEach(([n,s])=>m[k].set(n.toLowerCase(),[n,s]));', ""],
  ["parts: ignore shared database parts", "remote.parts.forEach(p=>m[p.kind]&&m[p.kind].set(p.name.toLowerCase(),[p.name,p.score]));", ""],
  ["refresh saved listings with current PassMark scores", "parts={cpu:[...m.cpu.values()],gpu:[...m.gpu.values()]}}",
    'parts={cpu:[...m.cpu.values()],gpu:[...m.gpu.values()]};items.forEach(it=>{const c=live("cpu",it.cpuName),g=live("gpu",it.gpuName);if(c!=null)it.cpuScore=c;if(g!=null)it.gpuScore=g})}'],
  ["yardstick uses current PassMark scores", "const refNow=()=>P.ref||remote.ref||DEF,W=", LIVE],
  ["default yardstick names match PassMark", '{cpuName:"Ryzen 9 9950X3D",cpu:70098,gpuName:"RTX 5090",gpu:38864}', '{cpuName:"AMD Ryzen 9 9950X3D",cpu:70098,gpuName:"GeForce RTX 5090",gpu:38864}'],
  ["remove the 'Not listed? Add' suggestion", /<li data-new="1">[^`]*?<\/li>/, "${r.length?\"\":\"<li>No match in PassMark's list</li>\"}"],
  ["stop downloading the parts table", 'const[p,s]=await Promise.all([api("parts?select=kind,name,score").then(r=>r.json()),api("app_settings?key=eq.reference&select=value").then(r=>r.json())]);', 'const s=await api("app_settings?key=eq.reference&select=value").then(r=>r.json());'],
  ["stop storing downloaded parts", "if(Array.isArray(p))remote.parts=p;", ""],
  ["footer text", '${ON?"CPU/GPU scores are shared with everyone.":"Parts are saved on this device."}', "CPU/GPU scores come from PassMark and refresh every Monday."],
  ["admin: switch off part editing (note)", "Editing a built-in part saves an override that wins for everyone.", "Part editing is switched off: CPU/GPU scores now come from PassMark and refresh every Monday."],
  ["admin: disable Save button", 'data-act="adSave">', 'data-act="adSave" disabled>'],
  ["admin: disable Delete button", 'data-act="adDel">', 'data-act="adDel" disabled>'],
];

const count = (text, find) =>
  typeof find === "string" ? text.split(find).length - 1 : (text.match(new RegExp(find.source, "g")) || []).length;

const pending = [];
const done = [];
for (const [what, find, rep] of EDITS) {
  const n = count(html, find);
  if (n === 1) pending.push([what, find, rep]);
  else if (n === 0 && typeof rep === "string" && rep !== "" && html.includes(rep.slice(0, 60))) done.push(what);
  else if (n === 0 && rep === "") done.push(what);
  else {
    console.error(`STOPPED: "${what}" matched ${n} places (expected 1). index.html was NOT changed.`);
    process.exit(1);
  }
}
if (!pending.length) {
  console.log("index.html is already up to date. Nothing to do.");
  process.exit(0);
}
if (done.length) {
  console.error(`STOPPED: the file is only partly patched (${done.join("; ")}). index.html was NOT changed.`);
  process.exit(1);
}

for (const [what, find, rep] of pending) {
  html = typeof find === "string" ? html.replace(find, () => rep) : html.replace(find, () => rep);
  console.log("done:", what);
}

// Syntax-check the page's own script before saving.
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (scripts.length !== 1) {
  console.error("STOPPED: could not find the page script. index.html was NOT changed.");
  process.exit(1);
}
try {
  new vm.Script(scripts[0]);
} catch (e) {
  console.error("STOPPED: the patched script has a syntax error (" + e.message + "). index.html was NOT changed.");
  process.exit(1);
}

writeFileSync(FILE, html, "utf8");
console.log("index.html patched.");
