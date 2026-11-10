import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const fail = message => { console.error(`FAIL: ${message}`); process.exitCode = 1; };
let manifest;
try { manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")); }
catch (error) { fail(`manifest.json is not valid JSON: ${error.message}`); process.exit(); }

const exact = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
if (manifest.manifest_version !== 3) fail("manifest_version must be 3");
if (!exact(manifest.permissions || [], ["storage"])) fail("permissions must be exactly storage");
if (!exact(manifest.host_permissions || [], ["https://x.com/*", "https://twitter.com/*", "https://rpc.testnet.near.org/*"])) fail("host_permissions contain an unapproved origin or are incomplete");
if (manifest.background || manifest.web_accessible_resources?.length) fail("background remote-code or exposed resources are not permitted");
if (manifest.content_security_policy?.extension_pages !== "script-src 'self'; object-src 'self'") fail("extension pages must use the local-only script CSP");
if (!Array.isArray(manifest.content_scripts) || manifest.content_scripts.length !== 1) fail("one X-only content script declaration is required");
for (const script of manifest.content_scripts || []) {
  if (!exact(script.matches || [], ["https://x.com/*", "https://twitter.com/*"])) fail("content scripts may run only on X");
  if (!exact(script.js || [], ["lib.js", "content.js"])) fail("content script entry points must be the local extension files");
  for (const file of script.js || []) {
    if (!existsSync(join(dir, file))) fail(`content script file is missing: ${file}`);
  }
}
if (!manifest.action?.default_popup || !existsSync(join(dir, manifest.action.default_popup))) fail("popup file is missing");
for (const file of ["lib.js", "content.js", "popup.js"]) {
  const source = readFileSync(join(dir, file), "utf8");
  const urls = source.match(/https?:\/\/[^\s"'`]+/g) || [];
  for (const url of urls) {
    if (!/^https:\/\/(?:x\.com|twitter\.com|rpc\.testnet\.near\.org|near-cachet\.earn-shield-alerts\.workers\.dev)(?:[/:?#$]|$)/i.test(url)) fail(`${file} contains an unapproved remote endpoint`);
  }
  if (/\beval\s*\(|new\s+Function\s*\(/.test(source)) fail(`${file} contains dynamic code execution`);
}
const popup = readFileSync(join(dir, "popup.html"), "utf8");
if (!/^\s*<script src="lib\.js"><\/script>\s*<script src="popup\.js"><\/script>/m.test(popup)) fail("popup must load its local scripts");
if (/<script\b[^>]*\bsrc=["']https?:\/\//i.test(popup) || /<link\b[^>]*\bhref=["']https?:\/\//i.test(popup)) fail("popup must not load remote code or styles");
if (!existsSync(join(dir, "popup.css"))) fail("popup stylesheet is missing");
if (!process.exitCode) console.log("OK: MV3 manifest, exact permissions, X-only injection, local code and popup paths");
