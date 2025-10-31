import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { default as express } from "express";
import Database from "better-sqlite3";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Use Render's port in production
const port = process.env.PORT || 8080;

const root = path.join(__dirname, "public");
const template = path.join(__dirname, "templates");
const nav = fs.readFileSync(path.join(template, "nav.html"), "utf-8");

// Injected into every page as $$$FOUNDATION$$$
const FOUNDATION_SNIPPET = `
<script src="/js/jquery.js"></script>
<script src="/js/what-input.js"></script>
<script src="/js/foundation.js"></script>
<script>$(function(){ $(document).foundation(); });</script>
`;

const db = new Database("monuments.sqlite3", { readonly: true, fileMustExist: true });

// Sort newest → oldest using (year, month/day if present)
function sortNewToOld(a, b) {
  const [mmA, ddA] = String(a.date || "").split("/");
  const [mmB, ddB] = String(b.date || "").split("/");
  const dA = new Date(Number(a.year) || 0, (Number(mmA) || 1) - 1, Number(ddA) || 1).getTime();
  const dB = new Date(Number(b.year) || 0, (Number(mmB) || 1) - 1, Number(ddB) || 1).getTime();
  return dB - dA;
}

function sortOldToNew(a, b) {
  return sortNewToOld(b, a);
}

let app = express();
app.use(express.static(root));

// ---------------- Home ----------------
app.get("/", (req, res) => {
  // Prepare cumulative chart
  /** @type object */
  const data = db.prepare("SELECT date, year FROM monuments WHERE year > 0").all();
  data.sort(sortOldToNew);
  let currentYear = data[0].year - 1;
  let accum = 0;
  let years = [];
  let yearCounts = [];
  for (const entry of data) {
    if (years.length === 0 || years.at(-1) != entry.year) {
      while (currentYear < entry.year) {
        currentYear++;
        years.push(currentYear);
        yearCounts.push(accum);
      }
    }
    accum++;
    yearCounts[yearCounts.length - 1] = accum;
  }
  let chartData = {
    type: "line",
    data: {
      labels: years,
      datasets: [{ label: "Monuments", data: yearCounts }]
    }
  };
  const chart = `new Chart(document.getElementById("data-overview"), ${JSON.stringify(chartData)});`;
  sendRender("index.html", res, { PAGE_TITLE: "Home", CHART: chart });
});

// --------------- President ---------------
// Accept both /president and /president/
app.get(["/president", "/president/"], (req, res) => {
  const all = db.prepare("SELECT * FROM monuments").all();
  const presidents = [...new Set(all.map(r => r.pres_or_congress))]
    .filter(n => !String(n).includes("Congress"))
    .sort();
  if (!presidents.length) return res.status(404).type("text").send("No president data found");
  return res.redirect(`/president/${encodeURIComponent(presidents[0])}`);
});

// Accept both /president/:pres_id and /president/:pres_id/
app.get(["/president/:pres_id", "/president/:pres_id/"], (req, res) => {
  const PRES_ID = decodeURIComponent(req.params.pres_id);

  const data = db.prepare("SELECT * FROM monuments WHERE pres_or_congress = ?").all(PRES_ID);
  if (!data.length) return res.status(404).type("text").send(`Error: no data for president "${PRES_ID}"`);

  data.sort(sortNewToOld);

  const all = db.prepare("SELECT * FROM monuments").all();
  const presidents = [...new Set(all.map(r => r.pres_or_congress))]
    .filter(n => !String(n).includes("Congress"))
    .sort();

  const idx = presidents.indexOf(PRES_ID);
  const prev = presidents[(idx - 1 + presidents.length) % presidents.length];
  const next = presidents[(idx + 1) % presidents.length];

  const last = (PRES_ID.split(" ").at(-1) || "").toLowerCase();
  const IMG = `https://www.loc.gov/static/portals/free-to-use/public-domain/presidential-portraits/99-${last}.jpg`;

  let content = "<table><tr><th>Name</th><th>Original Name</th><th>States</th><th>Agency</th><th>Action</th><th>Date</th><th>Acres</th></tr>";
  for (const r of data) {
    content += `<tr>
      <td>${r.current_name}</td>
      <td>${r.original_name}</td>
      <td>${r.states}</td>
      <td>${r.current_agency}</td>
      <td>${r.action}</td>
      <td>${r.date}</td>
      <td>${r.acres_affected}</td>
    </tr>`;
  }
  content += "</table>";

  const chartLabels = data.map(r => r.year);
  const chartValues = data.map(r => Number(r.acres_affected || 0));

  sendRender("president.html", res, {
    PAGE_TITLE: PRES_ID,
    IMG,
    CONTENT: content,
    PREV_LINK: `/president/${encodeURIComponent(prev)}`,
    NEXT_LINK: `/president/${encodeURIComponent(next)}`,
    CHART_LABELS: JSON.stringify(chartLabels),
    CHART_VALUES: JSON.stringify(chartValues),
  });
});

// ---------------- States ----------------
// Accept both /states and /states/
app.get(["/states", "/states/"], (req, res) => {
  const all = db.prepare("SELECT * FROM monuments").all();
  const states = [...new Set(
    all.flatMap(r => String(r.states || "").split(",").map(s => s.trim()).filter(Boolean))
  )].sort();

  if (!states.length) return res.status(404).send("No state data found");
  return res.redirect(`/state/${encodeURIComponent(states[0])}`);
});

// Accept both /state/:abbr and /state/:abbr/
app.get(["/state/:abbr", "/state/:abbr/"], (req, res) => {
  const abbr = decodeURIComponent(req.params.abbr);
  const data = db.prepare("SELECT * FROM monuments WHERE states LIKE ?").all(`%${abbr}%`);
  if (!data.length) return res.status(404).type("text").send(`Error: no data for state "${abbr}"`);

  data.sort(sortNewToOld);

  const all = db.prepare("SELECT * FROM monuments").all();
  const states = [...new Set(
    all.flatMap(r => String(r.states || "").split(",").map(s => s.trim()).filter(Boolean))
  )].sort();

  const idx = states.indexOf(abbr);
  const prev = states[(idx - 1 + states.length) % states.length];
  const next = states[(idx + 1) % states.length];

  let content = "<table><tr><th>Name</th><th>Original Name</th><th>President/Congress</th><th>Agency</th><th>Action</th><th>Date</th><th>Acres</th></tr>";
  for (const r of data) {
    content += `<tr>
      <td>${r.current_name}</td>
      <td>${r.original_name}</td>
      <td>${r.pres_or_congress}</td>
      <td>${r.current_agency}</td>
      <td>${r.action}</td>
      <td>${r.date}</td>
      <td>${r.acres_affected}</td>
    </tr>`;
  }
  content += "</table>";

  const chartLabels = data.map(r => r.year);
  const chartValues = data.map(r => Number(r.acres_affected || 0));

  sendRender("state.html", res, {
    PAGE_TITLE: `State: ${abbr}`,
    CONTENT: content,
    PREV_LINK: `/state/${encodeURIComponent(prev)}`,
    NEXT_LINK: `/state/${encodeURIComponent(next)}`,
    CHART_LABELS: JSON.stringify(chartLabels),
    CHART_VALUES: JSON.stringify(chartValues),
  });
});

// ---------------- Years ----------------
// Accept both /years and /years/
app.get(["/years", "/years/"], (req, res) => {
  const years = db.prepare("SELECT DISTINCT year FROM monuments ORDER BY year").all().map(r => r.year);
  if (!years.length) return res.status(404).send("No year data found");
  return res.redirect(`/year/${years[0]}`);
});

// Accept both /year/:year and /year/:year/
app.get(["/year/:year", "/year/:year/"], (req, res) => {
  const year = Number(req.params.year);
  const data = db.prepare("SELECT * FROM monuments WHERE year = ?").all(year);
  if (!data.length) return res.status(404).type("text").send(`Error: no data for year ${year}`);

  data.sort(sortNewToOld);

  const years = db.prepare("SELECT DISTINCT year FROM monuments ORDER BY year").all().map(r => r.year);
  const idx = years.indexOf(year);
  const prev = years[(idx - 1 + years.length) % years.length];
  const next = years[(idx + 1) % years.length];

  let content = "<table><tr><th>Name</th><th>Original Name</th><th>States</th><th>Agency</th><th>Action</th><th>Date</th><th>Acres</th></tr>";
  for (const r of data) {
    content += `<tr>
      <td>${r.current_name}</td>
      <td>${r.original_name}</td>
      <td>${r.states}</td>
      <td>${r.current_agency}</td>
      <td>${r.action}</td>
      <td>${r.date}</td>
      <td>${r.acres_affected}</td>
    </tr>`;
  }
  content += "</table>";

  const chartLabels = data.map(r => r.current_name);
  const chartValues = data.map(r => Number(r.acres_affected || 0));

  sendRender("year.html", res, {
    PAGE_TITLE: `Year: ${year}`,
    CONTENT: content,
    PREV_LINK: `/year/${prev}`,
    NEXT_LINK: `/year/${next}`,
    CHART_LABELS: JSON.stringify(chartLabels),
    CHART_VALUES: JSON.stringify(chartValues),
  });
});

// -------------- 404 --------------
app.use((req, res) => res.status(404).type("text").send(`Error 404: "${req.path}" not found`));

// -------------- Start --------------
app.listen(port, (err) => {
  if (err) console.error(err);
  else console.log(`Server started on http://localhost:${port}. Waiting for requests...`);
});

/**
 * Renders and sends an HTML template through the provided Response.
 * @param {string} url The URL to the base HTML template.
 * @param {express.Response} res The Response to send the rendered template through.
 * @param {Object} replaceObj Key/value map of $$$TOKENS$$$ → value
 */

function sendRender(url, res, replaceObj = {}) {
  const filePath = path.join(template, url);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      
      res.status(404).type("text/html").end("Page not found (404)");
      console.log(`${new Date().toISOString()}\t404\t${url}`);
      return;
    }

    let html = data.toString();

    const withDefaults = {
      NAV: nav,
      FOUNDATION: FOUNDATION_SNIPPET,
      PAGE_TITLE: "",
      IMG: "",
      CONTENT: "",
      PREV_LINK: "#",
      NEXT_LINK: "#",
      CHART_LABELS: "[]",
      CHART_VALUES: "[]",
      ...replaceObj,
    };

    for (const key in withDefaults) {
      html = html.replaceAll(`$$$${key}$$$`, withDefaults[key]);
    }

    res.status(200).type("text/html").end(html);
    console.log(`${new Date().toISOString()}\t200\t${url}`);
  });
}
