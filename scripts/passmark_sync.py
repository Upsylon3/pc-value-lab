#!/usr/bin/env python3
"""
passmark_sync.py - compare PC Value Lab's CPU/GPU scores with PassMark and fix drift.

It can change exactly two things, and only when run with --apply:
  1. builtin-parts.js  (rewritten in place, same format, same order, same names)
  2. the Supabase `parts` table, one row at a time, through the same
     admin_upsert_part function the Admin tab uses. This additionally needs the
     PVL_ADMIN_PASSPHRASE environment variable; without it, Supabase is only reported.
Without --apply it is a dry run: it prints the report and writes nothing.

Standard library only, on purpose: nothing to install means nothing to break.

Design rule used everywhere below: when in doubt, DO NOT change data, say so in the
report instead. A skipped fix costs a week; a wrong fix silently corrupts rankings.
"""
from __future__ import annotations

import argparse
import html.parser
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# PassMark pages. The GPU "mega page" is NOT used: its table is empty in the raw HTML
# (filled by JavaScript after load), so a script can't read it. gpu_list.php is the
# server-rendered equivalent and carries the same G3D Mark.
URLS = {
    "cpu": "https://www.cpubenchmark.net/cpu-list/all",
    "gpu": "https://www.videocardbenchmark.net/gpu_list.php",
}
# Every row on those pages links to a lookup page; that link is how we recognise a
# data row without depending on column order, CSS classes or table ids.
LOOKUP_MARKER = {"cpu": "cpu_lookup.php", "gpu": "video_lookup.php"}

USER_AGENT = "pc-value-lab-sync/1.0 (weekly, 2 requests; +https://github.com/Upsylon3/pc-value-lab)"

# --- Safety limits ---------------------------------------------------------------
# PassMark scores wobble a little as new submissions arrive. Ignoring differences under
# this keeps us from rewriting the file every week for noise. Override: PVL_TOLERANCE_PCT.
DEFAULT_TOLERANCE_PCT = 2.0
# A "fix" that more than doubles or halves a score is far more likely to be a wrong
# name match or a shifted column than a real change, so it is reported, never applied.
RATIO_MIN, RATIO_MAX = 0.5, 2.0
# Mirrors the CHECK constraint on parts.score in setup.sql; the DB would refuse anyway.
SCORE_MIN, SCORE_MAX = 100, 400_000
# If the page layout changes we'd parse nothing (or garbage). These floors catch that.
MIN_ROWS = {"cpu": 1000, "gpu": 500}
# Our own curated list is the yardstick for "did we read PassMark correctly?":
MIN_BUILTIN_MATCH_SHARE = 0.70     # at least 70% of built-in names must be found
MEDIAN_RATIO_BOUNDS = (0.8, 1.25)  # and their scores must be roughly the same overall
# If a big share of ALL matched parts "changed", something systematic happened (PassMark
# re-baselined, or we misread a column). Stop and let a human look.
MAX_CHANGED_SHARE = 0.30
MIN_FOR_SHARE_CHECK = 20
MAX_REMOTE_UPDATES = 200           # hard cap on Supabase writes per run


class Abort(Exception):
    """Raised when something looks wrong enough that we should change nothing."""


# --- Small helpers -----------------------------------------------------------------
def clean(s: str) -> str:
    return " ".join(s.split())


def key(name: str) -> str:
    return clean(name).lower()


def loose_key(kind: str, name: str) -> str:
    """Looser comparison key: PassMark lists GPUs sometimes with and sometimes without
    the vendor prefix ("GeForce RTX 4090" vs "NVIDIA GeForce RTX 4090"), and the
    built-in list uses the prefixed form. CPUs keep their prefix ("AMD Ryzen ...")."""
    k = key(name)
    if kind == "gpu":
        for prefix in ("nvidia ", "amd "):
            if k.startswith(prefix):
                k = k[len(prefix):]
    return k


def http(url, headers=None, body=None, attempts=3):
    """Return (status, text). Retries only on network errors / 5xx: a 4xx means we are
    blocked or asking wrongly, and hammering the server would make that worse."""
    h = {"User-Agent": USER_AGENT, "Accept-Encoding": "identity", **(headers or {})}
    data = body.encode("utf-8") if body is not None else None
    last = "unknown error"
    for n in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, data=data, headers=h,
                                         method="POST" if data is not None else "GET")
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, r.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if 400 <= e.code < 500:
                return e.code, e.read().decode("utf-8", errors="replace")
            last = f"HTTP {e.code}"
        except Exception as e:  # network down, DNS, timeout...
            last = str(e)
        if n < attempts:
            time.sleep(5 * n)
    raise Abort(f"could not reach {url.split('?')[0]} ({last})")


# --- Reading PassMark --------------------------------------------------------------
class ListParser(html.parser.HTMLParser):
    """Collect (name, mark) from table rows whose first link points at a lookup page.
    The mark must be in the cell IMMEDIATELY after the name cell. Being strict here is
    deliberate: skipping a row is harmless, reading the Rank column by mistake is not."""

    def __init__(self, marker: str):
        super().__init__(convert_charrefs=True)
        self.marker = marker
        self.rows: list[tuple[str, int]] = []
        self._cells = None   # cells of the row being read (None = not inside a row)
        self._cell = None    # the cell being read
        self._link = None    # text pieces of a lookup link being read

    def _close_cell(self):
        if self._cell is not None and self._cells is not None:
            self._cells.append(self._cell)
        self._cell = None

    def _close_row(self):
        self._close_cell()
        cells, self._cells = self._cells, None
        if not cells:
            return
        i = next((n for n, c in enumerate(cells) if c["link"]), None)
        if i is None or i + 1 >= len(cells):
            return
        text = clean("".join(cells[i + 1]["text"]))
        if re.fullmatch(r"\d[\d,]*", text):
            self.rows.append((cells[i]["link"], int(text.replace(",", ""))))

    # Some HTML omits closing tags; opening a new cell/row therefore closes the old one.
    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            if self._cells is not None:
                self._close_row()
            self._cells = []
        elif tag in ("td", "th") and self._cells is not None:
            self._close_cell()
            self._cell = {"text": [], "link": None}
        elif tag == "a" and self._cell is not None and self._cell["link"] is None:
            if self.marker in (dict(attrs).get("href") or ""):
                self._link = []

    def handle_data(self, data):
        if self._cell is not None:
            self._cell["text"].append(data)
        if self._link is not None:
            self._link.append(data)

    def handle_endtag(self, tag):
        if tag == "a" and self._link is not None:
            if self._cell is not None:
                self._cell["link"] = clean("".join(self._link)) or None
            self._link = None
        elif tag in ("td", "th"):
            self._close_cell()
        elif tag == "tr" and self._cells is not None:
            self._close_row()

    def close(self):
        super().close()
        if self._cells is not None:
            self._close_row()


class Index:
    """Name lookup over PassMark rows. Exact (case-insensitive) match first, then the
    vendor-prefix-insensitive one. If several PassMark rows would match with different
    scores we refuse to guess ('ambiguous')."""

    def __init__(self, kind, rows):
        self.kind = kind
        self.exact, self.loose = {}, {}
        for name, mark in rows:
            self.exact.setdefault(key(name), set()).add((name, mark))
            self.loose.setdefault(loose_key(kind, name), set()).add((name, mark))

    def lookup(self, name):
        for table, k in ((self.exact, key(name)), (self.loose, loose_key(self.kind, name))):
            hits = table.get(k)
            if not hits:
                continue
            marks = {m for _, m in hits}
            if len(marks) == 1:
                return "ok", sorted(hits)[0][0], next(iter(marks))
            return "ambiguous", None, None
        return "missing", None, None


def load_passmark(kind):
    status, text = http(URLS[kind])
    if status != 200:
        raise Abort(f"PassMark {kind} page answered HTTP {status} (blocked or moved?)")
    parser = ListParser(LOOKUP_MARKER[kind])
    parser.feed(text)
    parser.close()
    if len(parser.rows) < MIN_ROWS[kind]:
        raise Abort(f"only {len(parser.rows)} {kind.upper()} rows found on PassMark "
                    f"(expected at least {MIN_ROWS[kind]}). The page layout probably changed.")
    return Index(kind, parser.rows)


# --- Our data ----------------------------------------------------------------------
def dumps(d):
    return json.dumps(d, ensure_ascii=False, separators=(",", ":"))


def load_builtin():
    with open(ROOT / "builtin-parts.js", encoding="utf-8", newline="") as f:
        raw = f.read()
    body = raw.rstrip()
    m = re.fullmatch(r"window\.BUILTIN=(\{.*\});", body, re.S)
    if not m:
        raise Abort("builtin-parts.js does not look like `window.BUILTIN={...};` - refusing to touch it")
    data = json.loads(m.group(1))
    # Round-trip check: if re-serialising our parse doesn't reproduce the file byte for
    # byte, our writer would silently change the format the app expects. Stop instead.
    if "window.BUILTIN=" + dumps(data) + ";" != body:
        raise Abort("builtin-parts.js formatting differs from what this script writes - refusing to rewrite it")
    if not all(isinstance(data.get(k), list) for k in ("cpus", "gpus")):
        raise Abort("builtin-parts.js has no `cpus`/`gpus` lists")
    return data, raw[len(body):]


def save_builtin(data, suffix):
    with open(ROOT / "builtin-parts.js", "w", encoding="utf-8", newline="") as f:
        f.write("window.BUILTIN=" + dumps(data) + ";" + suffix)


def load_remote():
    """Return dict(base, key, rows) or dict(note=why-not). Never raises: Supabase being
    unreachable must not block the built-in fix, but it is reported and warned about."""
    try:
        with open(ROOT / "config.js", encoding="utf-8") as f:
            cfg = f.read()
        url = re.search(r'supabaseUrl\s*:\s*"([^"]+)"', cfg)
        anon = re.search(r'supabaseKey\s*:\s*"([^"]+)"', cfg)
        if not url or not anon:
            return {"note": "config.js has no Supabase values - skipped"}
        base, apikey = url.group(1).rstrip("/"), anon.group(1)
        rows, offset = [], 0
        while offset < 50_000:  # bounded loop: never spin forever on a misbehaving API
            status, text = http(f"{base}/rest/v1/parts?select=kind,name,score&order=id.asc&limit=1000&offset={offset}",
                                {"apikey": apikey})
            if status != 200:
                return {"note": f"Supabase answered HTTP {status} - skipped"}
            page = json.loads(text)
            if not isinstance(page, list):
                return {"note": "Supabase returned something unexpected - skipped"}
            rows += page
            if len(page) < 1000:
                break
            offset += 1000
        good = [r for r in rows if isinstance(r, dict) and r.get("kind") in ("cpu", "gpu")
                and isinstance(r.get("name"), str) and isinstance(r.get("score"), int)]
        return {"base": base, "key": apikey, "rows": good}
    except Exception as e:
        return {"note": f"Supabase check failed ({e}) - skipped"}


# --- Comparing ---------------------------------------------------------------------
def plan(kind, entries, idx, tol):
    """entries: [(name, old_score)]. Sorts each into apply / suspicious / same / missing /
    ambiguous. Only 'apply' entries are ever written anywhere."""
    out = {"apply": [], "suspicious": [], "same": 0, "missing": [], "ambiguous": [], "ratios": []}
    for name, old in entries:
        status, canon, new = idx.lookup(name)
        if status != "ok":
            out["missing" if status == "missing" else "ambiguous"].append(name)
            continue
        if old <= 0:
            out["suspicious"].append((name, old, new, canon))
            continue
        out["ratios"].append(new / old)
        if abs(new - old) <= old * tol / 100:
            out["same"] += 1
        elif not (RATIO_MIN <= new / old <= RATIO_MAX) or not (SCORE_MIN <= new <= SCORE_MAX):
            out["suspicious"].append((name, old, new, canon))
        else:
            out["apply"].append((name, old, new, canon))
    return out


def matched(p):
    return p["same"] + len(p["apply"]) + len(p["suspicious"])


def check_parse_trust(builtin_plans, builtin_total):
    """Did we read PassMark correctly? Judge by our own curated list."""
    found = sum(matched(p) for p in builtin_plans.values())
    ratios = [r for p in builtin_plans.values() for r in p["ratios"]]
    share = found / builtin_total if builtin_total else 0
    if share < MIN_BUILTIN_MATCH_SHARE:
        raise Abort(f"only {found} of {builtin_total} built-in parts were found on PassMark "
                    f"({share:.0%}); names or layout probably changed.")
    med = statistics.median(ratios) if ratios else 0
    if not (MEDIAN_RATIO_BOUNDS[0] <= med <= MEDIAN_RATIO_BOUNDS[1]):
        raise Abort(f"PassMark scores are off from ours by a median factor of {med:.2f}; "
                    "a column probably moved or PassMark re-baselined. Nothing changed.")


def check_change_share(label, plans):
    total = sum(matched(p) for p in plans.values())
    changed = sum(len(p["apply"]) + len(p["suspicious"]) for p in plans.values())
    if total >= MIN_FOR_SHARE_CHECK and changed / total > MAX_CHANGED_SHARE:
        raise Abort(f"{changed} of {total} {label} scores would change ({changed / total:.0%}). "
                    "That is too many to be normal drift; nothing was changed.")


def push_remote_fixes(remote, passphrase, fixes):
    """Update Supabase rows through the admin RPC (same call the Admin tab makes).
    Returns (done, problems). Stops at the first rejected passphrase."""
    done, problems = 0, []
    for kind, name, _old, new in fixes[:MAX_REMOTE_UPDATES]:
        body = json.dumps({"p": passphrase, "k": kind, "n": name, "s": new})
        try:
            status, _ = http(f"{remote['base']}/rest/v1/rpc/admin_upsert_part",
                             {"apikey": remote["key"], "Content-Type": "application/json"},
                             body, attempts=2)
        except Abort as e:
            problems.append(str(e))
            break
        if status in (200, 204):
            done += 1
        elif status in (400, 401, 403):
            problems.append("Supabase rejected the admin passphrase (PVL_ADMIN_PASSPHRASE) - stopped")
            break
        else:
            problems.append(f"{name}: HTTP {status}")
    if len(fixes) > MAX_REMOTE_UPDATES:
        problems.append(f"{len(fixes) - MAX_REMOTE_UPDATES} more fixes left for next run (cap {MAX_REMOTE_UPDATES})")
    return done, problems


# --- Report ------------------------------------------------------------------------
def md_escape(s):
    return s.replace("|", "\\|")


def table(kind, rows):
    lines = ["| Type | Part | Was | Now |", "| --- | --- | ---: | ---: |"]
    for name, old, new, canon in sorted(rows, key=lambda r: (kind, r[0].lower())):
        shown = name if canon == name else f"{name} (PassMark: {canon})"
        lines.append(f"| {kind.upper()} | {md_escape(shown)} | {old} | {new} |")
    return lines


def section(title, plans, applied_note):
    lines = [f"## {title}", ""]
    checked = sum(matched(p) + len(p["missing"]) + len(p["ambiguous"]) for p in plans.values())
    fixes = [(k, *r) for k, p in plans.items() for r in p["apply"]]
    sus = [(k, *r) for k, p in plans.items() for r in p["suspicious"]]
    same = sum(p["same"] for p in plans.values())
    lines.append(f"Checked {checked} · in sync {same} · to fix {len(fixes)} · "
                 f"needs your eyes {len(sus)} · not on PassMark "
                 f"{sum(len(p['missing']) for p in plans.values())} · "
                 f"ambiguous {sum(len(p['ambiguous']) for p in plans.values())}")
    lines.append("")
    if fixes:
        lines += [applied_note, ""]
        for kind in ("cpu", "gpu"):
            rows = plans[kind]["apply"]
            if rows:
                lines += table(kind, rows) + [""]
    if sus:
        lines += ["**Not applied - change is suspiciously large, please check by hand:**", ""]
        for kind in ("cpu", "gpu"):
            rows = plans[kind]["suspicious"]
            if rows:
                lines += table(kind, rows) + [""]
    for label, field in (("Not found on PassMark (custom or oddly named - left alone)", "missing"),
                         ("Ambiguous on PassMark (several matches - left alone)", "ambiguous")):
        names = [f"{k.upper()}: {n}" for k, p in plans.items() for n in sorted(p[field], key=str.lower)]
        if names:
            lines += [f"<details><summary>{label} ({len(names)})</summary>", ""]
            lines += [f"- {md_escape(n)}" for n in names] + ["", "</details>", ""]
    return lines


# --- Main flow ---------------------------------------------------------------------
def run(apply, tol):
    passmark = {k: load_passmark(k) for k in ("cpu", "gpu")}
    data, suffix = load_builtin()

    b_plans = {k: plan(k, [(n, s) for n, s in data[k + "s"]], passmark[k], tol) for k in ("cpu", "gpu")}
    check_parse_trust(b_plans, len(data["cpus"]) + len(data["gpus"]))
    check_change_share("built-in", b_plans)

    remote = load_remote()
    r_plans = None
    if "rows" in remote:
        r_plans = {k: plan(k, [(r["name"], r["score"]) for r in remote["rows"] if r["kind"] == k],
                           passmark[k], tol) for k in ("cpu", "gpu")}
        check_change_share("Supabase", r_plans)

    # Everything above only READS. Writing starts here, after every check has passed.
    written_builtin, remote_done, remote_problems = False, 0, []
    passphrase = os.environ.get("PVL_ADMIN_PASSPHRASE", "")
    if apply:
        fixes = {k: {n: new for n, _o, new, _c in b_plans[k]["apply"]} for k in ("cpu", "gpu")}
        if any(fixes.values()):
            for k in ("cpu", "gpu"):
                # Same names, same order; only the score number changes.
                data[k + "s"] = [[n, fixes[k].get(n, s)] for n, s in data[k + "s"]]
            save_builtin(data, suffix)
            written_builtin = True
        if r_plans and passphrase:
            remote_fixes = [(k, n, o, new) for k in ("cpu", "gpu") for n, o, new, _c in r_plans[k]["apply"]]
            if remote_fixes:
                remote_done, remote_problems = push_remote_fixes(remote, passphrase, remote_fixes)

    out = ["# PassMark sync", ""]
    out.append("**Mode:** " + ("applied" if apply else "dry run - nothing was written"))
    out.append(f"**Tolerance:** differences up to {tol:g}% are ignored")
    out.append("")
    out += section("Built-in list (builtin-parts.js)", b_plans,
                   "Written to builtin-parts.js:" if apply else "Would be written to builtin-parts.js:")
    if written_builtin:
        out += ["_builtin-parts.js updated._", ""]
    if r_plans is not None:
        n_remote = sum(len(p["apply"]) for p in r_plans.values())
        if apply and passphrase:
            note = f"Sent to Supabase: {remote_done} of {n_remote}."
        elif apply:
            note = ("Not sent: add the `PVL_ADMIN_PASSPHRASE` repository secret to let the "
                    "sync fix these itself, or edit them in the Admin tab.")
        else:
            note = "Would be sent to Supabase when run with --apply and the passphrase secret set:"
        out += section("Shared database (Supabase)", r_plans, note)
        for p in remote_problems:
            out.append(f"- WARNING: {p}")
            print(f"::warning::{p}", file=sys.stderr)
    else:
        out += ["## Shared database (Supabase)", "", f"Skipped: {remote['note']}", ""]
        print(f"::warning::Supabase skipped: {remote['note']}", file=sys.stderr)
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Compare CPU/GPU scores with PassMark.")
    ap.add_argument("--apply", action="store_true", help="write fixes (default: dry run)")
    args = ap.parse_args(argv)
    try:
        tol = float(os.environ.get("PVL_TOLERANCE_PCT") or DEFAULT_TOLERANCE_PCT)
    except ValueError:
        tol = DEFAULT_TOLERANCE_PCT
    try:
        print(run(args.apply, tol))
    except Abort as e:
        print(f"# PassMark sync - stopped, nothing was changed\n\n{e}")
        print(f"::error::{e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
