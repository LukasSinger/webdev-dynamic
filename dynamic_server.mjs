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

const db = new Database("monuments.sqlite3", { readonly: true, fileMustExist: true });
// Usage example: db.prepare("SELECT * FROM monuments WHERE states == ?").all("Maine")

let app = express();
app.use(express.static(root));

app.get("/", (req, res) => {
    sendRender("index.html", res, { PAGE_TITLE: "Home" });
});

app.get("/president", (req, res) => {
    /** @type object[] */
    const data = db.prepare("SELECT * FROM monuments").all();
    data.sort(sortNewToOld);
    res.redirect("/president/" + data[0].pres_or_congress);
});

app.get("/president/:pres_id", (req, res) => {
    const PRES_ID = req.params.pres_id;
    /** @type object[] */
    const data = db.prepare("SELECT * FROM monuments WHERE pres_or_congress == ?").all(PRES_ID);
    data.sort(sortNewToOld);
    // Add table header
    let content = "<table><tr><th>Name</th><th>Original Name</th><th>States</th><th>Agency</th><th>Action</th><th>Date</th><th>Acres</th></tr>";
    // Add table rows
    for (const row of data) {
        content += `<tr><td>${row.current_name}</td>`;
        content += `<td>${row.original_name}</td>`;
        content += `<td>${row.states}</td>`;
        content += `<td>${row.current_agency}</td>`;
        content += `<td>${row.action}</td>`;
        content += `<td>${row.date}</td>`;
        content += `<td>${row.acres_affected}</td></tr>`;
    }
    content += "</table>";
    sendRender("president.html", res, { PAGE_TITLE: PRES_ID, CONTENT: content });
});

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

/**
 * Renders and sends an HTML template through the provided Response.
 * @param {string} url The URL to the base HTML template.
 * @param {express.Response} res The Response to send the rendered template through.
 * @param {Object} replaceObj An object with replacement data. The keys correspond to the template strings to be replaced.
 *                            Example: { REPLACEME: "data" } would substitute $$$REPLACEME$$$ with "data".
 */
function sendRender(url, res, replaceObj) {
    fs.readFile(path.join(template, url), async (err, data) => {
        if (err) {
            // Error (likely 404)
            res.setHeader("Status", 404);
            res.setHeader("Content-Type", "text/html");
            res.end("Page not found (404)");
        } else {
            // Success
            let html = data.toString();
            replaceObj.NAV = nav;
            for (const key in replaceObj) {
                html = html.replaceAll(`$$$${key}$$$`, replaceObj[key]);
            }
            res.setHeader("Status", 200);
            res.setHeader("Content-Type", "text/html");
            res.end(html);
        }
        console.log(`${new Date().toISOString()}\t${res.getHeader("Status")}\t${url}`);
    });
}
