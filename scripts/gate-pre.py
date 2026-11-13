"""Real Telegram run for the Cachet Mini App (laptop only).
Uses the WORK Telethon session from ~/Developer/telegram-mcp/.env. Never prints the session, the claim key or the launch URL.
usage: gate-pre.py LAUNCH_URL_FILE   (writes the signed Mini App launch URL to that 0600 file)
env: CACHET_ORIGIN, CACHET_BOT (default cachet_envelope_bot), CACHET_APP (default envelope), CACHET_GROUP (default cachet-gate)
"""
import asyncio, json, os, re, sys, time
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from telethon import TelegramClient
from telethon.tl import functions, types
from telethon.sessions import StringSession

ORIGIN = os.environ.get("CACHET_ORIGIN", "https://near-cachet.earn-shield-alerts.workers.dev")
BOT = os.environ.get("CACHET_BOT", "cachet_envelope_bot")
APP = os.environ.get("CACHET_APP", "envelope")
GROUP = os.environ.get("CACHET_GROUP", "cachet-gate")
ROOT = Path(__file__).resolve().parent.parent

def env_file(path):
    out = {}
    for line in Path(path).expanduser().read_text().splitlines():
        m = re.match(r"^\s*([A-Z0-9_]+)\s*=\s*(.*)$", line)
        if m: out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out

def log(msg): print(f"[gate-pre {time.strftime('%H:%M:%S')}] {msg}", flush=True)

async def wait_bot(client, group, bot_id, after_id, pattern, timeout=45):
    end = time.time() + timeout
    while time.time() < end:
        for m in await client.get_messages(group, limit=15):
            if m.id > after_id and m.sender_id == bot_id and m.message and re.search(pattern, m.message): return m
        await asyncio.sleep(2)
    raise SystemExit(f"FAIL: the bot did not answer /{pattern}/ within {timeout}s")

async def main(out_file):
    env = env_file("~/Developer/telegram-mcp/.env")
    client = TelegramClient(StringSession(env["TELEGRAM_SESSION_STRING_WORK"]), int(env["TELEGRAM_API_ID"]), env["TELEGRAM_API_HASH"])
    await client.connect()
    if not await client.is_user_authorized(): raise SystemExit("FAIL: the WORK Telegram session is not authorized")
    me = await client.get_me()
    log(f"signed in as Telegram user id {me.id}")
    bot = await client.get_entity(BOT)
    group = None
    async for d in client.iter_dialogs():
        if d.title == GROUP and d.is_group: group = d.entity; break
    if group is None:
        made = await client(functions.channels.CreateChannelRequest(title=GROUP, about="Cachet Mini App gate run", megagroup=True))
        group = made.chats[0]
        log(f"created test group {GROUP}")
    try: await client(functions.channels.InviteToChannelRequest(group, [bot]))
    except Exception as e:
        if "USER_ALREADY_PARTICIPANT" not in str(e): log(f"invite note: {type(e).__name__}")
    links = json.loads((ROOT / "web/judge-links.json").read_text())
    if not links: raise SystemExit("FAIL: web/judge-links.json holds no open note")
    t0 = time.time()
    for pick in links:  # the first note whose claim is still open on chain: the bot refuses a claimed one
        token, sats, fragment = pick["token_id"], int(pick["sats"]), pick["fragment"]
        sent = await client.send_message(group, f"/link {token} {ORIGIN}/claim#{fragment}")
        await wait_bot(client, group, bot.id, sent.id, r"Linked sealed note|Could not complete")
        last = (await client.get_messages(group, limit=1))[0]
        log(f"bot answered /link {token}: " + re.sub(r"[0-9a-f]{64}", "<hex>", last.message)[:100])
        if "Linked sealed note" in last.message: break
    else: raise SystemExit("FAIL: no open heir note in web/judge-links.json")
    sent = await client.send_message(group, f"/envelope {sats} 1")
    reply = await wait_bot(client, group, bot.id, sent.id, r"envelope|Could not")
    button = None
    for row in (reply.reply_markup.rows if reply.reply_markup else []):
        for b in row.buttons:
            if getattr(getattr(b, "type", None), "url", None) and b.text == "Open the red envelope": button = b
    if not button: log("buttons: " + repr([(type(b).__name__, b.text) for row in (reply.reply_markup.rows if reply.reply_markup else []) for b in row.buttons]))
    if not button: raise SystemExit(f"FAIL: the bot message has no 'Open the red envelope' Mini App button: {reply.message[:140]}")
    start = parse_qs(urlparse(button.type.url).query).get("startapp", [None])[0]
    if not start: raise SystemExit("FAIL: the button carries no startapp parameter")
    log(f"bot posted the envelope with the Open the red envelope button in {time.time() - t0:.1f}s (startapp length {len(start)})")
    bot_input = await client.get_input_entity(bot)
    peer = await client.get_input_entity(group)
    res = await client(functions.messages.RequestAppWebViewRequest(
        peer=peer, app=types.InputBotAppShortName(bot_id=bot_input, short_name=APP), platform="web", write_allowed=True, start_param=start))
    url = res.url
    for k, v in (("tgWebAppVersion", "9.2"), ("tgWebAppPlatform", "web")):  # what the Telegram client appends to the launch URL
        if k + "=" not in url: url += f"&{k}={v}"
    fd = os.open(out_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f: f.write(url)
    log(f"signed Mini App launch URL written to a 0600 file (host {urlparse(res.url).netloc}, tgWebAppData present: {'tgWebAppData' in res.url})")
    log(f"note {token}, {sats} sats, telegram user {me.id}")
    await client.disconnect()

asyncio.run(main(sys.argv[1]))
