# Cachet demand discovery log

## Decision

Close the named-user and judge/host-ask lines before the 2026-11-01 to 2026-11-14 build window. Count only outside people whose own words describe walletless gifting, a durable small Bitcoin gift, or bearer-note handoff. Keep adjacent and rival-builder evidence separate.

## Blank seeds

- bitcoin gift by link without custody
- send bitcoin without wallet address
- physical bitcoin card transfer ownership complaint
- Cashu custodial mint alternative bearer bitcoin
- pre-existing wallet bitcoin gift
- Bitcoin bearer transfer HN Reddit Product Hunt

## Tools and routes

- Exa CLI: search attempted; keyless rate limit reached, fallback to Parallel. Exa fetch attempted for the HN evidence URL; fallback to Parallel.
- RivalSearch MCP over curl: initialized with JSON-RPC and called `social_search` for Reddit, Hacker News, and Product Hunt. HN results yielded candidate threads. Reddit and Product Hunt yielded no usable person evidence.
- Parallel MCP over curl: initialized and called `web_search` and `web_fetch`; used for Exa fallback and exact HN extraction.
- Jina Reader: opened the HN pages and HN profile pages. Direct Reddit and Jina Reddit fetches returned login or 403.
- HN Algolia API: used to locate comment IDs, dates, authors, and full comment text. Original HN pages were then opened with Jina.
- X: targeted search produced no usable outside exact-fit user. No X quote counted.
- Papers: `papers search "Bitcoin bearer transfer ownership protocol NFT UTXO"` returned no results from OpenAlex, arXiv, or Semantic Scholar.

## Read source set

1. HN item 29544092, throwaway413.
2. HN item 33326086, dogweather.
3. HN item 31656296, basisword.
4. HN item 8050189, IamJohnGalt.
5. HN item 31653726, Bitcoin Note thread.
6. HN item 29547412, jameshart.
7. HN profiles for throwaway413, dogweather, basisword, IamJohnGalt, ccamrobertson, and Aaronstotle.
8. NEAR Chain Signatures TEE announcement, 2026-10-23.
9. KOT.CASH independent TEE analysis, 2026-10-28.
10. NEAR Chain Signatures docs.
11. NEAR Chain Signatures implementation docs.
12. NEAR Intents 1Click API docs.
13. Cashu official site.
14. Fold Bitcoin Gift Card page.
15. Gemini gifting page.
16. Swan Bitcoin gifts page.
17. Spark Cashu comparison.
18. HN item 6945153, rival gifting builder.
19. HN item 5468994, PaperCoin project discussion.

## Coverage

| Lane | Result |
| --- | --- |
| Exact-fit people | 3 counted: throwaway413, dogweather, basisword |
| Adjacent people | IamJohnGalt, mgraczyk, jameshart |
| Rival builders excluded | ccamrobertson, spenvo, shazow |
| Reddit | searched, blocked by login or 403 for full fetch; no count |
| HN | full pages and profiles opened |
| Product Hunt | searched, no usable exact-fit person |
| X | searched, no usable exact-fit person |
| Official sources | NEAR docs and blog opened |
| Papers | existing `docs/PRIOR-ART.md` plus failed fresh search |
| Missing mirror plan files | WEDGE-GTM.md and DEMAND.md absent at requested paths |

## Unresolved

The three exact-fit records are dated HN posts by people who asked for this job in their own words. Outreach in `docs/OUTREACH.md` addresses each of them during the build window.
