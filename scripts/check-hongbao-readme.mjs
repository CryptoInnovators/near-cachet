import { readFile } from 'node:fs/promises';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const required = [
  '## Telegram Hongbao',
  'npx wrangler deploy --config worker/wrangler.toml',
  'TELEGRAM_BOT_TOKEN=<BotFather token> TELEGRAM_APP_SHORTNAME=hongbao CACHET_WEB_URL=<Worker URL> node bot/index.mjs',
  'configure a Telegram bot with a Mini App named `hongbao` pointing to the Worker URL',
  'connect a NEAR wallet, create a note, fund its Bitcoin address, wait for confirmation, and attest the funding output until the note is Sealed',
  'Create a claim link for that note in the web app.',
  'register it with `/link <note id> <claim URL>`',
  'share the sealed note using `/envelope <total-sats> <shares>`',
  'The recipient opens the inline button in Telegram\'s Mini App, connects a NEAR wallet, and taps **Claim this gift**.',
  'The Mini App submits the claim and confirms the recipient owns the note.',
];
const missing = required.filter((text) => !readme.includes(text));
if (missing.length) {
  console.error(`Hongbao README is missing ${missing.length} required item(s):\n${missing.map((item) => `- ${item}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Hongbao README check passed (${required.length} required items).`);
}
