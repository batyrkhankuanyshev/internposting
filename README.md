# HK Internship Radar

Tracks Hong Kong internship (and graduate programme) openings at the 214 employers in my job tracker. It refreshes every 6 hours and alerts me when something new appears.

**Live site:** https://batyrkhankuanyshev.github.io/internposting/

## How it works

- `companies.json` lists every company with its careers link, the names it uses on LinkedIn, and the careers-site feeds that can be read directly.
- `scraper/run.py` runs on GitHub Actions (`.github/workflows/scan.yml`) every 6 hours:
  1. **Careers sites**: reads 71 feeds from 66 companies on Workday, Greenhouse, Oracle Recruiting, Eightfold, SuccessFactors, Oleeo (tal.net), PageUp, Phenom, Ashby, Workable and BambooHR, plus amazon.jobs and Jane Street's own feed. It keeps postings whose title looks like an internship (intern, summer/off-cycle, placement, insight week…) or a graduate programme, and whose location is Hong Kong.
  2. **LinkedIn**: searches LinkedIn's public job search for Hong Kong (`intern`, `internship`, `summer analyst`, `off-cycle`, `graduate programme`) and matches each posting's company against the tracker. It covers every company, including those without a readable careers site. It also rechecks older matches and drops any marked "No longer accepting applications".
  3. **University schemes**: reads each page in `schemes.json` (such as CityU's ITC STEM Internship Scheme) for its "Updated on …" date and its "Job List" link. The list itself needs a student login. If the university's bot check blocks the scan, the site keeps showing the last confirmed date and says the check was blocked.
  4. Writes `docs/data/openings.json` and `docs/feed.xml` and commits them. The site in `docs/` reads that JSON.
  5. If any company in the tracker has a new opening, or a scheme's job-list date changes, it opens a GitHub issue that @-mentions the repo owner, which triggers a GitHub email, and optionally sends an [ntfy](https://ntfy.sh) phone push.

## Setup (one time)

1. **Settings → Pages → Build and deployment**: set the source to *Deploy from a branch*, choose `main` and `/docs`.
2. **Actions** tab: enable workflows if asked, then run **Scan HK internships → Run workflow** once.
3. Optional phone push: install the ntfy app, subscribe to a hard-to-guess topic, and add it as the repository secret `NTFY_TOPIC`.

## Editing companies

Add or edit entries in `companies.json`. A `sources` entry is one of:

| type | fields | example |
|---|---|---|
| `workday` | `url` | `https://barclays.wd3.myworkdayjobs.com/External_Career_Site_Barclays` |
| `greenhouse` / `ashby` / `lever` / `workable` / `bamboohr` | `token` | `point72` |
| `oracle` | `url` (a `.../CandidateExperience/en/sites/<SITE>` link) | JPMorgan `CX_1001` |
| `eightfold` | `url`, `domain` | `https://citi.eightfold.ai/careers`, `citi.com` |
| `rmk` | `url` (SuccessFactors career site root) | `https://careers.ey.com` |
| `talnet` | `url` (an Oleeo job board page) | BofA campus board |
| `pageup` | `url` (RSS feed) | BOCHK |
| `phenom` | `url` (site root incl. locale) | `https://jobs.rbc.com/ca/en` |

University scheme pages go in `schemes.json`: `name`, `org`, `url`, `note`, and optionally `seed` (the date and Job List link last confirmed by hand, shown until a scan reads the page).

Run locally with `pip install requests` and then `python scraper/run.py`. Add `--skip-linkedin` for a quick run, or `--only "Barclays"` to test one company.

## Notes

- LinkedIn's guest search is rate-limited. The scanner paces itself (about 5 s between pages, backing off on HTTP 429), and a LinkedIn failure never wipes existing data.
- Some company sites block bots (Cloudflare/Akamai). Their links still open in a normal browser, and LinkedIn covers their openings.
- Applied/hidden marks on the site are stored in your browser only.
