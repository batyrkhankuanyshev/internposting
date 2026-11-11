"""Fetchers for each careers-site platform.

Every adapter takes a source dict from companies.json and returns a list of
jobs: {title, location, url, posted, ext_id}. Adapters return *all* candidate
postings they see; filtering to Hong Kong internships happens in run.py.
"""
import html
import json
import re
import time
from urllib.parse import quote, urlencode, urljoin, urlparse

import requests

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0 Safari/537.36"
)
S = requests.Session()
S.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
TIMEOUT = 30

HK_RE = re.compile(
    r"hong\s*kong|\bHK\b|HKSAR|kowloon|quarry bay|tsim sha tsui|admiralty|wan chai|"
    r"causeway bay|cyberport|sha tin|kwun tong|central,? hk|香港",
    re.I,
)
INTERN_RE = re.compile(
    r"\bintern(s|ship|ships)?\b|summer (analyst|associate|intern|programme|program)|"
    r"off[- ]?cycle|industrial placement|placement (year|student|programme|program)|"
    r"spring (week|insight|programme|program)|insight (week|day|programme|program)|"
    r"winter (analyst|intern|programme|program)|\bco-?op\b|vacation (scheme|program)|"
    r"work experience|實習|实习",
    re.I,
)
GRAD_RE = re.compile(
    r"graduate|management trainee|\btrainee\b|analyst program|analyst programme|"
    r"new grad|fresh grad|campus hire|early career|class of 20\d\d|full[- ]time analyst",
    re.I,
)
# Staff who run the programmes, not the programmes themselves.
NOT_ROLE_RE = re.compile(r"recruit(er|ing|ment (manager|lead|partner|specialist))|coordinator|talent acquisition|programme manager|program manager", re.I)


def strip_tags(s):
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or ""))).strip()


def job(title, location, url, posted="", ext_id=""):
    return {
        "title": strip_tags(title),
        "location": strip_tags(location),
        "url": url,
        "posted": posted or "",
        "ext_id": str(ext_id or url),
    }


# --------------------------------------------------------------------------- Workday
def workday_date(text):
    """'Posted 3 Days Ago' -> ISO date; '30+ Days Ago' stays a label."""
    t = (text or "").lower()
    days = 0 if "today" in t else 1 if "yesterday" in t else None
    m = re.search(r"posted (\d+) days? ago", t)
    if m:
        days = int(m.group(1))
    if days is None:
        return "30+ days ago" if "30+" in t else text
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() - days * 86400))


def workday(src):
    u = urlparse(src["url"])
    host, tenant = u.netloc, u.netloc.split(".")[0]
    parts = [p for p in u.path.split("/") if p and not re.fullmatch(r"[a-z]{2}(-[A-Za-z]{2})?", p)]
    site = parts[0]
    api = f"https://{host}/wday/cxs/{tenant}/{site}"
    found = {}
    for q in src.get("queries", ["intern", "internship", "summer analyst", "hong kong"]):
        total, offset = None, 0
        while offset < 200:
            r = S.post(f"{api}/jobs", json={"appliedFacets": {}, "limit": 20, "offset": offset, "searchText": q}, timeout=TIMEOUT)
            r.raise_for_status()
            d = r.json()
            if total is None:
                total = d.get("total", 0)
            for p in d.get("jobPostings", []):
                path = p.get("externalPath", "")
                found[path] = job(p.get("title"), p.get("locationsText", ""), f"https://{host}/en-US/{site}{path}", workday_date(p.get("postedOn", "")), path)
            offset += 20
            if offset >= total:
                break
    # "3 Locations" hides where the job is; ask the detail endpoint for intern-looking ones.
    for path, j in found.items():
        if re.search(r"\d+ Locations", j["location"]) and (INTERN_RE.search(j["title"]) or GRAD_RE.search(j["title"])):
            try:
                info = S.get(f"{api}{path}", timeout=TIMEOUT).json().get("jobPostingInfo", {})
                j["location"] = "; ".join([info.get("location", "")] + info.get("additionalLocations", []))
            except Exception:
                pass
    return list(found.values())


# --------------------------------------------------------------------------- Greenhouse
def greenhouse(src):
    # One API host serves boards from every region (eu/anz job-boards included).
    d = S.get(f"https://boards-api.greenhouse.io/v1/boards/{src['token']}/jobs", timeout=TIMEOUT).json()
    return [
        job(j["title"], (j.get("location") or {}).get("name", ""), j["absolute_url"], j.get("first_published") or j.get("updated_at", ""), j["id"])
        for j in d.get("jobs", [])
    ]


# --------------------------------------------------------------------------- Ashby
def ashby(src):
    d = S.get(f"https://api.ashbyhq.com/posting-api/job-board/{src['token']}", timeout=TIMEOUT).json()
    out = []
    for j in d.get("jobs", []):
        locs = [j.get("location", "")] + [s.get("location", "") for s in j.get("secondaryLocations", [])]
        out.append(job(j["title"], "; ".join(filter(None, locs)), j["jobUrl"], j.get("publishedAt", ""), j.get("id")))
    return out


# --------------------------------------------------------------------------- Lever
def lever(src):
    d = S.get(f"https://api.lever.co/v0/postings/{src['token']}?mode=json", timeout=TIMEOUT).json()
    return [
        job(j["text"], (j.get("categories") or {}).get("location", ""), j["hostedUrl"],
            time.strftime("%Y-%m-%d", time.gmtime(j.get("createdAt", 0) / 1000)), j["id"])
        for j in d
    ]


# --------------------------------------------------------------------------- Oracle Recruiting Cloud
def oracle(src):
    u = urlparse(src["url"])
    site = re.search(r"/sites/([^/?]+)", u.path).group(1)
    found = {}
    for q in src.get("queries", ["intern", "summer analyst", "internship"]):
        finder = f'findReqs;siteNumber={site},keyword="{q}",limit=100,sortBy=POSTING_DATES_DESC'
        r = S.get(
            f"https://{u.netloc}/hcmRestApi/resources/latest/recruitingCEJobRequisitions",
            params={"onlyData": "true", "expand": "requisitionList.secondaryLocations", "finder": finder},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        for item in r.json().get("items", []):
            for p in item.get("requisitionList", []):
                locs = [p.get("PrimaryLocation", "")] + [s.get("Name", "") for s in p.get("secondaryLocations", [])]
                found[p["Id"]] = job(p["Title"], "; ".join(filter(None, locs)),
                                     f"https://{u.netloc}/hcmUI/CandidateExperience/en/sites/{site}/job/{p['Id']}",
                                     p.get("PostedDate", ""), p["Id"])
    return list(found.values())


# --------------------------------------------------------------------------- Eightfold
def eightfold(src):
    host = urlparse(src["url"]).netloc
    found = {}
    for q in src.get("queries", ["intern", "summer analyst", "internship"]):
        for start in range(0, 100, 10):
            r = S.get(f"https://{host}/api/pcsx/search",
                      params={"domain": src["domain"], "query": q, "location": "Hong Kong", "start": start},
                      headers={"Accept": "application/json"}, timeout=TIMEOUT)
            r.raise_for_status()
            pos = (r.json().get("data") or {}).get("positions", [])
            for p in pos:
                url = urljoin(f"https://{host}/", p.get("positionUrl") or f"/careers/job/{p['id']}")
                posted = time.strftime("%Y-%m-%d", time.gmtime(p["postedTs"])) if p.get("postedTs") else ""
                found[p["id"]] = job(p.get("name", ""), "; ".join(p.get("locations") or []), url, posted, p["id"])
            if len(pos) < 10:
                break
    return list(found.values())


# --------------------------------------------------------------------------- SuccessFactors career sites (RMK)
def rmk(src):
    base = src["url"].rstrip("/")
    out = {}
    for q in src.get("queries", ["intern", "internship", "summer"]):
        for start in range(0, 125, 25):
            t = S.get(f"{base}/search/", params={"q": q, "locationsearch": src.get("location", "Hong Kong"), "startrow": start}, timeout=TIMEOUT).text
            rows = re.findall(r'<tr class="data-row.*?</tr>', t, re.S)
            for row in rows:
                a = re.search(r'<a href="([^"]+)" class="jobTitle-link[^"]*"[^>]*>(.*?)</a>', row, re.S)
                if not a:
                    continue
                loc = re.search(r'class="jobLocation[^"]*"[^>]*>(.*?)</span>', row, re.S)
                date = re.search(r'class="jobDate[^"]*"[^>]*>(.*?)</span>', row, re.S)
                url = urljoin(base + "/", a.group(1))
                out[url] = job(a.group(2), loc.group(1) if loc else "", url, strip_tags(date.group(1)) if date else "")
            if len(rows) < 25:
                break
    return list(out.values())


# --------------------------------------------------------------------------- Oleeo (*.tal.net) job boards
def talnet(src):
    t = S.get(src["url"], timeout=TIMEOUT).text
    out = {}
    for m in re.finditer(r'<a[^>]+href="([^"]*/opp/\d+[^"]*)"[^>]*>(.*?)</a>', t, re.S):
        url = urljoin(src["url"], html.unescape(m.group(1)))
        title = strip_tags(m.group(2))
        if not title or url in out:
            continue
        # The board row usually carries location text right after the link, before the next one.
        tail = t[m.end(): m.end() + 800].split("<a ", 1)[0]
        out[url] = job(title, strip_tags(tail)[:160], url, "", re.search(r"/opp/(\d+)", url).group(1))
    return list(out.values())


# --------------------------------------------------------------------------- PageUp (RSS)
def pageup(src):
    t = S.get(src["url"], timeout=TIMEOUT).text
    out = []
    for item in re.findall(r"<item>(.*?)</item>", t, re.S):
        g = lambda tag: (re.search(rf"<{tag}>(.*?)</{tag}>", item, re.S) or [None, ""])[1]
        title = strip_tags(g("title").replace("<![CDATA[", "").replace("]]>", ""))
        out.append(job(title, src.get("default_location", "Hong Kong"), strip_tags(g("link")), strip_tags(g("pubDate"))))
    return out


# --------------------------------------------------------------------------- Phenom career sites
def phenom(src):
    base = src["url"].rstrip("/")
    out = {}
    for q in src.get("queries", ["intern", "summer analyst"]):
        t = S.get(f"{base}/search-results", params={"keywords": q, "location": "Hong Kong"}, timeout=TIMEOUT).text
        key = '"eagerLoadRefineSearch":'
        i = t.find(key)
        if i < 0:
            raise RuntimeError("phenom: search payload not found")
        data = json.JSONDecoder().raw_decode(t, i + len(key))[0].get("data", {})
        for j in data.get("jobs", []):
            loc = j.get("location") or ", ".join(filter(None, [j.get("city"), j.get("country")]))
            locs = "; ".join([loc] + [str(x) for x in (j.get("multi_location") or [])])
            url = j.get("applyUrl") or f"{base}/job/{j.get('jobId')}"
            out[j.get("jobId") or url] = job(j.get("title", ""), locs, url, (j.get("postedDate") or "")[:10], j.get("jobId"))
    return list(out.values())


# --------------------------------------------------------------------------- Workable
def workable(src):
    d = S.get(f"https://apply.workable.com/api/v1/widget/accounts/{src['token']}", timeout=TIMEOUT).json()
    return [
        job(j["title"], ", ".join(filter(None, [j.get("city"), j.get("country")])), j.get("url") or j.get("shortlink"), j.get("published_on", ""), j.get("shortcode"))
        for j in d.get("jobs", [])
    ]


# --------------------------------------------------------------------------- BambooHR
def bamboohr(src):
    d = S.get(f"https://{src['token']}.bamboohr.com/careers/list", headers={"Accept": "application/json"}, timeout=TIMEOUT).json()
    out = []
    for j in d.get("result", []):
        loc = j.get("location") or {}
        out.append(job(j.get("jobOpeningName", ""), ", ".join(filter(None, [loc.get("city"), loc.get("state")])),
                       f"https://{src['token']}.bamboohr.com/careers/{j['id']}", "", j["id"]))
    return out


# --------------------------------------------------------------------------- Amazon
def amazon(src):
    d = S.get("https://www.amazon.jobs/en/search.json",
              params={"base_query": "intern", "loc_query": "Hong Kong", "result_limit": 100}, timeout=TIMEOUT).json()
    return [job(j["title"], j.get("normalized_location") or j.get("location", ""), "https://www.amazon.jobs" + j["job_path"], j.get("posted_date", ""), j.get("id_icims"))
            for j in d.get("jobs", [])]


# --------------------------------------------------------------------------- Jane Street
def janestreet(src):
    d = S.get("https://www.janestreet.com/jobs/main.json", timeout=TIMEOUT).json()
    out = []
    for j in d:
        loc = {"HKG": "Hong Kong", "NYC": "New York", "LDN": "London", "SGP": "Singapore", "AMS": "Amsterdam"}.get(j.get("city"), j.get("city", ""))
        title = j.get("position", "")
        if j.get("availability") and j["availability"].lower() not in title.lower():
            title = f"{title} ({j['availability']})"
        out.append(job(title, loc, f"https://www.janestreet.com/join-jane-street/position/{j['id']}/", "", j["id"]))
    return out


# --------------------------------------------------------------------------- University scheme pages
def scheme_page(url):
    """A scheme page that says "(Updated on 9 November 2026)" next to a "Job List" link
    (the list itself sits behind the student login). Returns the date, link and intake."""
    r = S.get(url, timeout=TIMEOUT)
    r.raise_for_status()
    text = strip_tags(r.text)
    m = re.search(r"Updated on\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})", text)
    if not m:
        raise RuntimeError("bot check page, not the scheme page" if "Incapsula" in r.text or len(r.text) < 2000 else "no 'Updated on' date on the page")
    updated = time.strftime("%Y-%m-%d", time.strptime(re.sub(r"\s+", " ", m.group(1)), "%d %B %Y"))
    link = re.search(r'<a[^>]+href="([^"]+)"[^>]*>(?:\s|<[^>]+>)*Job List(?:\s|<[^>]+>)*</a>', r.text)
    intake = re.search(r"\(([^()]*Intake)\)", text)
    job_list = quote(urljoin(url, html.unescape(link.group(1))), safe=":/?#&=%+") if link else ""  # the href has raw spaces
    return {"updated": updated, "job_list_url": job_list,
            "intake": intake.group(1).strip() if intake else ""}


ADAPTERS = {
    "workday": workday, "greenhouse": greenhouse, "ashby": ashby, "lever": lever, "oracle": oracle,
    "eightfold": eightfold, "rmk": rmk, "talnet": talnet, "pageup": pageup, "phenom": phenom,
    "workable": workable, "bamboohr": bamboohr, "amazon": amazon, "janestreet": janestreet,
}


# --------------------------------------------------------------------------- LinkedIn (public guest search)
LI_SEARCH = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
LI_POSTING = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/"
HK_GEO = "103291313"


def _li_get(url, params=None, log=print, max_wait=240):
    """GET with polite pacing; LinkedIn answers 429 when we go too fast."""
    waited = 0
    while True:
        r = S.get(url, params=params, timeout=TIMEOUT)
        if r.status_code != 429:
            time.sleep(4)
            return r
        if waited >= max_wait:
            raise RuntimeError("LinkedIn rate limit did not clear")
        log(f"    linkedin 429, backing off 20s (waited {waited}s)")
        time.sleep(20)
        waited += 20


def linkedin_search(keywords, period, max_results, log=print):
    out = {}
    for start in range(0, max_results, 10):
        r = _li_get(LI_SEARCH, {"keywords": keywords, "location": "Hong Kong SAR", "geoId": HK_GEO,
                                "f_TPR": period, "start": start}, log)
        if r.status_code != 200:
            log(f"    linkedin status {r.status_code} at start={start}")
            break
        cards = re.findall(r"<li>(.*?)</li>", r.text, re.S)
        if not cards:
            break
        for c in cards:
            u = re.search(r'href="(https://[a-z]+\.linkedin\.com/jobs/view/[^"?]+)', c)
            if not u:
                continue
            jid = re.search(r"-(\d{8,})/?$", u.group(1)) or re.search(r"(\d{8,})", u.group(1))
            t = re.search(r'base-search-card__title">(.*?)</h3>', c, re.S)
            co = re.search(r'base-search-card__subtitle">(.*?)</h4>', c, re.S)
            loc = re.search(r'job-search-card__location">(.*?)</span>', c, re.S)
            d = re.search(r'datetime="([^"]+)"', c)
            out[jid.group(1)] = {
                "title": strip_tags(t.group(1)) if t else "",
                "company": strip_tags(co.group(1)) if co else "",
                "location": strip_tags(loc.group(1)) if loc else "Hong Kong SAR",
                "url": f"https://www.linkedin.com/jobs/view/{jid.group(1)}/",
                "posted": d.group(1) if d else "",
                "ext_id": jid.group(1),
            }
    return out


def linkedin_is_closed(ext_id, log=print):
    r = _li_get(LI_POSTING + ext_id, log=log, max_wait=60)
    if r.status_code == 404:
        return True
    return r.status_code == 200 and "No longer accepting applications" in r.text
