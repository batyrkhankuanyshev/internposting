(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const state = { kind: store.get("kind", "internship"), tab: "mine", marks: store.get("marks", {}) };
  let data, prevVisit;

  const SOURCE_LABEL = { linkedin: "LinkedIn", workday: "Workday", greenhouse: "Greenhouse", oracle: "Oracle",
    eightfold: "Eightfold", rmk: "SuccessFactors", talnet: "Oleeo", pageup: "PageUp", phenom: "Phenom",
    ashby: "Ashby", workable: "Workable", bamboohr: "BambooHR", amazon: "amazon.jobs", janestreet: "janestreet.com", lever: "Lever" };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ago = (iso) => {
    const d = (Date.now() - new Date(iso)) / 1000;
    if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`;
    if (d < 86400) return `${Math.round(d / 3600)} h ago`;
    return `${Math.round(d / 86400)} d ago`;
  };
  const fmtPosted = (p) => {
    if (!p) return "";
    if (/^\d{4}-\d{2}-\d{2}/.test(p)) return "posted " + new Date(p).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    return p.toLowerCase().startsWith("30+") ? "posted 30+ days ago" : "posted " + p;
  };
  const isNew = (j) => j.first_seen > prevVisit && j.first_seen > data.meta.first_run_at;
  const fmtDay = (d) => new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const schemeNew = (s) => (s.changed_at || "") > prevVisit;

  function passes(j, q) {
    if (state.kind !== "all" && j.kind !== state.kind) return false;
    if ($("#newonly").checked && !isNew(j)) return false;
    if (!$("#showhidden").checked && state.marks[j.key] === "hidden") return false;
    if (q && !`${j.company} ${j.title} ${j.location}`.toLowerCase().includes(q)) return false;
    return true;
  }

  function jobLi(j) {
    const li = document.createElement("li");
    const mark = state.marks[j.key];
    li.className = "job" + (mark ? " " + mark : "");
    const badges = (isNew(j) ? '<span class="badge new">NEW</span>' : "") + (j.kind === "graduate" ? '<span class="badge grad">GRAD</span>' : "");
    const meta = [j.location, fmtPosted(j.posted), "via " + (SOURCE_LABEL[j.source] || j.source)].filter(Boolean).map(esc).join(" · ");
    const li2 = j.linkedin_url ? ` · <a href="${esc(j.linkedin_url)}" target="_blank" rel="noopener">LinkedIn</a>` : "";
    li.innerHTML = `<div><div class="t">${badges}<a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.title)}</a></div>
      <div class="m">${meta}${li2}</div></div>
      <div class="acts"><a class="tailor" href="cv.html?job=${encodeURIComponent(j.key)}" title="Tailor your CV to this posting">Tailor CV</a>
      <button data-mark="applied" class="${mark === "applied" ? "on" : ""}" title="Mark as applied">✓ Applied</button>
      <button data-mark="hidden" class="${mark === "hidden" ? "on" : ""}" title="Hide this posting">Hide</button></div>`;
    li.querySelectorAll("button[data-mark]").forEach((b) => b.addEventListener("click", () => {
      const m = b.dataset.mark;
      if (state.marks[j.key] === m) delete state.marks[j.key]; else state.marks[j.key] = m;
      store.set("marks", state.marks);
      render();
    }));
    return li;
  }

  function schemeCard(s) {
    const el = document.createElement("article");
    el.className = "card scheme";
    const check = s.ok
      ? `Checked automatically ${ago(s.checked_at)}.`
      : `The automatic check ${ago(s.checked_at)} was stopped by the university's bot check, so this is the date last confirmed on ${s.confirmed_at ? fmtDay(s.confirmed_at.slice(0, 10)) : "the page"}. Open the scheme page to see if it has changed.`;
    el.innerHTML = `<div class="chead"><div><h3 class="cname">${esc(s.name)}</h3><span class="chip">University scheme</span></div>
      <div class="clinks">${s.job_list_url ? `<a class="btn" href="${esc(s.job_list_url)}" target="_blank" rel="noopener">Job List ↗</a>` : ""}
      <a class="btn ghost" href="${esc(s.url)}" target="_blank" rel="noopener">Scheme page ↗</a></div></div>
      <p class="sline">${schemeNew(s) ? '<span class="badge new">UPDATED</span>' : ""}Job list updated <b>${s.updated ? esc(fmtDay(s.updated)) : "–"}</b>${s.intake ? " · " + esc(s.intake) : ""}</p>
      <p class="note">${esc(s.org)}. ${esc(s.note)}</p>
      <p class="note">${esc(check)}</p>`;
    return el;
  }

  function renderMine(q, cat) {
    const panel = $("#mine");
    panel.replaceChildren();
    for (const s of data.schemes || []) {
      if (cat || state.kind === "graduate" || ($("#newonly").checked && !schemeNew(s))) continue;
      if (q && !`${s.name} ${s.org}`.toLowerCase().includes(q)) continue;
      panel.append(schemeCard(s));
    }
    const byCo = {};
    for (const j of data.jobs) if (j.company_id && passes(j, q)) (byCo[j.company_id] ||= []).push(j);
    const cos = data.companies.filter((c) => !cat || c.category === cat);
    const hiring = cos.filter((c) => byCo[c.id]).sort((a, b) => byCo[b.id].length - byCo[a.id].length || a.name.localeCompare(b.name));
    const quiet = cos.filter((c) => !byCo[c.id] && (!q || c.name.toLowerCase().includes(q)));
    const tpl = $("#tpl-company");
    for (const c of hiring) {
      const el = tpl.content.firstElementChild.cloneNode(true);
      $(".cname", el).textContent = c.name;
      $(".ccat", el).textContent = c.category || "";
      $(".careers", el).href = c.careers_url;
      $(".li", el).href = c.linkedin_search;
      $(".note", el).textContent = c.link_note || "";
      const ul = $(".jobs", el);
      byCo[c.id].sort((a, b) => (isNew(b) - isNew(a)) || b.first_seen.localeCompare(a.first_seen)).forEach((j) => ul.append(jobLi(j)));
      panel.append(el);
    }
    if (!hiring.length) panel.insertAdjacentHTML("beforeend", '<div class="empty">No openings match these filters.</div>');
    if (!$("#hiring").checked && quiet.length) {
      const box = document.createElement("div");
      box.className = "card quiet";
      box.innerHTML = `<h4>No current ${state.kind === "all" ? "" : state.kind + " "}openings found (${quiet.length})</h4>` +
        quiet.map((c) => `<a href="${esc(c.careers_url)}" target="_blank" rel="noopener" title="${esc(c.link_note || c.category)}">${esc(c.name)}</a>`).join("");
      panel.append(box);
    }
    $("#n-mine").textContent = `(${hiring.reduce((n, c) => n + byCo[c.id].length, 0)})`;
  }

  function renderOther(q) {
    const panel = $("#other");
    const jobs = data.jobs.filter((j) => !j.company_id && passes(j, q));
    $("#n-other").textContent = `(${jobs.length})`;
    if (!jobs.length) { panel.innerHTML = '<div class="empty">No openings match these filters.</div>'; return; }
    const groups = {};
    for (const j of jobs) (groups[j.company] ||= []).push(j);
    panel.replaceChildren();
    const intro = document.createElement("p");
    intro.className = "muted";
    intro.style.margin = "0";
    intro.textContent = "Hong Kong listings from LinkedIn at companies that aren't in your tracker – useful for spotting firms to add.";
    panel.append(intro);
    for (const [co, list] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      const card = document.createElement("article");
      card.className = "card company";
      card.innerHTML = `<div class="chead"><h3 class="cname">${esc(co)}</h3></div><ul class="jobs"></ul>`;
      list.forEach((j) => $(".jobs", card).append(jobLi(j)));
      panel.append(card);
    }
  }

  function renderHealth() {
    const rows = data.sources.map((s) => `<tr><td>${esc(s.company)}</td><td>${esc(SOURCE_LABEL[s.type] || s.type)}</td>
      <td class="${s.ok ? "okc" : "fail"}">${s.ok ? "OK" : "Failed"}</td><td class="num">${s.ok ? s.seen : ""}</td><td class="num">${s.ok ? s.hk : ""}</td>
      <td class="muted">${esc(s.error || "")}</td></tr>`).join("");
    const m = data.meta;
    $("#health").innerHTML = `<div class="card"><p style="margin-top:0">LinkedIn sweep: ${m.linkedin_last_ok ? "last succeeded " + ago(m.linkedin_last_ok) : "not run yet"}
      ${m.linkedin_period ? " (window: past " + (m.linkedin_period === "r604800" ? "week" : "month") + ")" : ""}. Companies without a readable careers site are covered by LinkedIn only.</p>
      <div class="tablewrap"><table><thead><tr><th>Company</th><th>Platform</th><th>Status</th><th class="num">Postings scanned</th><th class="num">HK matches</th><th>Error</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>`;
  }

  function renderStats() {
    const mine = data.jobs.filter((j) => j.company_id);
    const interns = mine.filter((j) => j.kind === "internship");
    const cos = new Set(interns.map((j) => j.company_id));
    const fresh = mine.filter(isNew).length + (data.schemes || []).filter(schemeNew).length;
    $("#stats").innerHTML = [
      [interns.length, "HK internships at your companies"],
      [cos.size, "companies hiring interns"],
      [data.jobs.filter((j) => !j.company_id && j.kind === "internship").length, "at other companies"],
      [fresh, "new since last visit", "new"],
    ].map(([n, l, c]) => `<div class="stat ${c || ""}"><b>${n}</b><span>${l}</span></div>`).join("");
    $("#updated").textContent = `Updated ${ago(data.meta.generated_at)} · ${data.companies.length} companies tracked · refreshes every 6 hours`;
  }

  function render() {
    const q = $("#q").value.trim().toLowerCase();
    const cat = $("#cat").value;
    renderStats();
    renderMine(q, cat);
    renderOther(q);
    document.querySelectorAll(".seg button").forEach((b) => b.classList.toggle("on", b.dataset.kind === state.kind));
  }

  function setTab(t) {
    state.tab = t;
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    for (const id of ["mine", "other", "health", "alerts"]) $("#" + id).hidden = id !== t;
  }

  async function init() {
    try {
      data = await (await fetch("data/openings.json", { cache: "no-store" })).json();
    } catch {
      $("#updated").textContent = "No data yet – the first scan hasn't finished.";
      return;
    }
    prevVisit = store.get("lastVisit", new Date(Date.now() - 3 * 86400e3).toISOString());
    store.set("lastVisit", data.meta.generated_at);

    const cats = [...new Set(data.companies.map((c) => c.category).filter(Boolean))].sort();
    $("#cat").insertAdjacentHTML("beforeend", cats.map((c) => `<option>${esc(c)}</option>`).join(""));
    document.querySelectorAll(".seg button").forEach((b) => b.addEventListener("click", () => { state.kind = b.dataset.kind; store.set("kind", state.kind); render(); }));
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
    ["#q", "#cat", "#hiring", "#newonly", "#showhidden"].forEach((s) => $(s).addEventListener("input", render));
    renderHealth();
    render();
  }
  init();
})();
