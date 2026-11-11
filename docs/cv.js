// CV tailor: import a .docx CV, check it against a job posting, edit it in place, optionally tailor it
// with Claude (the user's own API key), and print it to PDF. The CV is stored only in this browser.
const $ = (s, el = document) => el.querySelector(s);
const area = (name) => { try { const a = window[name]; a.getItem("x"); return a; } catch { return null; } };
const LS = area("localStorage"), SS = area("sessionStorage");
const store = {
  get(k, d, a = LS) { try { const v = a && a.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v, a = LS) { try { a.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k, a = LS) { try { a && a.removeItem(k); } catch { /* storage blocked */ } },
};
const K = { master: "cv.master", versions: "cv.versions", scratchJd: "cv.scratchJd", key: "cv.apiKey", model: "cv.model" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rich = (s) => esc(s).replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>"); // CV text keeps bold as **…**
const plain = (s) => String(s ?? "").replace(/\*\*/g, "");
const clone = (o) => JSON.parse(JSON.stringify(o));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase());
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

const params = new URLSearchParams(location.search);
const S = { cv: null, jobKey: params.get("job") || "", job: null, jd: "", ai: null, undo: [], typing: null, memKey: "" };

// ------------------------------------------------------------------ .docx import
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const KNOWN_HEAD = /^(education|(professional |work |relevant )?experience|employment( history)?|internships?|projects?|leadership.*|activities|extra-?curricular.*|skills.*|technical skills|certifications?.*|awards.*|honou?rs.*|languages|publications|research.*|volunteer.*|interests|summary|profile|objective|additional information)$/i;

async function parseDocx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const main = zip.file("word/document.xml");
  if (!main) throw new Error("this isn't a Word .docx file.");
  const doc = new DOMParser().parseFromString(await main.async("string"), "application/xml");
  const all = (el, tag) => [...el.getElementsByTagNameNS(W, tag)];
  const kid = (el, name) => el && [...el.children].find((c) => c.localName === name);
  const val = (el) => el && el.getAttributeNS(W, "val");

  const notes = [];
  if (all(doc, "tbl").length) notes.push("it uses tables, which many ATS read out of order");
  if (all(doc, "txbxContent").length) notes.push("it has text boxes, which many ATS skip");
  if (all(doc, "drawing").length || all(doc, "pict").length) notes.push("it has images or shapes, which ATS ignore");
  if (all(doc, "cols").some((c) => +c.getAttributeNS(W, "num") > 1)) notes.push("it uses columns, which ATS often read in the wrong order");
  for (const name of Object.keys(zip.files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n))) {
    if (/<w:t[ >][^<]*\S/.test(await zip.file(name).async("string"))) { notes.push("it puts text in the page header or footer, which some ATS don't read"); break; }
  }
  const pg = all(doc, "pgSz")[0], mar = all(doc, "pgMar")[0];
  const width = pg ? +pg.getAttributeNS(W, "w") : 12240;
  const page = {
    size: Math.abs(width - 11906) < 200 ? "a4" : "letter",
    margin: mar ? Math.min(1, Math.max(0.3, +mar.getAttributeNS(W, "left") / 1440)) : 0.6,
  };

  const paras = [];
  for (const p of all(doc, "p")) {
    const pPr = kid(p, "pPr");
    const style = val(pPr && all(pPr, "pStyle")[0]) || "";
    let list = !!(pPr && all(pPr, "numPr").length) || /list/i.test(style);
    const segs = [];
    for (const r of all(p, "r")) {
      let up = r.parentNode;
      while (up && up.localName !== "p") up = up.parentNode;
      if (up !== p) continue; // a run in a nested text-box paragraph
      const b = kid(kid(r, "rPr"), "b");
      const bold = !!b && !/^(0|false|off)$/i.test(val(b) || "");
      for (const c of r.children) {
        const t = { t: c.textContent, tab: "\t", br: " ", cr: " ", noBreakHyphen: "-" }[c.localName];
        if (t) segs.push({ t: c.localName === "t" ? c.textContent : t, b: bold && c.localName === "t" });
      }
    }
    if (!segs.some((s) => s.t.trim())) continue;
    const m = !list && segs[0].t.match(/^\s*[•▪◦‣●–-]\s+/);
    if (m) { list = true; segs[0] = { ...segs[0], t: segs[0].t.slice(m[0].length) }; }
    paras.push({ segs, text: segs.map((s) => s.t).join(""), list, style });
  }

  const toRich = (segs) => {
    let out = "", open = false;
    for (const s of segs) {
      const t = s.t.replace(/\t/g, " ");
      if (t.trim() && s.b !== open) { out += "**"; open = s.b; }
      out += t;
    }
    return (open ? out + "**" : out).replace(/\*\*(\s*)\*\*/g, "$1").replace(/[\r\n]+/g, " ").replace(/ {3,}/g, "  ").trim();
  };
  const isUpper = (s) => /\p{Lu}/u.test(s) && s === s.toUpperCase();
  const cv = { version: 1, page, name: "", contact: [], sections: [], notes };
  let sec = null;
  for (const p of paras) {
    const t = p.text.replace(/\s+/g, " ").trim();
    const tab = p.text.indexOf("\t");
    const allBold = p.segs.filter((s) => s.t.trim()).every((s) => s.b);
    if (!cv.name) { // first paragraph: the name, maybe with contact details after a tab
      cv.name = (tab > 0 ? p.text.slice(0, tab) : t).trim();
      const rest = tab > 0 ? p.text.slice(tab + 1).replace(/\t+/g, "  •  ").trim() : "";
      if (rest) cv.contact.push(rest);
      continue;
    }
    const heading = !p.list && tab < 0 && t.length <= 45 &&
      (/heading|title/i.test(p.style) || (allBold && (isUpper(t) || KNOWN_HEAD.test(t))) || (isUpper(t) && KNOWN_HEAD.test(t)));
    if (heading) { sec = { title: t, blocks: [] }; cv.sections.push(sec); continue; }
    if (!sec) { cv.contact.push(p.text.replace(/^\s+/, "").replace(/\t+/g, "  •  ").trim()); continue; }
    const last = sec.blocks[sec.blocks.length - 1];
    if (p.list) {
      if (last && last.bullets) last.bullets.push(toRich(p.segs));
      else sec.blocks.push({ kind: "bullets", bullets: [toRich(p.segs)] });
    } else if (tab > 0) {
      sec.blocks.push({ kind: "entry", title: p.text.slice(0, tab).trim(), right: p.text.slice(tab + 1).replace(/\t+/g, " ").trim(), sub: "", bullets: [] });
    } else if (last && last.kind === "entry" && !last.sub && !last.bullets.length) {
      last.sub = toRich(p.segs);
    } else {
      sec.blocks.push({ kind: "line", text: toRich(p.segs) });
    }
  }
  if (!cv.sections.length) throw new Error("no section headings (like EDUCATION or EXPERIENCE) were found.");
  return cv;
}

// ------------------------------------------------------------------ CV model helpers
function at(path) {
  const ks = path.split(".");
  let o = S.cv;
  for (const k of ks.slice(0, -1)) { if (o == null) return [undefined, k]; o = o[k]; }
  return [o, ks[ks.length - 1]];
}
const getP = (p) => { const [o, k] = at(p); return o == null ? undefined : o[k]; };
const setP = (p, v) => { const [o, k] = at(p); if (o != null) o[k] = v; };

function cvText() {
  const c = S.cv;
  return [c.name, ...c.contact, ...c.sections.flatMap((s) => [s.title, ...s.blocks.flatMap((b) =>
    b.kind === "entry" ? [b.title, b.right, b.sub, ...b.bullets] : b.kind === "bullets" ? b.bullets : [b.text])])].map(plain).join("\n");
}

function save() {
  if (!S.cv) return;
  let ok;
  if (S.jobKey) {
    const all = store.get(K.versions, {});
    all[S.jobKey] = { cv: S.cv, jd: S.jd, ai: S.ai, job: S.job, updated: new Date().toISOString() };
    ok = store.set(K.versions, all);
  } else {
    ok = store.set(K.master, S.cv) && store.set(K.scratchJd, S.jd);
  }
  if (!ok) $("#mode").textContent = "This browser isn't letting the page save, so changes will be lost when you close the tab. Download a backup.";
  renderVersions();
}

function snapshot() {
  S.undo.push(JSON.stringify({ cv: S.cv, ai: S.ai }));
  if (S.undo.length > 40) S.undo.shift();
  $("#undo").disabled = false;
}

// ------------------------------------------------------------------ paper rendering
const ed = (path, kind) => `contenteditable="true" spellcheck="true" data-path="${path}" data-kind="${kind}"`;
const bulletsHtml = (list, path) => `<ul class="cv-bullets">${list.map((t, i) => `<li ${ed(`${path}.bullets.${i}`, "bullet")}>${rich(t)}</li>`).join("")}</ul>`;

function blockHtml(b, path) {
  if (b.kind === "entry") {
    return `<div class="cv-entry"><div class="cv-row"><span class="cv-org" ${ed(path + ".title", "entry")}>${rich(b.title)}</span>` +
      `<span class="cv-right" ${ed(path + ".right", "entry")}>${rich(b.right)}</span></div>` +
      `<div class="cv-sub" ${ed(path + ".sub", "sub")}>${rich(b.sub)}</div>${b.bullets.length ? bulletsHtml(b.bullets, path) : ""}</div>`;
  }
  if (b.kind === "bullets") return `<div class="cv-block">${bulletsHtml(b.bullets, path)}</div>`;
  return `<div class="cv-line" ${ed(path + ".text", "line")}>${rich(b.text)}</div>`;
}

function renderPaper() {
  const paper = $("#paper");
  $("#empty").hidden = !!S.cv;
  paper.hidden = !S.cv;
  $("#pdf").disabled = !S.cv;
  if (!S.cv) { layout(); return; }
  const cv = S.cv;
  paper.classList.toggle("a4", cv.page.size === "a4");
  paper.style.setProperty("--m", cv.page.margin + "in");
  $("#pagestyle").textContent = `@page { size: ${cv.page.size === "a4" ? "A4" : "letter"}; margin: 0; }`;
  $("#pagesize").value = cv.page.size;
  paper.innerHTML =
    `<header class="cv-head"><div class="cv-name" ${ed("name", "head")}>${rich(cv.name)}</div>` +
    `<div class="cv-contact">${cv.contact.map((c, i) => `<div ${ed(`contact.${i}`, "head")}>${rich(c)}</div>`).join("")}</div></header>` +
    cv.sections.map((s, si) => `<section class="cv-sec"><h2 ${ed(`sections.${si}.title`, "section")}>${rich(s.title)}</h2>` +
      s.blocks.map((b, bi) => blockHtml(b, `sections.${si}.blocks.${bi}`)).join("") + "</section>").join("") +
    `<div class="pagebreak" hidden><span>page 2 starts here</span></div>`;
  layout();
}

// Keep each contact line on one line, as in Word. The web font runs a little wider than Word's Garamond,
// so shrink the contact block slightly when a line would wrap, and let it wrap only below 7.5pt.
function fitContact(paper) {
  const c = $(".cv-contact", paper);
  if (!c) return;
  c.style.fontSize = "";
  c.classList.add("oneline");
  const over = () => [...c.children].some((e) => e.scrollWidth > e.clientWidth + 1);
  for (let pt = 8.75; over() && pt >= 7.5; pt -= 0.25) c.style.fontSize = pt + "pt";
  if (over()) { c.classList.remove("oneline"); c.style.fontSize = ""; }
}

function layout() {
  const paper = $("#paper"), wrap = $("#paperwrap");
  if (paper.hidden) { wrap.style.height = ""; $("#fit").textContent = ""; return; }
  paper.style.transform = "none";
  fitContact(paper);
  const pageH = S.cv.page.size === "a4" ? (297 / 25.4) * 96 : 11 * 96;
  const over = paper.scrollHeight - pageH;
  const pb = $(".pagebreak", paper);
  pb.style.top = pageH + "px";
  pb.hidden = over <= 1;
  const fit = $("#fit");
  const lines = Math.ceil(over / 13);
  fit.className = "fit " + (over > 1 ? "over" : "ok");
  fit.textContent = over > 1 ? `Runs onto a 2nd page: trim about ${lines} line${lines > 1 ? "s" : ""}` : "Fits on one page";
  const avail = wrap.clientWidth - 24;
  const scale = Math.min(1, avail / paper.offsetWidth);
  paper.style.transform = `scale(${scale})`;
  paper.style.marginLeft = Math.max(0, (avail - paper.offsetWidth * scale) / 2) + "px";
  wrap.style.height = paper.offsetHeight * scale + 24 + "px";
  if (S.toolEl) placeTools(S.toolEl);
}

// ------------------------------------------------------------------ editing
function serialize(el) {
  let out = "";
  const walk = (node, bold) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) out += bold ? "\u0001" + c.nodeValue + "\u0002" : c.nodeValue;
      else if (c.nodeType === 1) {
        if (c.tagName === "BR") { out += " "; continue; }
        const fw = c.style ? c.style.fontWeight : "";
        walk(c, bold || c.tagName === "B" || c.tagName === "STRONG" || fw === "bold" || +fw >= 600);
      }
    }
  };
  walk(el, false);
  return out.replace(/ /g, " ").replace(/\u0002\u0001/g, "").replace(/\u0001(\s*)\u0002/g, "$1")
    .replace(/[\u0001\u0002]/g, "**").replace(/[\r\n\t]+/g, " ").replace(/ {3,}/g, "  ").trim();
}

const afterEdit = debounce(() => { save(); layout(); updateScore(); renderAI(); }, 250);

const TOOLS = {
  bullet: [["↑", "up"], ["↓", "down"], ["B", "bold"], ["+ Bullet", "addBullet"], ["Delete", "del"]],
  entry: [["↑", "up"], ["↓", "down"], ["+ Bullet", "addBullet"], ["Delete entry", "del"]],
  sub: [["↑", "up"], ["↓", "down"], ["B", "bold"], ["+ Bullet", "addBullet"], ["Delete entry", "del"]],
  line: [["↑", "up"], ["↓", "down"], ["B", "bold"], ["+ Line", "addLine"], ["Delete", "del"]],
  section: [["↑", "up"], ["↓", "down"], ["+ Entry", "addEntry"], ["+ Line", "addLine"], ["Delete section", "del"]],
};

function target(el) {
  const ks = el.dataset.path.split("."), kind = el.dataset.kind;
  if (kind === "bullet") return { list: ks.slice(0, -1).join("."), i: +ks[ks.length - 1], block: ks.slice(0, -2).join(".") };
  if (kind === "section") return { list: "sections", i: +ks[1], sec: ks.slice(0, 2).join(".") };
  const b = ks.slice(0, -1); // entry / sub / line: the block
  return { list: b.slice(0, -1).join("."), i: +b[b.length - 1], block: b.join("."), sec: b.slice(0, 2).join(".") };
}

function act(action, el) {
  if (action === "bold") { document.execCommand("bold"); return; }
  const kind = el.dataset.kind, t = target(el);
  const list = getP(t.list);
  snapshot();
  let focus = null;
  if (action === "up" && t.i > 0) { [list[t.i - 1], list[t.i]] = [list[t.i], list[t.i - 1]]; focus = el.dataset.path.replace(new RegExp(`(^|\\.)${t.i}(\\.[a-z]+)?$`), `$1${t.i - 1}$2`); }
  else if (action === "down" && t.i < list.length - 1) { [list[t.i + 1], list[t.i]] = [list[t.i], list[t.i + 1]]; focus = el.dataset.path.replace(new RegExp(`(^|\\.)${t.i}(\\.[a-z]+)?$`), `$1${t.i + 1}$2`); }
  else if (action === "del") list.splice(t.i, 1);
  else if (action === "addBullet") {
    if (kind === "bullet") { list.splice(t.i + 1, 0, ""); focus = `${t.list}.${t.i + 1}`; }
    else { const b = getP(t.block); b.bullets.push(""); focus = `${t.block}.bullets.${b.bullets.length - 1}`; }
  } else if (action === "addLine") {
    if (kind === "section") { const s = getP(t.sec); s.blocks.push({ kind: "line", text: "" }); focus = `${t.sec}.blocks.${s.blocks.length - 1}.text`; }
    else { list.splice(t.i + 1, 0, { kind: "line", text: "" }); focus = `${t.list}.${t.i + 1}.text`; }
  } else if (action === "addEntry") {
    const s = getP(t.sec);
    s.blocks.push({ kind: "entry", title: "Organisation", right: "Location | Dates", sub: "Role", bullets: [""] });
    focus = `${t.sec}.blocks.${s.blocks.length - 1}.title`;
  } else { S.undo.pop(); return; }
  renderPaper(); save(); updateScore(); renderAI();
  const next = focus && document.querySelector(`[data-path="${focus}"]`);
  if (next) { next.focus(); placeCaretEnd(next); } else hideTools();
}

function placeCaretEnd(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

function showTools(el) {
  const tools = $("#tools"), spec = el && TOOLS[el.dataset.kind];
  if (!spec) { hideTools(); return; }
  S.toolEl = el;
  tools.innerHTML = spec.map(([label, a]) => `<button type="button" data-a="${a}" class="${a === "del" ? "del" : ""}">${label === "B" ? "<b>B</b>" : label}</button>`).join("");
  tools.hidden = false;
  placeTools(el);
}
function placeTools(el) {
  const tools = $("#tools"), wr = $("#paperwrap").getBoundingClientRect(), r = el.getBoundingClientRect();
  let top = r.top - wr.top - tools.offsetHeight - 6;
  if (top < 2) top = r.bottom - wr.top + 6;
  tools.style.top = top + "px";
  tools.style.left = Math.max(4, Math.min(r.left - wr.left, wr.width - tools.offsetWidth - 4)) + "px";
}
function hideTools() { $("#tools").hidden = true; S.toolEl = null; }

// ------------------------------------------------------------------ ATS keyword check
const DICT = `Excel|Microsoft Excel|MS Excel; PowerPoint|Microsoft PowerPoint; VBA|Visual Basic; Python; SQL; MATLAB; Tableau; Power BI|PowerBI;
Bloomberg|Bloomberg Terminal; Capital IQ|CapIQ; FactSet; Refinitiv|Eikon; SAP; Salesforce; Alteryx; Java; C++; JavaScript; programming|programing|coding; machine learning;
data analysis|data analytics|analytics; data visualisation|data visualization; automation|automate|automated|automating; artificial intelligence|AI;
financial modelling|financial modeling|financial model; valuation|valuations; DCF|discounted cash flow; LBO|leveraged buyout;
comparable companies|trading comparables|comps; pitch books|pitch book|pitchbook; due diligence; M&A|mergers and acquisitions|mergers & acquisitions;
IPO|initial public offering; equity capital markets|ECM; debt capital markets|DCM; equity research; fixed income; credit analysis|credit research;
derivatives; foreign exchange|FX; interest rates; commodities; structured products; portfolio management|portfolio managers|portfolio manager;
asset management; wealth management; private banking; private equity; venture capital; hedge fund; investment banking; sales and trading|sales & trading;
market risk; credit risk; operational risk; risk management|risk assessment; compliance; regulatory|regulation; KYC|know your customer;
AML|anti-money laundering|anti money laundering; audit|auditing; accounting; IFRS; HKFRS; GAAP|US GAAP; financial reporting;
financial statements|financial statement; reconciliation|reconciliations|reconcile; budgeting; forecasting; variance analysis; FP&A; treasury;
internal controls|controls; corporate finance; investment research; macroeconomics|macroeconomic|macro; ESG|sustainable investing|sustainability;
quantitative|quant; statistics|statistical; econometrics; time series; research reports|research notes|research report; market research;
industry research; client onboarding|onboarding; client service|client servicing|customer service; CRM; stakeholder management|stakeholders;
project management; process improvement|process improvements; presentation skills|presentations|presenting|presented;
communication skills|communication|communicate; teamwork|team player|collaboration|collaborate; attention to detail|detail-oriented|detail oriented;
problem solving|problem-solving; analytical skills|analytical; time management; leadership; multitasking|multi-task|prioritise|prioritize;
self-starter|self-motivated|initiative; fast-paced; Cantonese; Mandarin|Putonghua; English; Japanese; Korean; French; CFA; FRM; ACCA;
CPA|HKICPA; economics; mathematics; computer science; engineering`
  .split(";").map((g) => g.split("|").map((s) => s.trim()).filter(Boolean)).filter((g) => g.length);
const STOP = new Set(`a about above across after again all also an and any are as at be been being both but by can could did do does during each
either etc for from further had has have having he her here him his how i if in into is it its just may me might more most must my no nor not now
of off on once only or other our out over own per please same she should so some such than that the their them then there these they this those
through to too under until up upon us very via was we were what when where which while who whom why will with within would you your ability able
apply applicant applicants application applications candidate candidates company role position job jobs team teams work working opportunity
opportunities experience experiences year years skill skills strong good excellent great knowledge including include includes related relevant
required requirement requirements preferred plus well new day days time based support provide providing ensure looking join hong kong limited
ltd group bank global business responsibilities responsibility duties key successful nice qualifications qualification minimum least`.split(/\s+/));
const ACR_STOP = new Set("HK HKSAR SAR CV JD EEO USA UK US PRC OR AND THE TO IN OF ON AT AN AS IS IT BE WE OUR YOU LLC LTD PLC CEO HR AM PM ETC ASAP NA II III IV".split(" "));

const norm = (s) => " " + String(s).toLowerCase().replace(/[’‘]/g, "'").replace(/[-/–—]/g, " ").replace(/[^a-z0-9+#&.' ]+/g, " ").replace(/\s+/g, " ").trim() + " ";
const reCache = new Map();
function termRe(term) {
  const t = norm(term).trim().replace(/\.$/, "");
  if (!reCache.has(t)) reCache.set(t, new RegExp(`(?<![a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?(?![a-z0-9])`, "g"));
  return reCache.get(t);
}
const count = (textN, term) => (norm(term).trim() ? (textN.match(termRe(term)) || []).length : 0);

function localKeywords(jd, company) {
  const t = norm(jd), out = [];
  for (const g of DICT) {
    const n = g.reduce((sum, v) => sum + count(t, v), 0);
    if (n) out.push({ term: g[0], variants: g, weight: n > 1 ? 3 : 2, n });
  }
  const coTokens = new Set(norm(company || "").trim().split(" "));
  const known = (x) => out.some((k) => k.variants.some((v) => norm(v) === norm(x) || norm(x).includes(norm(v)) || norm(v).includes(norm(x))));
  const acr = {};
  for (const m of jd.matchAll(/\b[A-Z][A-Z0-9&]{1,5}\b/g)) if (!ACR_STOP.has(m[0])) acr[m[0]] = (acr[m[0]] || 0) + 1;
  // An acronym the dictionary doesn't know counts only if the posting repeats it: one-off ones are usually
  // the employer's group names or credit ratings ("Groupe BPCE", "Moody's: A2"), not skills.
  for (const [a, n] of Object.entries(acr)) if (n >= 2 && !/\d/.test(a) && !coTokens.has(a.toLowerCase()) && !known(a)) out.push({ term: a, variants: [a], weight: 1.5, n });
  const toks = t.trim().split(" "), bi = {};
  for (let i = 0; i < toks.length - 1; i++) {
    const [a, b] = [toks[i].replace(/[.']+$/, ""), toks[i + 1].replace(/[.']+$/, "")];
    if (a.length > 2 && b.length > 2 && !STOP.has(a) && !STOP.has(b) && !/\d/.test(a + b) && !coTokens.has(a) && !coTokens.has(b)) bi[`${a} ${b}`] = (bi[`${a} ${b}`] || 0) + 1;
  }
  Object.entries(bi).filter(([, n]) => n >= 2).sort((x, y) => y[1] - x[1]).slice(0, 10)
    .forEach(([p, n]) => { if (!known(p)) out.push({ term: p, variants: [p], weight: 1, n }); });
  return out.sort((a, b) => b.weight - a.weight || b.n - a.n).slice(0, 30);
}

function keywordList() {
  if (S.ai && S.ai.keywords && S.ai.keywords.length && S.ai.jd === S.jd) {
    return {
      source: "Keywords from Claude's reading of the posting.",
      list: S.ai.keywords.map((k) => ({ term: k.term, variants: [k.term, ...(k.variants || [])], weight: { high: 3, medium: 2, low: 1 }[k.importance] || 2 })),
    };
  }
  return { source: "Keywords picked out of the posting automatically. “Tailor with Claude” gives a sharper list.", list: localKeywords(S.jd, S.job && S.job.company) };
}

function updateScore() {
  const show = (pct, msg) => {
    $("#scoreval").textContent = pct == null ? "–" : pct + "%";
    $("#meterfill").style.width = (pct || 0) + "%";
    $("#meterfill").style.background = pct == null ? "" : pct < 50 ? "var(--warn)" : pct < 75 ? "var(--accent)" : "var(--ok)";
    $("#kwsource").textContent = msg;
  };
  if (!S.cv || !S.jd.trim()) {
    show(null, S.cv ? "Paste the job description to see how well your CV matches it." : "Import your CV to get started.");
    $("#kwmissing").innerHTML = $("#kwcovered").innerHTML = "";
  } else {
    const { list, source } = keywordList();
    const text = norm(cvText());
    let got = 0, total = 0;
    const ok = [], miss = [];
    for (const k of list) {
      total += k.weight;
      if (k.variants.some((v) => count(text, v))) { got += k.weight; ok.push(k); } else miss.push(k);
    }
    show(total ? Math.round((100 * got) / total) : 0, source);
    const chip = (k, cls, title) => `<span class="chip kw ${cls} ${k.weight >= 3 ? "hi" : ""}" title="${esc(title)}">${esc(k.term)}</span>`;
    $("#kwmissing").innerHTML = miss.length ? `<span class="small muted" style="width:100%">Missing from your CV (${miss.length}). Add only what's true:</span>` + miss.map((k) => chip(k, "miss", "Not found in your CV")).join("") : "";
    $("#kwcovered").innerHTML = ok.length ? `<span class="small muted" style="width:100%">Already in your CV (${ok.length}):</span>` + ok.map((k) => chip(k, "ok", "Found in your CV")).join("") : "";
  }
  renderChecks();
}

function renderChecks() {
  const box = $("#checks");
  if (!S.cv) { box.innerHTML = ""; return; }
  const c = S.cv, head = plain([c.name, ...c.contact].join(" ")), titles = c.sections.map((s) => s.title.toLowerCase());
  const entries = c.sections.flatMap((s) => s.blocks.filter((b) => b.kind === "entry"));
  const fits = !$("#fit").classList.contains("over");
  const items = [
    [/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(head), "Email address in the header"],
    [/\+?\d[\d\s()-]{7,}\d/.test(head), "Phone number in the header"],
    [/linkedin\.com/i.test(head), "LinkedIn URL in the header"],
    [titles.some((t) => t.includes("education")), "An “Education” section"],
    [titles.some((t) => /experience|employment|internship/.test(t)), "An “Experience” section with a standard name"],
    [titles.some((t) => t.includes("skill")), "A “Skills” section"],
    [entries.every((b) => /\b(19|20)\d{2}\b|present/i.test(plain(b.right))), "Every entry has dates"],
    [fits, fits ? "Fits on one page" : "Longer than one page; HK internship applications usually expect one"],
    [true, "The PDF is one column of real text with standard headings, which ATS read reliably"],
  ];
  for (const n of c.notes || []) items.push([false, `Your original Word file: ${n}. The PDF from this page avoids that.`]);
  box.innerHTML = items.map(([ok, t]) => `<li class="${ok ? "" : "bad"}">${esc(t)}</li>`).join("");
}

// ------------------------------------------------------------------ Claude
const SDK_URL = "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";
const PRICE = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10] }; // USD per million input / output tokens
class UserError extends Error {}

const SYSTEM = `You tailor a student's CV to one job posting so it gets through applicant tracking systems (ATS) and reads well to recruiters.

Rules for edits:
- Never invent anything: no new employers, roles, tools, skills, numbers, dates, certifications, results or responsibilities. Only reword, reorder or re-emphasise what the line already says.
- Where a line truthfully shows something the posting asks for, use the posting's exact wording for it (for example "financial statement analysis" instead of "reviewed financials"), so keyword searches match.
- Keep every number, metric, proper noun and tool from the original line.
- Keep each revised line within about 10% of the original length so the CV stays on one page.
- Some lines start with a bold lead-in wrapped in ** (for example **Technical: **). Keep it exactly as written.
- Keep the CV's spelling convention, tense and punctuation style. Start bullets with a strong past-tense verb when the original does.
- Only suggest edits that clearly improve the match. Leave lines that are already strong, or unrelated to the posting, alone. Skills lines may be reordered to put what the posting asks for first.
- Give the reason for each edit in one short sentence, and list the posting keywords the edit brings in.

Also return:
- role_focus: one or two sentences on what this posting prioritises.
- keywords: the 15 to 25 terms an ATS search for this posting would most likely use (hard skills, tools, domain knowledge, qualifications, languages, key soft skills), each with a few short variants or abbreviations for matching, and its importance.
- gaps: posting keywords the CV can't truthfully show today, each with one sentence on what the candidate could add if it is true for them (a course, project or tool they used). Skip keywords the edits already cover.`;

const str = { type: "string" };
const obj = (properties) => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const SCHEMA = obj({
  role_focus: str,
  keywords: { type: "array", items: obj({
    term: str,
    variants: { type: "array", items: str },
    importance: { type: "string", enum: ["high", "medium", "low"] },
    category: { type: "string", enum: ["hard skill", "tool", "domain", "soft skill", "qualification", "language"] },
  }) },
  edits: { type: "array", items: obj({ id: str, revised: str, reason: str, keywords_used: { type: "array", items: str } }) },
  gaps: { type: "array", items: obj({ keyword: str, advice: str }) },
});

function aiLines() {
  const lines = [];
  S.cv.sections.forEach((s, si) => s.blocks.forEach((b, bi) => {
    const base = `sections.${si}.blocks.${bi}`, where = b.kind === "entry" ? `${s.title} › ${plain(b.title)}` : s.title;
    if (b.kind === "entry" && plain(b.sub).trim()) lines.push({ path: `${base}.sub`, where: `${where} · subtitle`, text: b.sub });
    if (b.kind === "line" && plain(b.text).trim()) lines.push({ path: `${base}.text`, where, text: b.text });
    (b.bullets || []).forEach((t, k) => { if (plain(t).trim()) lines.push({ path: `${base}.bullets.${k}`, where: `${where} · bullet ${k + 1}`, text: t }); });
  }));
  return lines.map((l, i) => ({ ...l, id: "L" + (i + 1) }));
}

const apiKey = () => S.memKey || store.get(K.key, "", SS) || store.get(K.key, "", LS);
function status(msg, bad) { const el = $("#aistatus"); el.textContent = msg; el.className = "small" + (bad ? " err" : ""); }

async function tailor() {
  const key = apiKey();
  if (!key) return;
  if (!S.cv) { status("Import your CV first.", true); return; }
  if (!S.jd.trim()) { status("Paste the job description first.", true); return; }
  const model = $("#model").value;
  store.set(K.model, model);
  const lines = aiLines();
  const prompt = [
    `<job>\nTitle: ${S.job ? S.job.title : "(not given)"}\nCompany: ${S.job ? S.job.company : "(not given)"}\n\n${S.jd.trim()}\n</job>`,
    `<cv_lines>\n${lines.map((l) => `[${l.id}] {${plain(l.where)}} ${l.text}`).join("\n")}\n</cv_lines>`,
    "Each CV line is shown as [id] {where it sits in the CV} text. Tailor these lines to the job, following the rules. Refer to lines by their id.",
  ].join("\n\n");
  const btn = $("#tailor");
  btn.disabled = true;
  status("Claude is reading the posting and your CV. This usually takes 20–60 seconds…");
  let Anthropic;
  try {
    ({ default: Anthropic } = await import(SDK_URL));
    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    const res = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // if a safety classifier declines, Anthropic retries on its recommended model
      output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
    if (res.stop_reason === "refusal") throw new UserError("Claude declined this request. Remove anything unusual from the job description and try again.");
    if (res.stop_reason === "max_tokens") throw new UserError("Claude's answer was cut off. Try again, or shorten the job description.");
    let out;
    try { out = JSON.parse(res.content.filter((b) => b.type === "text").map((b) => b.text).join("")); }
    catch { throw new UserError("Claude's answer couldn't be read. Please try again."); }
    const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
    S.ai = {
      jd: S.jd, model: res.model, at: new Date().toISOString(),
      role_focus: out.role_focus, keywords: out.keywords, gaps: out.gaps,
      edits: out.edits
        .filter((e) => byId[e.id] && e.revised.trim() && e.revised.trim() !== byId[e.id].text.trim())
        .map((e) => ({ ...e, path: byId[e.id].path, where: byId[e.id].where, original: byId[e.id].text, state: "pending" })),
    };
    save(); renderAI(); updateScore();
    const u = res.usage, [pin, pout] = PRICE[res.model] || PRICE[model];
    const cost = (u.input_tokens * pin + u.output_tokens * pout) / 1e6;
    status(`Done: ${S.ai.edits.length} suggested edit${S.ai.edits.length === 1 ? "" : "s"}. Used ${fmtK(u.input_tokens)} input and ${fmtK(u.output_tokens)} output tokens (about $${cost.toFixed(2)}).`);
  } catch (e) {
    status(aiError(e, Anthropic), true);
  } finally {
    btn.disabled = false;
  }
}

function aiError(e, A) {
  if (e instanceof UserError) return e.message;
  if (!A) return "Couldn't load the Anthropic library. Check your connection and try again.";
  if (e instanceof A.AuthenticationError) return "Anthropic rejected this API key. Check it, or create a new one in the Anthropic Console.";
  if (e instanceof A.PermissionDeniedError) return "This API key isn't allowed to use that model.";
  if (e instanceof A.RateLimitError) return "Rate limit reached. Wait a minute and try again.";
  if (e instanceof A.BadRequestError) return "Anthropic couldn't process the request: " + e.message;
  if (e instanceof A.APIConnectionError) return "Couldn't reach Anthropic. Check your connection and try again.";
  if (e instanceof A.APIError) return `Anthropic returned an error${e.status ? " (" + e.status + ")" : ""}: ${e.message}`;
  return "Something went wrong: " + (e && e.message ? e.message : e);
}

function diffHtml(a, b) {
  const A = a.split(/(\s+)/), B = b.split(/(\s+)/), n = A.length, m = B.length;
  if (n * m > 400000) return `<del>${esc(a)}</del> <ins>${esc(b)}</ins>`;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0, out = "";
  const put = (tag, s) => { out += tag ? `<${tag}>${esc(s)}</${tag}>` : esc(s); };
  while (i < n && j < m) {
    if (A[i] === B[j]) { put("", A[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) put("del", A[i++]);
    else put("ins", B[j++]);
  }
  while (i < n) put("del", A[i++]);
  while (j < m) put("ins", B[j++]);
  return out.replace(/<\/del><del>/g, "").replace(/<\/ins><ins>/g, "");
}

function renderAI() {
  const box = $("#airesult"), ai = S.ai;
  if (!ai) { box.innerHTML = ""; return; }
  const pending = ai.edits.filter((e) => e.state === "pending" && getP(e.path) !== undefined).length;
  box.innerHTML =
    (ai.jd !== S.jd ? `<p class="small err">The job description has changed since this run. Run it again for fresh suggestions.</p>` : "") +
    (ai.role_focus ? `<div class="focus"><b>What this role prioritises:</b> ${esc(ai.role_focus)}</div>` : "") +
    (ai.edits.length
      ? `<div class="row"><b class="small">Suggested edits (${ai.edits.length})</b>${pending > 1 ? `<button class="linkbtn" data-act="all" type="button">Accept all ${pending}</button>` : ""}</div>`
      : `<p class="small">No edits suggested: your lines already match this posting well.</p>`) +
    ai.edits.map((e, i) => {
      // Warnings only matter while the suggestion can still be accepted.
      const open = e.state === "pending", cur = getP(e.path), gone = cur === undefined, changed = !gone && cur !== e.original;
      const note = !open ? "" : gone ? " · this line no longer exists" : changed ? " · you've edited this line since" : "";
      return `<div class="sug ${e.state !== "pending" ? "done" : ""}" data-i="${i}"><div class="where">${esc(plain(e.where))}</div>
        <div class="diff">${diffHtml(plain(e.original), plain(e.revised))}</div>
        <div class="why">${esc(e.reason)}${e.keywords_used && e.keywords_used.length ? " · brings in: " + e.keywords_used.map(esc).join(", ") : ""}${note ? `<span class="err">${note}</span>` : ""}</div>
        ${e.state === "pending"
          ? `<div class="acts">${gone ? "" : `<button class="yes" data-act="accept" type="button">Accept</button>`}<button data-act="dismiss" type="button">Dismiss</button></div>`
          : `<div class="state">${e.state === "accepted" ? "Accepted" : "Dismissed"}</div>`}</div>`;
    }).join("") +
    (ai.gaps && ai.gaps.length ? `<h3 class="h3">Gaps: add these only if they're true for you</h3><ul class="gaps">${ai.gaps.map((g) => `<li><b>${esc(g.keyword)}</b>: ${esc(g.advice)}</li>`).join("")}</ul>` : "");
}

function onSuggestion(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn || !S.ai) return;
  const accept = (s) => { if (getP(s.path) !== undefined) { setP(s.path, s.revised); s.state = "accepted"; } };
  snapshot();
  if (btn.dataset.act === "all") S.ai.edits.filter((s) => s.state === "pending").forEach(accept);
  else {
    const s = S.ai.edits[+btn.closest(".sug").dataset.i];
    if (btn.dataset.act === "accept") accept(s); else s.state = "dismissed";
  }
  renderPaper(); save(); renderAI(); updateScore();
}

// ------------------------------------------------------------------ versions, import, backup
function renderVersions() {
  const all = store.get(K.versions, {});
  const rows = Object.entries(all).sort((a, b) => b[1].updated.localeCompare(a[1].updated));
  const day = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  $("#versions").innerHTML =
    `<li class="${S.jobKey ? "" : "on"}"><a href="cv.html">Master CV</a><span class="when">${store.get(K.master, null) ? "" : "not imported yet"}</span></li>` +
    rows.map(([k, v]) => `<li class="${k === S.jobKey ? "on" : ""}"><a href="cv.html?job=${encodeURIComponent(k)}">${esc(v.job ? `${v.job.company} – ${v.job.title}` : k)}</a>` +
      `<span class="when">${day(v.updated)} <button class="linkbtn danger" data-del="${esc(k)}" type="button" title="Delete this version">✕</button></span></li>`).join("");
}

function renderJob() {
  const j = S.job;
  $("#mode").innerHTML = S.jobKey
    ? `Version tailored for ${j ? `<b>${esc(j.company)}</b> – ${esc(j.title)}` : "a saved job"}`
    : "Your master CV. Press “Tailor CV” on any job in the radar to make a version for it.";
  $("#jobinfo").innerHTML = j
    ? `<b>${esc(j.title)}</b><br>${esc(j.company)}${j.location ? " · " + esc(j.location) : ""}<br><a href="${esc(j.url)}" target="_blank" rel="noopener">Open the posting ↗</a>, copy its description and paste it below.`
    : S.jobKey ? "This job is no longer listed in the radar." : "Paste any job description to check your master CV against it.";
  $("#tomaster").hidden = $("#resetmaster").hidden = !S.jobKey;
  $("#jd").value = S.jd;
}

function renderKey() {
  const k = apiKey();
  $("#keyform").hidden = !!k;
  $("#keyset").hidden = !k;
  if (k) $("#keytail").textContent = "…" + k.slice(-4);
  $("#model").value = store.get(K.model, "claude-opus-5-5");
}

function renderAll() { renderJob(); renderPaper(); renderAI(); renderVersions(); renderKey(); updateScore(); }

async function importDocx(file) {
  if (!file) return;
  let cv;
  try { cv = await parseDocx(await file.arrayBuffer()); }
  catch (e) { alert(`Couldn't read ${file.name}: ${e.message}`); return; }
  if (store.get(K.master, null) && !confirm("Replace your saved master CV with this file? Versions you've already tailored stay as they are.")) return;
  store.set(K.master, cv);
  snapshot();
  if (!S.jobKey || !S.cv || confirm("Also restart this job's version from the new file?")) S.cv = clone(cv);
  save(); renderAll();
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function restore(file) {
  if (!file) return;
  try {
    const b = JSON.parse(await file.text());
    if (!b || typeof b !== "object" || !("master" in b)) throw new Error("not a CV tailor backup");
    if (!confirm("Replace the CV data in this browser with this backup?")) return;
    store.set(K.master, b.master);
    store.set(K.versions, b.versions || {});
    location.reload();
  } catch (e) { alert("Couldn't restore that file: " + e.message); }
}

function printPdf() {
  if (!S.cv) return;
  // drop bullets and lines left empty while editing
  let pruned = false;
  for (const s of S.cv.sections) {
    for (const b of s.blocks) if (b.bullets) { const n = b.bullets.length; b.bullets = b.bullets.filter((t) => plain(t).trim()); pruned = pruned || n !== b.bullets.length; }
    const n = s.blocks.length;
    s.blocks = s.blocks.filter((b) => b.kind !== "line" || plain(b.text).trim());
    pruned = pruned || n !== s.blocks.length;
  }
  if (pruned) { renderPaper(); save(); }
  if (document.activeElement) document.activeElement.blur();
  hideTools();
  const prev = document.title, name = titleCase(plain(S.cv.name));
  document.title = S.job ? `${name} CV - ${S.job.company}` : `${name} CV`; // becomes the PDF's file name
  addEventListener("afterprint", () => { document.title = prev; }, { once: true });
  print();
}

// ------------------------------------------------------------------ wiring
async function init() {
  const versions = store.get(K.versions, {}), master = store.get(K.master, null);
  if (S.jobKey) {
    const v = versions[S.jobKey];
    S.job = v ? v.job : null;
    try {
      const data = await (await fetch("data/openings.json", { cache: "no-store" })).json();
      const j = data.jobs.find((x) => x.key === S.jobKey);
      if (j) S.job = { title: j.title, company: j.company, url: j.url, location: j.location };
    } catch { /* offline: keep the job details saved with the version */ }
    S.cv = v ? v.cv : master && clone(master);
    S.jd = v ? v.jd || "" : "";
    S.ai = v ? v.ai || null : null;
  } else {
    S.cv = master;
    S.jd = store.get(K.scratchJd, "");
  }
  renderAll();
  if (!LS) $("#mode").textContent = "This browser is blocking storage, so your CV won't be kept after you close the tab.";

  const paper = $("#paper");
  paper.addEventListener("input", (e) => {
    const el = e.target.closest("[data-path]");
    if (!el) return;
    if (S.typing !== el) { snapshot(); S.typing = el; } // one undo step per line edited
    setP(el.dataset.path, serialize(el));
    afterEdit();
  });
  paper.addEventListener("keydown", (e) => {
    const el = e.target.closest("[data-path]");
    if (el && e.key === "Enter") { e.preventDefault(); if (el.dataset.kind === "bullet") act("addBullet", el); }
  });
  paper.addEventListener("paste", (e) => {
    e.preventDefault();
    document.execCommand("insertText", false, (e.clipboardData ? e.clipboardData.getData("text/plain") : "").replace(/\s+/g, " "));
  });
  paper.addEventListener("focusin", (e) => showTools(e.target.closest("[data-path]")));
  paper.addEventListener("focusout", () => { S.typing = null; setTimeout(() => { if (!paper.contains(document.activeElement)) hideTools(); }, 150); });
  const tools = $("#tools");
  tools.addEventListener("mousedown", (e) => e.preventDefault()); // keep the caret in the line being edited
  tools.addEventListener("click", (e) => { const b = e.target.closest("[data-a]"); if (b && S.toolEl) act(b.dataset.a, S.toolEl); });

  $("#jd").addEventListener("input", debounce(() => { S.jd = $("#jd").value; save(); updateScore(); renderAI(); }, 300));
  for (const id of ["#docx", "#docx2"]) $(id).addEventListener("change", (e) => { importDocx(e.target.files[0]); e.target.value = ""; });
  $("#pdf").addEventListener("click", printPdf);
  $("#undo").addEventListener("click", () => {
    const s = S.undo.pop();
    if (!s) return;
    const o = JSON.parse(s);
    S.cv = o.cv; S.ai = o.ai;
    renderPaper(); save(); renderAI(); updateScore();
    $("#undo").disabled = !S.undo.length;
  });
  $("#pagesize").addEventListener("change", (e) => { if (!S.cv) return; snapshot(); S.cv.page.size = e.target.value; renderPaper(); save(); updateScore(); });

  $("#savekey").addEventListener("click", () => {
    const v = $("#apikey").value.trim();
    if (!/^sk-ant-/.test(v)) { status("That doesn't look like an Anthropic API key (they start with sk-ant-).", true); return; }
    const remember = $("#remember").checked;
    store.del(K.key, LS); store.del(K.key, SS);
    if (!store.set(K.key, v, remember ? LS : SS)) S.memKey = v;
    $("#apikey").value = "";
    status(remember ? "Key saved in this browser." : "Key kept until you close this tab.");
    renderKey();
  });
  $("#forgetkey").addEventListener("click", () => { store.del(K.key, LS); store.del(K.key, SS); S.memKey = ""; status("Key removed from this browser."); renderKey(); });
  $("#model").addEventListener("change", (e) => store.set(K.model, e.target.value));
  $("#tailor").addEventListener("click", tailor);
  $("#airesult").addEventListener("click", onSuggestion);

  $("#tomaster").addEventListener("click", () => { if (S.cv && confirm("Make this version your master CV? Future tailored versions will start from it.")) { store.set(K.master, clone(S.cv)); renderVersions(); } });
  $("#resetmaster").addEventListener("click", () => {
    const m = store.get(K.master, null);
    if (!m || !confirm("Throw away this version's edits and start again from your master CV?")) return;
    snapshot(); S.cv = clone(m); renderPaper(); save(); renderAI(); updateScore();
  });
  $("#versions").addEventListener("click", (e) => {
    const k = e.target.closest("[data-del]") && e.target.closest("[data-del]").dataset.del;
    if (!k || !confirm("Delete this tailored version?")) return;
    const all = store.get(K.versions, {});
    delete all[k];
    store.set(K.versions, all);
    if (k === S.jobKey) location.href = "cv.html"; else renderVersions();
  });
  $("#backup").addEventListener("click", () => download("cv-tailor-backup.json", JSON.stringify({ master: store.get(K.master, null), versions: store.get(K.versions, {}), exported: new Date().toISOString() }, null, 1), "application/json"));
  $("#restore").addEventListener("change", (e) => { restore(e.target.files[0]); e.target.value = ""; });
  $("#wipe").addEventListener("click", () => {
    if (!confirm("Delete your master CV, every tailored version and your saved API key from this browser? This can't be undone.")) return;
    for (const k of Object.values(K)) { store.del(k, LS); store.del(k, SS); }
    location.href = "cv.html";
  });

  addEventListener("resize", debounce(layout, 100));
  if (document.fonts) document.fonts.ready.then(() => { layout(); renderChecks(); });
}

init();
