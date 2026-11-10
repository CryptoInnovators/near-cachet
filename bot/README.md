# Cachet Telegram bot

Run with Node 22:

```sh
TELEGRAM_BOT_TOKEN=... TELEGRAM_APP_SHORTNAME=... node bot/index.mjs
```

`CACHET_WEB_URL` defaults to the hosted Cachet app. Create and fund a Cachet note, seal it, and create its claim link in the web app. Register the existing link with `/link <note id> <claim URL>`; the bot verifies it against the live testnet contract. `/envelope <sats> [shares]` sends the giver's matching linked note, and `/status <note id>` reads the note and final block height from NEAR testnet. `/hongbao` is an alias.

The bot never creates or holds Bitcoin. Linked URLs contain claim secrets and are stored in the ignored `state/links.json` file with owner-only file permissions. Back up or remove that file accordingly.

Run `node --test bot/test/` for local logic checks and a live read of Cachet note 2 on NEAR testnet.
