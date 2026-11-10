# Cachet Telegram bot

Run with Node 22:

```sh
TELEGRAM_BOT_TOKEN=... TELEGRAM_APP_SHORTNAME=... node bot/index.mjs
```

`CACHET_WEB_URL` defaults to the hosted Cachet app. Create and fund Cachet notes, seal them, and create their claim links in the web app. Register each existing link with `/link <note id> <claim URL>`; the bot verifies it against the live testnet contract and associates it with your Telegram account. `/envelope <total-sats> <shares>` selects exactly that many distinct registered notes that are still Sealed with unexpired, matching claim links and whose live sats total matches the request. It posts one inline Mini App claim button per selected note. The links are marked used only after Telegram accepts the message. `/status <note id>` reads the note and final block height from NEAR testnet. `/hongbao` is an alias.

The bot never creates or holds Bitcoin. Linked URLs contain claim secrets and are stored in the ignored `state/links.json` file with owner-only file permissions. Back up or remove that file accordingly.

Run `node --test bot/test/` for bot logic checks and a live read of Cachet note 2 on NEAR testnet.
