"""Scan every company's careers source + LinkedIn for Hong Kong internships.

Reads companies.json, merges results into docs/data/openings.json (keeping
first-seen dates across runs), writes docs/feed.xml, and writes new_jobs.md +
GitHub Actions outputs when something new appears.

Usage: python scraper/run.py [--skip-linkedin] [--only NAME]
"""
import argparse
import concurrent.futures as cf
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote_plus
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).parent))
import adapters as A  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data" / "openings.json"
FEED = ROOT / "docs" / "feed.xml"
NEW_MD = ROOT / "new_jobs.md"

LINKEDIN_QUERIES = [("intern", 300), ("internship", 200), ("summer analyst", 100), ("off-cycle", 60), ("graduate programme", 80)]
LINKEDIN_KEEP_DAYS = 30      # drop a LinkedIn card this long after we last saw it in search
LINKEDIN_RECHECK = 25        # closed-posting checks per run
NOW = datetime.now(timezone.utc)
NOW_ISO = NOW.strftime("%Y-%m-%dT%H:%M:%SZ")


def log(*a):
    print(*a, flush=True)


def kind_of(title):
    if A.NOT_ROLE_RE.search(title):
        return None
    if A.INTERN_RE.search(title):
        return "internship"
    if A.GRAD_RE.search(title):
        return "graduate"
    return None


def norm(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower().replace("&", " and ")
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    toks = s.split()
    if toks and toks[0] == "the":
        toks = toks[1:]
    while toks and toks[-1] in {"limited", "ltd", "inc", "plc", "llc", "lp", "sa", "ag", "corp", "corporation", "co"}:
        toks = toks[:-1]
    return toks


def slug(name):
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name).strip("-")


def load_companies():
    """companies.json keeps only what differs from the defaults; fill those in here."""
    companies = json.loads((ROOT / "companies.json").read_text())
    for c in companies:
        base = re.sub(r"\s*\(.*?\)", "", c["name"]).strip()
        c["id"] = slug(c["name"])
        c.setdefault("aliases", [base])
        c.setdefault("sources", [])
        c.setdefault("note", "")
        query = re.sub(r"\s*/.*", "", base)
        c["linkedin_search"] = f"https://www.linkedin.com/jobs/search/?keywords={quote_plus(query)}&location=Hong%20Kong%20SAR&geoId=103291313"
    return companies


def build_matcher(companies):
    aliases = []
    for c in companies:
        for a in c.get("aliases", []):
            t = norm(a)
            if t:
                aliases.append((t, c["id"]))
    aliases.sort(key=lambda x: -len(x[0]))  # longest alias wins ("Natixis Investment Managers" over "Natixis")

    def match(company_name):
        t = norm(company_name)
        for a, cid in aliases:
            if t[: len(a)] == a:
                return cid
        return None

    return match


def title_key(title):
    return " ".join(norm(title))


def load_state():
    if DATA.exists():
        return json.loads(DATA.read_text())
    return {"jobs": [], "meta": {}}


def scan_sources(companies, only=None):
    """Returns ({source_key: [jobs]}, [status rows]); a failed source maps to None."""
    tasks = []
    for c in companies:
        if only and only.lower() not in c["name"].lower():
            continue
        for i, src in enumerate(c.get("sources", [])):
            tasks.append((c, i, src))

    def run(t):
        c, i, src = t
        key = f"{c['id']}#{i}"
        t0 = time.time()
        try:
            raw = A.ADAPTERS[src["type"]](src)
        except Exception as e:  # keep going; a broken source must not stop the scan
            return key, None, {"company": c["name"], "type": src["type"], "ok": False, "error": f"{type(e).__name__}: {str(e)[:160]}", "seen": 0, "hk": 0}
        keep = []
        for j in raw:
            k = kind_of(j["title"])
            if k and A.HK_RE.search(j["location"] + " " + j["title"]):
                keep.append(dict(j, kind=k, company_id=c["id"], company=c["name"], source=src["type"]))
        return key, keep, {"company": c["name"], "type": src["type"], "ok": True, "seen": len(raw), "hk": len(keep), "secs": round(time.time() - t0, 1)}

    results, status = {}, []
    with cf.ThreadPoolExecutor(10) as ex:
        for key, keep, st in ex.map(run, tasks):
            results[key] = keep
            status.append(st)
            log(f"  {st['company'][:30]:30} {st['type']:10} " + (f"ok  seen={st['seen']:<4} hk_matches={st['hk']}" if st["ok"] else "FAIL " + st["error"]))
    return results, status


def scan_schemes(state):
    """University schemes post a dated job list behind a student login: track the date and the link.
    Returns (rows for the site, rows whose date changed since the last run)."""
    prev = {s["id"]: s for s in state.get("schemes", [])}
    rows, changed = [], []
    for s in json.loads((ROOT / "schemes.json").read_text()):
        sid = slug(s["name"])
        old = prev.get(sid) or dict(s.get("seed", {}))
        row = dict(old, id=sid, name=s["name"], org=s.get("org", ""), url=s["url"], note=s.get("note", ""), checked_at=NOW_ISO)
        try:
            got = A.scheme_page(s["url"])
        except Exception as e:  # e.g. the university's bot check: keep the last confirmed date
            row.update(ok=False, error=f"{type(e).__name__}: {str(e)[:160]}")
            log(f"  {s['name'][:40]:40} scheme FAIL {row['error']}")
        else:
            if old.get("updated") and got["updated"] != old["updated"]:
                row["changed_at"] = NOW_ISO
                changed.append(row)
            row.update({k: v for k, v in got.items() if v}, ok=True, error="", confirmed_at=NOW_ISO)
            log(f"  {s['name'][:40]:40} scheme ok  updated={row['updated']}")
        rows.append(row)
    return rows, changed


def scan_linkedin(state, match):
    meta = state.get("meta", {})
    last_ok = meta.get("linkedin_last_ok")
    recent = last_ok and NOW - datetime.fromisoformat(last_ok.replace("Z", "+00:00")) < timedelta(days=3)
    period = "r604800" if recent else "r2592000"  # past week once we have history, else past month
    log(f"LinkedIn sweep (period={period})")
    found, errors = {}, 0
    for kw, cap in LINKEDIN_QUERIES:
        try:
            got = A.linkedin_search(kw, period, cap, log)
            log(f"  '{kw}': {len(got)} cards")
            found.update(got)
        except Exception as e:
            errors += 1
            log(f"  '{kw}': FAIL {e}")
    out = []
    for j in found.values():
        k = kind_of(j["title"])
        if not k:
            continue
        cid = match(j["company"])
        out.append(dict(j, kind=k, company_id=cid, source="linkedin"))
    ok = errors < len(LINKEDIN_QUERIES) and bool(found)
    return out, ok, period


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-linkedin", action="store_true")
    ap.add_argument("--only")
    args = ap.parse_args()

    companies = load_companies()
    by_id = {c["id"]: c for c in companies}
    match = build_matcher(companies)
    state = load_state()
    first_run = not state["jobs"]
    prev = {j["key"]: j for j in state["jobs"]}
    meta = dict(state.get("meta", {}))

    log(f"Scanning {sum(len(c.get('sources', [])) for c in companies)} careers sources")
    results, status = scan_sources(companies, args.only)

    jobs = {}
    # ---- careers-site jobs: a successful fetch is authoritative for that source
    for src_key, keep in results.items():
        if keep is None:  # fetch failed: carry forward whatever we had
            for k, j in prev.items():
                if j.get("src_key") == src_key:
                    jobs[k] = j
            continue
        for j in keep:
            key = f"{j['company_id']}:{j['ext_id']}"
            old = prev.get(key, {})
            jobs[key] = dict(j, key=key, src_key=src_key, first_seen=old.get("first_seen", NOW_ISO), last_seen=NOW_ISO)
    # sources not scanned this run (e.g. --only) keep their jobs
    scanned = set(results)
    for k, j in prev.items():
        if j.get("src_key") and j["src_key"] not in scanned and k not in jobs:
            jobs[k] = j

    # ---- university internship schemes
    schemes, scheme_changes = (state.get("schemes", []), []) if args.only else scan_schemes(state)

    # ---- LinkedIn
    li_ok, period = False, meta.get("linkedin_period", "")
    if not args.skip_linkedin and not args.only:
        li_jobs, li_ok, period = scan_linkedin(state, match)
        for j in li_jobs:
            key = f"li:{j['ext_id']}"
            old = prev.get(key, {})
            jobs[key] = dict(old, **j, key=key, first_seen=old.get("first_seen", NOW_ISO), last_seen=NOW_ISO)
    cutoff = (NOW - timedelta(days=LINKEDIN_KEEP_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    for k, j in prev.items():
        if j.get("source") == "linkedin" and k not in jobs and j["last_seen"] >= cutoff:
            jobs[k] = j
    if li_ok:
        # Confirm older tracked LinkedIn postings are still accepting applications.
        stale = sorted((j for j in jobs.values() if j.get("source") == "linkedin" and j.get("company_id")),
                       key=lambda j: j.get("checked", ""))[:LINKEDIN_RECHECK]
        for j in stale:
            if j.get("checked", "") > (NOW - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%SZ"):
                continue
            try:
                if A.linkedin_is_closed(j["ext_id"], log):
                    log(f"  closed on LinkedIn: {j['company']} - {j['title']}")
                    jobs.pop(j["key"], None)
                else:
                    j["checked"] = NOW_ISO
            except Exception as e:
                log(f"  recheck stopped: {e}")
                break
        meta["linkedin_last_ok"] = NOW_ISO
        meta["linkedin_period"] = period

    # ---- re-classify carried-over jobs so filter and alias changes apply to old data too
    for k in list(jobs):
        kind = kind_of(jobs[k]["title"])
        if kind:
            jobs[k]["kind"] = kind
            if jobs[k].get("source") == "linkedin":
                jobs[k]["company_id"] = match(jobs[k]["company"])
        else:
            jobs.pop(k)

    # ---- a LinkedIn card for a job we already have from the careers site is a duplicate
    official = {(j["company_id"], title_key(j["title"])): j for j in jobs.values() if j.get("source") != "linkedin"}
    for k in [k for k, j in jobs.items() if j.get("source") == "linkedin" and j.get("company_id")]:
        twin = official.get((jobs[k]["company_id"], title_key(jobs[k]["title"])))
        if twin:
            twin["linkedin_url"] = jobs[k]["url"]
            jobs.pop(k)
    # same posting listed by two sources of one company (e.g. Citi on Eightfold + Workday)
    seen_titles = {}
    for k in sorted(jobs, key=lambda k: jobs[k]["first_seen"]):
        j = jobs[k]
        tk = (j.get("company_id") or j.get("company"), title_key(j["title"]))
        if tk in seen_titles and seen_titles[tk] != k:
            jobs.pop(k)
        else:
            seen_titles[tk] = k

    all_jobs = sorted(jobs.values(), key=lambda j: j["first_seen"], reverse=True)
    meta.update(generated_at=NOW_ISO, first_run_at=meta.get("first_run_at", NOW_ISO))
    out = {
        "meta": meta,
        "sources": sorted(status, key=lambda s: (s["ok"], s["company"])),
        "companies": [{"id": c["id"], "name": c["name"], "category": c["category"], "careers_url": c["url"],
                       "linkedin_search": c["linkedin_search"], "link_note": c["note"]} for c in companies],
        "schemes": schemes,
        "jobs": all_jobs,
    }
    DATA.parent.mkdir(parents=True, exist_ok=True)
    DATA.write_text(json.dumps(out, indent=1, ensure_ascii=False))
    write_feed(all_jobs, schemes)

    new = [j for j in all_jobs if j["key"] not in prev]
    tracked_new = [j for j in new if j.get("company_id")]
    log(f"\n{len(all_jobs)} openings ({sum(1 for j in all_jobs if j.get('company_id'))} at your companies); {len(new)} new, {len(tracked_new)} at your companies"
        + (f"; {len(scheme_changes)} scheme job list(s) updated" if scheme_changes else ""))
    notify(tracked_new, len(new) - len(tracked_new), first_run, scheme_changes)


def fmt_day(iso_date):
    return datetime.strptime(iso_date, "%Y-%m-%d").strftime("%-d %b %Y")


def write_feed(jobs, schemes):
    site = os.environ.get("SITE_URL", "")
    items = []
    for s in schemes:
        if s.get("updated"):
            items.append(
                "<item><title>{}</title><link>{}</link><guid isPermaLink=\"false\">{}</guid><pubDate>{}</pubDate><description>{}</description></item>".format(
                    escape(f"{s['name']}: job list updated {fmt_day(s['updated'])}"), escape(s.get("job_list_url") or s["url"]),
                    escape(f"{s['id']}:{s['updated']}"),
                    datetime.fromisoformat(s.get("changed_at", s["updated"] + "T00:00:00Z").replace("Z", "+00:00")).strftime("%a, %d %b %Y %H:%M:%S +0000"),
                    escape(s.get("note", "")),
                )
            )
    for j in [j for j in jobs if j.get("company_id")][:150]:
        items.append(
            "<item><title>{}</title><link>{}</link><guid isPermaLink=\"false\">{}</guid><pubDate>{}</pubDate><description>{}</description></item>".format(
                escape(f"{j['company']}: {j['title']}"), escape(j["url"]), escape(j["key"]),
                datetime.fromisoformat(j["first_seen"].replace("Z", "+00:00")).strftime("%a, %d %b %Y %H:%M:%S +0000"),
                escape(f"{j['kind']} · {j['location']} · via {j['source']}"),
            )
        )
    FEED.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>HK Internship Radar</title>'
        f"<link>{escape(site)}</link><description>New Hong Kong internships at companies in your tracker</description>"
        + "".join(items) + "</channel></rss>\n"
    )


def notify(tracked_new, other_new, first_run, scheme_changes):
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if first_run:  # first run would list everything – skip the alert
        tracked_new = []
    count = len(tracked_new) + len(scheme_changes)
    if gh_out:
        interns = sum(1 for j in tracked_new if j["kind"] == "internship")
        parts = [f"{len(tracked_new)} new HK opening{'s' if len(tracked_new) != 1 else ''} ({interns} internship{'s' if interns != 1 else ''})"] if tracked_new else []
        parts += [f"{s['name']} job list updated" for s in scheme_changes]
        with open(gh_out, "a") as f:
            f.write(f"new_count={count}\n")
            f.write(f"issue_title={' + '.join(parts) or 'No changes'} – {NOW:%d %b %Y}\n")
    if not count:
        NEW_MD.unlink(missing_ok=True)
        return
    owner = os.environ.get("GITHUB_REPOSITORY_OWNER", "")
    site = os.environ.get("SITE_URL", "")
    lines = [f"@{owner} new in Hong Kong for your tracker:\n" if owner else "New in Hong Kong:\n"]
    if scheme_changes:
        lines.append("### University schemes\n")
        for s in scheme_changes:
            job_list = f"[Job List]({s['job_list_url']}) (log in first) · " if s.get("job_list_url") else ""
            lines.append(f"- **{s['name']}** – job list updated {fmt_day(s['updated'])} · {job_list}[Scheme page]({s['url']})")
        lines.append("")
    for kind in ("internship", "graduate"):
        group = [j for j in tracked_new if j["kind"] == kind]
        if not group:
            continue
        lines.append(f"### {'Internships' if kind == 'internship' else 'Graduate programmes'}\n")
        for j in sorted(group, key=lambda j: j["company"]):
            lines.append(f"- **{j['company']}** – [{j['title']}]({j['url']}) · {j['location'][:60]} · _{j['source']}_")
        lines.append("")
    if other_new and tracked_new:
        lines.append(f"\n_Plus {other_new} new HK listings at other companies on LinkedIn._")
    if site:
        lines.append(f"\n[Open the radar]({site})")
    NEW_MD.write_text("\n".join(lines) + "\n")

    topic = os.environ.get("NTFY_TOPIC")
    if topic:
        msg = "\n".join([f"{s['name']}: job list updated {fmt_day(s['updated'])}" for s in scheme_changes]
                        + [f"{j['company']}: {j['title']}" for j in tracked_new[:15]])
        title = f"{len(tracked_new)} new HK openings" if tracked_new else "Internship scheme job list updated"
        try:
            A.S.post(f"https://ntfy.sh/{topic}", data=msg.encode(),
                     headers={"Title": title, "Click": site or "https://github.com"}, timeout=20)
        except Exception as e:
            log(f"ntfy failed: {e}")


if __name__ == "__main__":
    main()
