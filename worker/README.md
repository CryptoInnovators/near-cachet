# Cachet envelope Worker

This module serves the existing `web/` assets and adds live Open Graph pages at `/e/<note id>` plus SVG cards at `/og/<note id>.svg`. It reads `note(token_id)` from `cachet.testnet` on NEAR testnet for every preview request.

`/og/<note id>.png` redirects to the SVG card. PNG rasterization is not bundled, so chat clients should consume the SVG URL advertised by the page.

Browser requests to `/e/<id>` redirect to `/claim?note=<id>` and retain other query parameters. Crawler requests receive the metadata page. The current claim UI uses its URL fragment to identify claim credentials and may choose a judge-pool link when the URL has no fragment.

Run the real RPC and rendering checks from the repository root:

```sh
node --test worker/test/ 2>&1 | tail -5 && test -f worker/wrangler.toml
```
