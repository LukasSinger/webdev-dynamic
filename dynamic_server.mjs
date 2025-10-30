import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import express from "express";
import Database from "better-sqlite3";

// ---------------------------------------------------------------------
// Paths & setup
// ---------------------------------------------------------------------

// ESM-safe __dirname
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// Change these if your structure is different:
const PUBLIC_DIR = path.join(__dirname, "public");
const TEMPLATES_DIR = path.join(__dirname, "templates");
const DB_PATH = path.join(__dirname, "monuments.sqlite3");

// Port: Render/Heroku uses process.env.PORT; locally we use 8080
const port = process.env.PORT || 8080;

// ---------------------------------------------------------------------
// Open the database (read-only). If file is missing, fail fast.
// ---------------------------------------------------------------------
let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (err) {
  console.error(`\n❌ Could not open database at ${DB_PATH}\n${err}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------
// Create the Express app & static serving
// ---------------------------------------------------------------------
const app = express();

// Serve static assets like /css/style.css, /js/jquery.js, /img/menu.svg
app.use(express.static(PUBLIC_DIR));

// Load the shared navigation template once (injected into every page)
const nav = fs.readFileSync(path.join(TEMPLATES_DIR, "nav.html"), "utf-8");

// Foundation snippet (injected into every page as $$$FOUNDATION$$$)
const FOUNDATION_SNIPPET = `
<script src="/js/jquery.js"></script>
<script src="/js/what-input.js"></script>
<script src="/js/foundation.js"></script>
<script>$(function(){ $(document).foundation(); });</script>
`;

// ---------------------------------------------------------------------
// Tiny SSR helper: read template file, replace $$$TOKENS$$$, send result
// ---------------------------------------------------------------------
function sendRender(fileName, res, replaceObj) {
  const filePath = path.join(TEMPLATES_DIR, fileName);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Template not found → send a friendly 404 HTML
      res
        .status(404)
        .type("text/html")
        .end(
          `Template not found: ${fileName}<br/>Searched at: ${filePath}<br/>` +
          `Tip: make sure your templates are in "${TEMPLATES_DIR}".`
        );
      return;
    }

    // Convert file buffer to string and inject defaults + custom values
    let html = data.toString();
    const withDefaults = {
      NAV: nav,                       // top navigation block
      FOUNDATION: FOUNDATION_SNIPPET, // jQuery + Foundation
      PAGE_TITLE: "",                 // page heading
      IMG: "",                        // optional image URL (presidents page)
      CONTENT: "",                    // the main table HTML
      PREV_LINK: "#",                 // prev item link
      NEXT_LINK: "#",                 // next item link
      CHART_LABELS: "[]",             // Chart.js labels JSON
      CHART_VALUES: "[]",             // Chart.js data JSON
      ...replaceObj,
    };

    for (const key in withDefaults) {
      html = html.replaceAll(`$$$${key}$$$`, withDefaults[key]);
    }

    res.status(200).type("text/html").end(html);
  });
}

// ---------------------------------------------------------------------
// Helper: sort records from newest → oldest by date/year
// - Attempts to build a JS Date from (year, month, day).
// - If month/day are missing, falls back to year only.
// ---------------------------------------------------------------------
function sortNewToOld(a, b) {
  const parse = (r) => {
    const [mm, dd] = String(r.date || "").split("/");
    const y = Number(r.year) || 0;
    const m = Number(mm) || 1;
    const d = Number(dd) || 1;
    return new Date(y, m - 1, d).getTime();
  };
  return parse(b) - parse(a);
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------

// Home: redirect to a dynamic page so users see data immediately
app.get("/", (req, res) => res.redirect("/president"));

/**
 * /president
 * - Find unique list of presidents (excluding "Congress"), sort, go to first.
 */
app.get("/president", (req, res) => {
  const all = db.prepare("SELECT * FROM monuments").all();

  // Unique, filtered, sorted list of presidents
  const presidents = [...new Set(all.map(r => r.pres_or_congress))]
    .filter(name => !String(name).includes("Congress"))
    .sort();

  if (presidents.length === 0) {
    return res.status(404).type("text").send("No president data found");
  }

  res.redirect(`/president/${encodeURIComponent(presidents[0])}`);
});

/**
 * /president/:pres_id
 * - Show all rows for a president (newest → oldest)
 * - Build Prev/Next links (wrap-around)
 * - Provide chart data (years vs acres)
 */
app.get("/president/:pres_id", (req, res) => {
  const PRES_ID = decodeURIComponent(req.params.pres_id);

  // Get the rows for this president
  const data = db
    .prepare("SELECT * FROM monuments WHERE pres_or_congress = ?")
    .all(PRES_ID);

  if (!data.length) {
    return res.status(404).type("text").send(`Error: no data for president "${PRES_ID}"`);
  }

  data.sort(sortNewToOld);

  // Compute full list of presidents to derive prev/next (exclude Congress)
  const all = db.prepare("SELECT * FROM monuments").all();
  const presidents = [...new Set(all.map(r => r.pres_or_congress))]
    .filter(name => !String(name).includes("Congress"))
    .sort();

  const idx = presidents.indexOf(PRES_ID);
  const prev = presidents[(idx - 1 + presidents.length) % presidents.length];
  const next = presidents[(idx + 1) % presidents.length];

  // Optional portrait URL (Library of Congress free-to-use set)
  const last = (PRES_ID.split(" ").at(-1) || "").toLowerCase();
  const IMG = `https://www.loc.gov/static/portals/free-to-use/public-domain/presidential-portraits/99-${last}.jpg`;

  // Build a simple HTML table for this page
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

/**
 * /states
 * - Build a sorted list of all state names mentioned in the "states" column.
 * - Redirect to the first one as a default.
 *
 * NOTE: The dataset uses full state names ("Utah", "Arizona"), not "UT"/"AZ".
 */
app.get("/states", (req, res) => {
  const all = db.prepare("SELECT * FROM monuments").all();

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
 * - Show all rows for monuments whose "states" column contains the given name.
 * - Prev/Next among the list of all states found in the dataset (wrap).
 * - Chart data (years vs acres).
 *
 * Example: /state/Utah   (use full names)
 */
app.get("/state/:abbr", (req, res) => {
  const abbr = decodeURIComponent(req.params.abbr);

  const data = db
    .prepare("SELECT * FROM monuments WHERE states LIKE ?")
    .all(`%${abbr}%`);

  if (!data.length) {
    return res.status(404).type("text").send(`Error: no data for state "${abbr}"`);
  }

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

/**
 * /years
 * - Find all distinct years in the dataset and redirect to the first one.
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
 * - Show all rows for a given year.
 * - Prev/Next among the list of all years found (wrap).
 * - Chart data: monument names vs acres.
 */
app.get("/year/:year", (req, res) => {
  const year = Number(req.params.year);

  const data = db
    .prepare("SELECT * FROM monuments WHERE year = ?")
    .all(year);

  if (!data.length) {
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

  // Chart for the year page: monument names vs acres
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

// ---------------------------------------------------------------------
// Catch-all 404 for unknown routes (e.g., /does-not-exist)
// ---------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).type("text").send(`Error 404: "${req.path}" not found`);
});

// ---------------------------------------------------------------------
// Start the server
// ---------------------------------------------------------------------
app.listen(port, () => {
  console.log(`✅ Server running at http://localhost:${port}`);
  console.log(`    Static:    ${PUBLIC_DIR}`);
  console.log(`    Templates: ${TEMPLATES_DIR}`);
  console.log(`    Database:  ${DB_PATH}`);
});