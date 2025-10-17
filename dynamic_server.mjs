import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

import { default as express } from "express";
import Database from "better-sqlite3";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const port = 8080;
const root = path.join(__dirname, "public");
const template = path.join(__dirname, "templates");

const db = new Database("monuments.sqlite3", { readonly: true, fileMustExist: true });
// Usage example: db.prepare("SELECT * FROM monuments WHERE states == ?").all("Maine")

let app = express();
app.use(express.static(root));

app.get("/", (req, res) => {
    sendRender("index.html", res, { PAGE_TITLE: "Home" });
});

app.listen(port, (err) => {
    if (err) console.error(err);
    else console.log(`Server started on http://localhost:${port}. Waiting for requests...`);
});

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
            for (const key in replaceObj) {
                html.replaceAll(`$$$${key}$$$`, replaceObj[key]);
            }
            res.setHeader("Status", 200);
            res.setHeader("Content-Type", "text/html");
            res.end(html);
        }
        console.log(`${new Date().toISOString()}\t${res.getHeader("Status")}\t${url}`);
    });
}
