/**
 * dynamic_server.mjs
 * -------------------
 * A tiny Express web server that:
 *  - Serves static files from /public (CSS, JS, images)
 *  - Uses server-side rendering (SSR) with simple string templates in /templates
 *  - Reads data from an SQLite database (monuments.sqlite3) using better-sqlite3
 *  - Provides 3 dynamic views: by President, by State, by Year
 *  - Adds Previous/Next navigation (wraps around)
 *  - Sends useful 404 errors when something isn't found
 *
 * How the templating works:
 *   Templates contain placeholder tokens like $$$NAV$$$ or $$$PAGE_TITLE$$$.
 *   The server reads the HTML file, replaces the tokens, and sends the result.
 *
 * Run:
 *   npm start
 * or
 *   node dynamic_server.mjs
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import express from "express";
import Database from "better-sqlite3";

// Resolve __dirname for ES Modules
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Use PORT from Render/Heroku/etc. or default to 8080 locally
const port = process.env.PORT || 8080;

// ---------- Paths ----------
const PUBLIC_DIR = path.join(__dirname, "public");
const TEMPLATES_DIR = path.join(__dirname, "templates");
const DB_PATH = path.join(__dirname, "monuments.sqlite3");

// ---------- Database ----------
/**
 * We open the SQLite database in read-only mode.
 * If the file doesn't exist, the server will fail fast with a clear message.
 */
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// ---------- App ----------
const app = express();

// Serve everything in /public at the root, e.g. /css/style.css, /js/jquery.js
app.use(express.static(PUBLIC_DIR));

// Read the nav HTML once and reuse it on every page
const nav = fs.readFileSync(path.join(TEMPLATES_DIR, "nav.html"), "utf-8");

// A small snippet to load jQuery + Foundation and initialize it.
// This gets injected into every page using the $$$FOUNDATION$$$ placeholder.
const FOUNDATION_SNIPPET = `
<script src="/js/jquery.js"></script>
<script src="/js/what-input.js"></script>
<script src="/js/foundation.js"></script>
<script>$(function(){ $(document).foundation(); });</script>
`;

/**
 * Helper: simple server-side template rendering.
 * - fileName: which HTML template in /templates to load
 * - res: Express response object
 * - replaceObj: an object of { PLACEHOLDER_NAME: "value to insert" }
 *   Example: { PAGE_TITLE: "Hello" } will replace $$$PAGE_TITLE$$$ in the HTML.
 */
function sendRender(fileName, res, replaceObj) {
  const filePath = path.join(TEMPLATES_DIR, fileName);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // If the template isn't found, send a clean 404 page
      res.status(404).type("text/html").end("Page not found (404)");
      console.log(`${new Date().toISOString()}\t404\t${fileName}`);
      return;
    }

    // Convert Buffer to string so we can replace tokens
    let html = data.toString();

    // Provide sensible defaults so templates never see "undefined"
    const withDefaults = {
      NAV: nav,
      FOUNDATION: FOUNDATION_SNIPPET,
      PAGE_TITLE: "",
      IMG: "",                 // optional image (used by president page)
      CONTENT: "",             // main table HTML
      PREV_LINK: "#",          // previous item link
      NEXT_LINK: "#",          // next item link
      CHART_LABELS: "[]",      // JSON array string for Chart.js labels
      CHART_VALUES: "[]",      // JSON array string for Chart.js values
      ...replaceObj,
    };

    // Replace $$$PLACEHOLDER$$$ with the provided values
    for (const key in withDefaults) {
      html = html.replaceAll(`$$$${key}$$$`, withDefaults[key]);
    }

    // Send the final HTML
    res.status(200).type("text/html").end(html);
    console.log(`${new Date().toISOString()}\t200\t${fileName}`);
  });
}

/**
 * Helper: sort records newest → oldest.
 * We try to build a real Date from (year, month, day). If month/day are missing,
 * we fall back to just using the year so sorting still makes sense.
 */
function sortNewToOld(a, b) {
  const parse = (r) => {
    // Many rows have date like "MM/DD" or "MM/DD/YYYY". Year is also in r.year.
    const [mm, dd] = String(r.date || "").split("/");
    const y = Number(r.year) || 0;
    const m = Number(mm) || 1; // default to January if missing
    const d = Number(dd) || 1; // default to 1 if missing
    return new Date(y, m - 1, d).getTime();
  };
  return parse(b) - parse(a);
}

// ---------- Home ----------
// Keep your static index if you like; redirecting to /president is also fine.
// We’ll redirect to /president so users immediately see data.
app.get("/", (req, res) => res.redirect("/president"));

// ======================================================================
// =                              PRESIDENTS                            =
// ======================================================================

/**
 * /president
 * Finds the list of presidents who have entries (excluding "Congress") and
 * redirects to the first one alphabetically. This gives a stable default page.
 */
app.get("/president", (req, res) => {
  const all = db.prepare("SELECT * FROM monuments").all();

  // Build a sorted unique list of presidents (filter out "Congress")
  const presidents = [...new Set(all.map(r => r.pres_or_congress))]
    .filter(name => !String(name).includes("Congress"))
    .sort();

  if (presidents.length === 0) {
    return res.status(404).type("text").send("No president data found");
  }

  // Go to the first president (change this if you want a different default)
  res.redirect(`/president/${encodeURIComponent(presidents[0])}`);
});

/**
 * /president/:pres_id
 * Shows all monuments for the given president, newest → oldest.
 * Also builds Previous/Next links that wrap around the list of presidents.
 * Provides data for a Chart.js bar chart (year vs acres).
 */
app.get("/president/:pres_id", (req, res) => {
  const PRES_ID = decodeURIComponent(req.params.pres_id);

  // Get all rows for this president
  const data = db
    .prepare("SELECT * FROM monuments WHERE pres_or_congress = ?")
    .all(PRES_ID);

  if (data.length === 0) {
    // Custom 404 with a helpful message
    return res.status(404).type("text").send(`Error: no data for president "${PRES_ID}"`);
  }

  // Sort newest → oldest using the helper defined above
  data.sort(sortNewToOld);

  // Build full unique list of presidents (exclude Congress) to compute prev/next
  const all = db.prepare("SELECT * FROM monuments").all();
  const presidents = [...new Set(all.map(r => r.pres_or_congress))]
    .filter(name => !String(name).includes("Congress"))
    .sort();

  const idx = presidents.indexOf(PRES_ID);
  const prev = presidents[(idx - 1 + presidents.length) % presidents.length];
  const next = presidents[(idx + 1) % presidents.length];

  // Best-effort portrait URL from Library of Congress (optional).
  // If it 404s, the <img> will hide itself via onerror handler in the template.
  const last = (PRES_ID.split(" ").at(-1) || "").toLowerCase();
  const IMG = `https://www.loc.gov/static/portals/free-to-use/public-domain/presidential-portraits/99-${last}.jpg`;

  // Build a simple HTML table of the data
  let content = "<table><tr><th>Name</th><th>Original Name</th><th>States</th><th>Agency</th><th>Action</th><th>Date</th><th>Acres</th></tr>";
  for (const row of data) {
    content += `<tr>
      <td>${row.current_name}</td>
      <td>${row.original_name}</td>
      <td>${row.states}</td>
      <td>${row.current_agency}</td>
      <td>${row.action}</td>
      <td>${row.date}</td>
      <td>${row.acres_affected}</td>
    </tr>`;
  }
  content += "</table>";

  // Chart data: years on X axis, acres affected as bar heights
  const chartLabels = data.map(r => r.year);
  const chartValues = data.map(r => Number(r.acres_affected || 0));

  // Send the template with all placeholders filled in
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

// ======================================================================
// =                                STATES                              =
// ======================================================================

/**
 * /states
 * Computes a sorted list of all states that appear in the dataset and
 * redirects to the first one. The "states" column uses comma-separated names.
 */
app.get("/states", (req, res) => {
  const all = db.prepare("SELECT * FROM monuments").all();

  // Split "Utah, Arizona" → ["Utah","Arizona"], trim spaces, remove blanks, unique + sort
  const states = [...new Set(
    all.flatMap(r => String(r.states || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean))
  )].sort();

  if (!states.length) {
    return res.status(404).type("text").send("No state data found");
  }

  res.redirect(`/state/${encodeURIComponent(states[0])}`);
});

/**
 * /state/:abbr
 * Shows all monuments that include the given state name (substring match),
 * adds Previous/Next state links, and a chart of acres by year.
 *
 * NOTE: The dataset uses full state names (e.g., "Utah"), not two-letter codes.
 *       So pass "/state/Utah" or "/state/Arizona", not "UT" or "AZ".
 */
app.get("/state/:abbr", (req, res) => {
  const abbr = decodeURIComponent(req.params.abbr);

  // Find rows whose "states" string contains the given name
  const data = db
    .prepare("SELECT * FROM monuments WHERE states LIKE ?")
    .all(`%${abbr}%`);

  if (data.length === 0) {
    return res.status(404).type("text").send(`Error: no data for state "${abbr}"`);
  }

  data.sort(sortNewToOld);

  // Build the state list again to compute prev/next
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

  // Build the table
  let content = "<table><tr><th>Name</th><th>Original Name</th><th>President/Congress</th><th>Agency</th><th>Action</th><th>Date</th><th>Acres</th></tr>";
  for (const row of data) {
    content += `<tr>
      <td>${row.current_name}</td>
      <td>${row.original_name}</td>
      <td>${row.pres_or_congress}</td>
      <td>${row.current_agency}</td>
      <td>${row.action}</td>
      <td>${row.date}</td>
      <td>${row.acres_affected}</td>
    </tr>`;
  }
  content += "</table>";

  // Chart data
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

// ======================================================================
// =                                 YEARS                              =
// ======================================================================

/**
 * /years
 * Finds all distinct years in the dataset and redirects to the first one.
 */
app.get("/years", (req, res) => {
  const years = db
    .prepare("SELECT DISTINCT year FROM monuments ORDER BY year")
    .all()
    .map(r => r.year);

  if (!years.length) {
    return res.status(404).type("text").send("No year data found");
  }

  res.redirect(`/year/${years[0]}`);
});

/**
 * /year/:year
 * Shows all monuments for a specific year and adds Previous/Next year links.
 * Chart: X axis = monument name, Y axis = acres affected that year.
 */
app.get("/year/:year", (req, res) => {
  const year = Number(req.params.year);

  const data = db
    .prepare("SELECT * FROM monuments WHERE year = ?")
    .all(year);

  if (data.length === 0) {
    return res.status(404).type("text").send(`Error: no data for year ${year}`);
  }

  data.sort(sortNewToOld);

  const years = db
    .prepare("SELECT DISTINCT year FROM monuments ORDER BY year")
    .all()
    .map(r => r.year);

  const idx = years.indexOf(year);
  const prev = years[(idx - 1 + years.length) % years.length];
  const next = years[(idx + 1) % years.length];

  // Build the table
  let content = "<table><tr><th>Name</th><th>Original Name</th><th>States</th><th>Agency</th><th>Action</th><th>Date</th><th>Acres</th></tr>";
  for (const row of data) {
    content += `<tr>
      <td>${row.current_name}</td>
      <td>${row.original_name}</td>
      <td>${row.states}</td>
      <td>${row.current_agency}</td>
      <td>${row.action}</td>
      <td>${row.date}</td>
      <td>${row.acres_affected}</td>
    </tr>`;
  }
  content += "</table>";

  // Chart data: names vs acres
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

// ---------- Catch-all 404 for unknown routes ----------
app.use((req, res) => {
  res.status(404).type("text").send(`Error 404: "${req.path}" not found`);
});

// ---------- Start the server ----------
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
