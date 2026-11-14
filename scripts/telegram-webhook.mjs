// Points the Telegram bot at the worker. Reads TELEGRAM_BOT_TOKEN from .env and the webhook secret from
// ~/.config/cachet/tg-webhook.secret; neither is printed. usage: node scripts/telegram-webhook.mjs [url]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const token = readFileSync(path.join(root, ".env"), "utf8").match(/^TELEGRAM_BOT_TOKEN=["']?([^"'\n]+)/m)?.[1];
const secret = readFileSync(path.join(homedir(), ".config/cachet/tg-webhook.secret"), "utf8").trim();
const url = process.argv[2] || "https://near-cachet.nearbuild.workers.dev/api/telegram";
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not in .env");
const call = async (method, body) => (await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })).json();
console.log("setWebhook", JSON.stringify(await call("setWebhook", { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false })));
const info = (await call("getWebhookInfo")).result;
console.log("webhook", JSON.stringify({ url: info.url, pending: info.pending_update_count, last_error: info.last_error_message || null }));
console.log("me", JSON.stringify({ username: (await call("getMe")).result?.username }));
