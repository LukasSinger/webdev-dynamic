import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { default as express } from "express";
import Database from "better-sqlite3";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const port = 8080;
const root = path.join(__dirname, "public");
const template = path.join(__dirname, "templates");
const nav = fs.readFileSync("templates/nav.html", "utf-8");
// Injected into every page as $$$FOUNDATION$$$
const FOUNDATION_SNIPPET = `
<script src="/js/jquery.js"></script>
<script src="/js/what-input.js"></script>
<script src="/js/foundation.js"></script>
<script>$(function(){ $(document).foundation(); });</script>
`;
const db = new Database("monuments.sqlite3", { readonly: true, fileMustExist: true });
// Usage example: db.prepare("SELECT * FROM monuments WHERE states == ?").all("Maine")

// Sort newest → oldest using (year, month/day if present)
function sortNewToOld(a, b) {
  const [mmA, ddA] = String(a.date || "").split("/");
  const [mmB, ddB] = String(b.date || "").split("/");
  const dA = new Date(Number(a.year) || 0, (Number(mmA) || 1) - 1, Number(ddA) || 1).getTime();
  const dB = new Date(Number(b.year) || 0, (Number(mmB) || 1) - 1, Number(ddB) || 1).getTime();
  return dB - dA;
}


let app = express();
app.use(express.static(root));

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
            datasets: [
                {
                    label: "Monuments",
                    data: yearCounts
                }
            ]
        }
    };
    const chart = `new Chart(document.getElementById("data-overview"), ${JSON.stringify(chartData)});`;
    sendRender("index.html", res, { PAGE_TITLE: "Home", CHART: chart });
});

app.get("/president", (req, res) => {
    /** @type object[] */
    const data = db.prepare("SELECT * FROM monuments").all();
    data.sort(sortNewToOld);
    res.redirect("/president/" + data[0].pres_or_congress);
});

app.get("/president/:pres_id", (req, res) => {
  const PRES_ID = decodeURIComponent(req.params.pres_id);

  // All rows for this president
  const data = db.prepare("SELECT * FROM monuments WHERE pres_or_congress = ?").all(PRES_ID);
  if (!data.length) return res.status(404).type("text").send(`Error: no data for president "${PRES_ID}"`);

  data.sort(sortNewToOld);

  // Full list of presidents (exclude "Congress") → Prev/Next
  const all = db.prepare("SELECT * FROM monuments").all();
  const presidents = [...new Set(all.map(r => r.pres_or_congress))]
    .filter(n => !String(n).includes("Congress"))
    .sort();

  const idx = presidents.indexOf(PRES_ID);
  const prev = presidents[(idx - 1 + presidents.length) % presidents.length];
  const next = presidents[(idx + 1) % presidents.length];

  // Optional portrait (template hides it if it fails to load)
  const last = (PRES_ID.split(" ").at(-1) || "").toLowerCase();
  const IMG = `https://www.loc.gov/static/portals/free-to-use/public-domain/presidential-portraits/99-${last}.jpg`;

  // Build table HTML
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

  // Chart data (years vs acres)
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

// /states → compute state list and redirect to the first one
app.get("/states", (req, res) => {
  const all = db.prepare("SELECT * FROM monuments").all();
  const states = [...new Set(
    all.flatMap(r => String(r.states || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean))
  )].sort();

  if (!states.length) return res.status(404).send("No state data found");
  res.redirect(`/state/${encodeURIComponent(states[0])}`);
});

// /state/:abbr → detail page for a given state (use full names like "Utah")
app.get("/state/:abbr", (req, res) => {
  const abbr = decodeURIComponent(req.params.abbr);
  const data = db.prepare("SELECT * FROM monuments WHERE states LIKE ?").all(`%${abbr}%`);
  if (!data.length) return res.status(404).type("text").send(`Error: no data for state "${abbr}"`);

  data.sort(sortNewToOld);

  const all = db.prepare("SELECT * FROM monuments").all();
  const states = [...new Set(
    all.flatMap(r => String(r.states || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean))
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

// /states → compute state list and redirect to the first one
app.get("/states", (req, res) => {
  const all = db.prepare("SELECT * FROM monuments").all();
  const states = [...new Set(
    all.flatMap(r => String(r.states || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean))
  )].sort();

  if (!states.length) return res.status(404).send("No state data found");
  res.redirect(`/state/${encodeURIComponent(states[0])}`);
});

// /state/:abbr → detail page for a given state (use full names like "Utah")
app.get("/state/:abbr", (req, res) => {
  const abbr = decodeURIComponent(req.params.abbr);
  const data = db.prepare("SELECT * FROM monuments WHERE states LIKE ?").all(`%${abbr}%`);
  if (!data.length) return res.status(404).type("text").send(`Error: no data for state "${abbr}"`);

  data.sort(sortNewToOld);

  const all = db.prepare("SELECT * FROM monuments").all();
  const states = [...new Set(
    all.flatMap(r => String(r.states || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean))
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

app.use((req, res) => res.status(404).type("text").send(`Error 404: "${req.path}" not found`));

app.listen(port, (err) => {
    if (err) console.error(err);
    else console.log(`Server started on http://localhost:${port}. Waiting for requests...`);
});

/** Use this as a callback in a sort() function to sort array entries in reverse chronological order. */
function sortNewToOld(a, b) {
    const aParts = a.date.split("/");
    const bParts = b.date.split("/");
    const aDate = new Date(a.year, aParts[0] - 1, aParts[1]); // convert from m/dd format
    const bDate = new Date(b.year, bParts[0] - 1, bParts[1]);
    return bDate.getTime() - aDate.getTime();
}

function sortOldToNew(a, b) {
    return sortNewToOld(b, a);
}

/**
 * Renders and sends an HTML template through the provided Response.
 * @param {string} url The URL to the base HTML template.
 * @param {express.Response} res The Response to send the rendered template through.
 * @param {Object} replaceObj An object with replacement data. The keys correspond to the template strings to be replaced.
 *                            Example: { REPLACEME: "data" } would substitute $$$REPLACEME$$$ with "data".
 */
// REPLACE your entire sendRender with this version
function sendRender(url, res, replaceObj = {}) {
  const filePath = path.join(template, url);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Proper HTTP status + content type
      res.status(404).type("text/html").end("Page not found (404)");
      console.log(`${new Date().toISOString()}\t404\t${url}`);
      return;
    }

    let html = data.toString();

    // Defaults so templates never see "undefined".
    // NOTE: FOUNDATION_SNIPPET should be defined once near the top (see Step 1 you added).
    const withDefaults = {
      NAV: nav,
      FOUNDATION: FOUNDATION_SNIPPET,   // uses /js/jquery.js, /js/what-input.js, /js/foundation.js
      PAGE_TITLE: "",
      IMG: "",
      CONTENT: "",
      PREV_LINK: "#",
      NEXT_LINK: "#",
      CHART_LABELS: "[]",
      CHART_VALUES: "[]",
      ...replaceObj,                    // caller-supplied values override defaults
    };

    // Replace $$$TOKENS$$$ in the HTML
    for (const key in withDefaults) {
      html = html.replaceAll(`$$$${key}$$$`, withDefaults[key]);
    }

    // Proper success status + type
    res.status(200).type("text/html").end(html);
    console.log(`${new Date().toISOString()}\t200\t${url}`);
  });
}
