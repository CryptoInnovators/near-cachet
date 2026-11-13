#!/usr/bin/env bash
# Browser E2E through the `deepsurge` bhn profile. Serves web/ locally, drives the
# page like a judge, and compares what the DOM shows with a direct RPC read.
# Page errors are captured by a script injected into every served HTML page.
# Needs: bhn (profile deepsurge), python3, curl, jq. Opens one tab, closes it on exit.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="${E2E_WEB:-$ROOT/web}"
B=(bhn deepsurge)
TMP="$(mktemp -d)"
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')"
TAB=""
SRV=""
cleanup() {
  [ -n "$TAB" ] && "${B[@]}" close "$TAB" >/dev/null 2>&1 || true
  [ -n "$SRV" ] && { kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; } || true
  rm -rf "$TMP"
}
trap cleanup EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "ok: $*"; }
for t in bhn python3 curl jq; do command -v "$t" >/dev/null || fail "missing tool: $t"; done

cat >"$TMP/serve.py" <<'PY'
import http.server, os, re, sys
INJ = (b"<script>window.__errs=[];"
       b"addEventListener('error',function(e){__errs.push('error: '+e.message+' @'+(e.filename||''))});"
       b"addEventListener('unhandledrejection',function(e){__errs.push('rejection: '+(e.reason&&e.reason.message||e.reason))})</script>")
BASE = http.server.SimpleHTTPRequestHandler
if os.environ.get("E2E_BASE_HANDLER"):  # a repo's own server module with a Handler class (e.g. an API proxy)
    sys.path.insert(0, sys.argv[2]); BASE = __import__(os.environ["E2E_BASE_HANDLER"]).Handler
class H(BASE):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header("Cache-Control", "no-store"); super().end_headers()
    def do_GET(self):
        if self.path.startswith(os.environ.get("E2E_PASS_PREFIX", "\0")): return super().do_GET()
        p = self.translate_path(self.path.split("?")[0].split("#")[0])
        if os.path.isdir(p): p = os.path.join(p, "index.html")
        if p.endswith(".html") and os.path.isfile(p):
            b = open(p, "rb").read()
            m = re.search(rb"<head[^>]*>", b, re.I)
            i = m.end() if m else 0
            b = b[:i] + INJ + b[i:]
            self.send_response(200); self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b); return
        super().do_GET()
os.chdir(sys.argv[2])
http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
start_server() { # optional env first: E2E_BASE_HANDLER=<module in web/> E2E_PASS_PREFIX=<path prefix the handler owns>
  python3 "$TMP/serve.py" "$PORT" "$WEB" & SRV=$!
  for _ in $(seq 50); do curl -sf "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 0.1; done
  curl -sf "http://127.0.0.1:$PORT/" >/dev/null || fail "local server did not start"
}

open_page() { # path-with-query; opens a fresh tab, switches to it
  "${B[@]}" open "http://127.0.0.1:$PORT/$1" >/dev/null
  TAB="$("${B[@]}" tabs | jq -r --arg p "127.0.0.1:$PORT" '[.tabs[]|select(.url|contains($p))]|last|.targetId')"
  [ -n "$TAB" ] && [ "$TAB" != null ] || fail "tab did not open"
  "${B[@]}" use "$TAB" >/dev/null
}
# other agents share the profile and may switch the attached tab, so every call re-attaches to ours first
goto_page() { "${B[@]}" use "$TAB" >/dev/null; "${B[@]}" goto "http://127.0.0.1:$PORT/$1" >/dev/null; }  # same tab, new document (fresh __errs)
# the profile is shared: another agent can re-attach it between our `use` and `eval`, so the expression only runs
# when the attached page is ours (port guard) and is retried after re-attaching otherwise
ev() {
  local out i
  for i in 1 2 3 4 5 6 7 8; do
    "${B[@]}" use "$TAB" >/dev/null
    out="$("${B[@]}" eval "(location.port==='$PORT'?($1):'__WRONG_TAB__')" | jq -r '.value')"
    [ "$out" != __WRONG_TAB__ ] && { printf '%s\n' "$out"; return 0; }
    sleep 0.3
  done
  return 1
}      # eval JS, raw value
evj() { ev "JSON.stringify($1)"; }                  # eval JS expr, JSON out
waitjs() { # JS predicate, timeout seconds
  local end=$((SECONDS + ${2:-60}))
  while [ "$SECONDS" -lt "$end" ]; do
    [ "$(ev "!!($1)" 2>/dev/null || true)" = true ] && return 0
    sleep 1
  done
  fail "timeout waiting for: $1"
}
eq() { [ "$2" = "$3" ] || fail "$1: page shows '$2', chain says '$3'"; pass "$1 = $2"; }
nonempty() { [ -n "$2" ] && [ "$2" != null ] || fail "$1 is empty"; }
assert_no_errors() {
  # errors raised by browser extensions in the shared profile (source chrome-extension://) are not the page's
  local e; e="$(ev "JSON.stringify((window.__errs||['__errs missing']).filter(m=>!/@chrome-extension:\\/\\//.test(m)))")"
  [ "$e" = "[]" ] || fail "uncaught page errors: $e"
  pass "zero uncaught page exceptions"
}
rpc_view() { # rpc_url contract method args-json -> JSON result on stdout
  local body i
  body="$(jq -nc --arg a "$2" --arg m "$3" --arg g "$(printf %s "$4" | base64 | tr -d '\n')" \
    '{jsonrpc:"2.0",id:1,method:"query",params:{request_type:"call_function",finality:"final",account_id:$a,method_name:$m,args_base64:$g}}')"
  for i in 1 2 3 4; do
    if curl -sf -m 20 -X POST "$1" -H 'content-type: application/json' -d "$body" \
      | python3 -c 'import sys,json;r=json.load(sys.stdin);assert "error" not in r and "error" not in r["result"],r;sys.stdout.write(bytes(r["result"]["result"]).decode())' 2>/dev/null; then return 0; fi
    sleep 2
  done
  fail "rpc view $2.$3 failed on $1"
}
rpc() { # rpc_url method params-json -> .result JSON
  local i
  for i in 1 2 3 4; do
    curl -sf -m 20 -X POST "$1" -H 'content-type: application/json' \
      -d "$(jq -nc --arg m "$2" --argjson p "$3" '{jsonrpc:"2.0",id:1,method:$m,params:$p}')" \
      | jq -ce '.result // empty' && return 0
    sleep 2
  done
  fail "rpc $2 failed on $1"
}

RPC="${E2E_RPC:-https://near-testnet.drpc.org}"
CONTRACT="${E2E_CONTRACT:-cachet.testnet}"
MEMPOOLS="${E2E_MEMPOOL:-https://mempool.space/testnet/api https://blockstream.info/testnet/api}"
explorer() { # path -> body from the first Esplora-compatible explorer that answers (mempool.space, then its blockstream twin)
  local base
  for base in $MEMPOOLS; do curl -sf -m 15 "$base$1" && return 0; done
  return 1
}
jp() { ev "$1"; }
txt() { jp "document.getElementById('$1').innerText.replace(/\\s+/g,' ')"; }

# Independent P2WPKH derivation of what the page claims to derive in the browser:
# signer derived_public_key -> secp256k1 point -> compressed -> HASH160 -> bech32 v0 (python stdlib only).
derive() { # token -> "<address> <compressed pubkey hex>"
  local key
  key="$(rpc_view "$RPC" "$SIGNER" derived_public_key "{\"path\":\"cachet/$1/0\",\"predecessor\":\"$CONTRACT\",\"domain_id\":0}" | jq -r .)"
  python3 - "$key" "$HRP" <<'PY'
import sys, hashlib
key, hrp = sys.argv[1].split(":")[1], sys.argv[2]
A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
n = 0
for c in key: n = n * 58 + A.index(c)
raw = n.to_bytes(64, "big")
comp = bytes([2 + (raw[63] & 1)]) + raw[:32]
h160 = hashlib.new("ripemd160", hashlib.sha256(comp).digest()).digest()
C = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def pm(v):
    G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; c = 1
    for x in v:
        b = c >> 25; c = (c & 0x1ffffff) << 5 ^ x
        for i in range(5): c ^= G[i] if (b >> i) & 1 else 0
    return c
def exp(h): return [ord(x) >> 5 for x in h] + [0] + [ord(x) & 31 for x in h]
acc = bits = 0; d = [0]
for b in h160:
    acc = (acc << 8) | b; bits += 8
    while bits >= 5: bits -= 5; d.append((acc >> bits) & 31)
if bits: d.append((acc << (5 - bits)) & 31)
pol = pm(exp(hrp) + d + [0] * 6) ^ 1
print(hrp + "1" + "".join(C[x] for x in d + [(pol >> 5 * (5 - i)) & 31 for i in range(6)]), comp.hex())
PY
}

cfg="$(rpc_view "$RPC" "$CONTRACT" config '{}')"
SIGNER="$(jq -r .signer_id <<<"$cfg")"; HRP="$(jq -r .hrp <<<"$cfg")"; LC="$(jq -r .btc_light_client <<<"$cfg")"

start_server
TOKENS="${E2E_TOKENS:-2 3}"
open_page "index.html?network=testnet&contract=$CONTRACT&token=${TOKENS%% *}"
NT="(id=>document.getElementById(id).innerText.replace(/\\s+/g,' '))"
waitjs "$NT('strip').includes('Read at NEAR block') && /Light client tip [0-9,]+/.test($NT('tiles')) && /Cachet note #/.test($NT('card-slot'))" 120

waitjs "document.body.dataset.ready==='1'" 120
first=1
for tok in $TOKENS; do
  if [ "$first" = 0 ]; then
    # journey: type another token id, press "Read live"
    ev "(()=>{const t=document.getElementById('token-input');t.value='$tok';t.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('read-button').click();return 1})()" >/dev/null
    waitjs "$NT('card-slot').includes('#$tok') && $NT('tiles').includes('cachet/$tok/0')" 90
    waitjs "document.body.dataset.ready==='1'" 120   # every tile has finished reading, not only the key tile
  fi
  first=0
  read -r want_addr want_pub <<<"$(derive "$tok")"
  tiles="$(txt tiles)"
  # the key tile shows the key the page derived in the browser: it must equal the independent derivation
  case "$tiles" in *"$want_pub"*) pass "[token $tok] page shows independently derived key $want_pub";; *) fail "[token $tok] page lacks derived key $want_pub: $(printf %s "$tiles" | head -c 400)";; esac
  case "$tiles" in *"cachet/$tok/0"*) ;; *) fail "[token $tok] page lacks path cachet/$tok/0";; esac
  note="$(rpc_view "$RPC" "$CONTRACT" note "{\"token_id\":\"$tok\"}")"
  card="$(txt card-slot)"
  if [ "$note" = null ]; then
    case "$tiles" in *"holds no note $tok"*) pass "[token $tok] contract returns null, page says no note";; *) fail "[token $tok] chain note is null but page shows: $(printf %s "$tiles" | head -c 200)";; esac
    continue
  fi
  eq "[token $tok] chain address equals independent derivation" "$(jq -r .address <<<"$note")" "$want_addr"
  eq "[token $tok] chain pubkey equals independent derivation" "$(jq -r .pubkey <<<"$note")" "$want_pub"
  # the card shows one plain word: a Sealed note whose claim link is spent reads "Claimed", every other state shows as is
  word="$(jq -r 'if .state == "Sealed" and .claim == null then "Claimed" else .state end' <<<"$note")"
  case "$card" in *"$word"*) ;; *) fail "[token $tok] note state '$(jq -r .state <<<"$note")' (card word '$word') missing from page: $card";; esac
  # the holder is shown as first 8 and last 6 characters of the account id
  owner="$(jq -r .owner_id <<<"$note")"
  case "$card" in *"${owner:0:8}…${owner: -6}"*) ;; *) fail "[token $tok] holder '${owner:0:8}…${owner: -6}' missing from page: $card";; esac
  pass "[token $tok] note state and holder match the contract"
  if [ "$(jq -r '.utxo != null' <<<"$note")" = true ]; then
    ftxid="$(jq -r .utxo.txid <<<"$note")"; fvout="$(jq -r .utxo.vout <<<"$note")"; fsats="$(jq -r .utxo.sats <<<"$note")"; fblock="$(jq -r .utxo.block_hash <<<"$note")"
    # the proof block is a closed <details>, so read its text and links from the DOM, not from innerText
    cardfull="$(jp "(()=>{const c=document.getElementById('card-slot');return (c.textContent+' '+[...c.querySelectorAll('a')].map(a=>a.href).join(' ')).replace(/\\s+/g,' ')})()")"
    case "$cardfull" in *"${ftxid:0:8}…${ftxid: -6}"*"/tx/$ftxid"*|*"/tx/$ftxid"*"${ftxid:0:8}…${ftxid: -6}"*) ;; *) fail "[token $tok] funding txid $ftxid (shown ${ftxid:0:8}…${ftxid: -6}, linked in full) missing from page card: $cardfull";; esac
    case "$tiles" in *"$fblock"*) ;; *) fail "[token $tok] funding block $fblock missing from page tiles";; esac
    # the funding output the page reports is the output the Bitcoin explorer reports
    tx="$(explorer "/tx/$ftxid")"
    eq "[token $tok] explorer funding address" "$(jq -r ".vout[$fvout].scriptpubkey_address" <<<"$tx")" "$want_addr"
    eq "[token $tok] explorer funding sats" "$(jq -r ".vout[$fvout].value" <<<"$tx")" "$fsats"
    eq "[token $tok] explorer funding block" "$(jq -r .status.block_hash <<<"$tx")" "$fblock"
    fmtsats="$(python3 -c 'import sys;print(f"{int(sys.argv[1]):,}")' "$fsats")"
    case "$tiles" in *"$fmtsats sats"*) pass "[token $tok] page shows $fmtsats sats";; *) fail "[token $tok] page lacks '$fmtsats sats': $tiles";; esac
    # spend status read from the explorer, same outpoint
    sp="$(explorer "/tx/$ftxid/outspend/$fvout" | jq -r .spent)"
    if [ "$sp" = false ]; then
      case "$tiles" in *"Verified unspent"*) pass "[token $tok] page says verified unspent, explorer agrees";; *) fail "[token $tok] explorer says unspent, page: $tiles";; esac
    else
      case "$tiles" in *"Spent"*) pass "[token $tok] page says spent, explorer agrees";; *) fail "[token $tok] explorer says spent, page: $tiles";; esac
    fi
  fi
done

# trust inputs and keys are read from the chain, not typed in
tiles="$(txt tiles)"
CONF="$(jq -r .confirmations <<<"$cfg")"
case "$tiles" in *"$SIGNER"*"$LC"*"Confirmations $CONF"*) pass "trust inputs name the contract's signer $SIGNER, light client $LC, $CONF confirmations";; *) fail "trust tile does not match config: $tiles";; esac
lc_page="$(grep -o 'Light client tip [0-9,]*' <<<"$tiles" | head -1 | tr -dc 0-9)"
lc_chain="$(rpc_view "$RPC" "$LC" get_last_block_height '{}' | jq -r .)"
[ "$lc_page" -le "$lc_chain" ] && [ $((lc_chain - lc_page)) -lt 30 ] || fail "light-client height page $lc_page vs chain $lc_chain"
pass "light-client height page $lc_page vs chain $lc_chain"
nkeys="$(rpc "$RPC" query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}" | jq '.keys|length')"
if [ "$nkeys" = 0 ]; then
  case "$tiles" in *"No key can sign for the contract account"*) pass "keyless contract: page says no key can sign";; *) fail "chain has 0 keys, page shows: $tiles";; esac
else
  fail "contract has $nkeys access keys; a Cachet contract must be keyless"
fi
# read blocks are live
pb="$(txt strip | grep -o 'NEAR block [0-9,]*' | head -1 | tr -dc 0-9)"
head="$(rpc "$RPC" block '{"finality":"final"}' | jq -r .header.height)"
[ "$pb" -le "$head" ] && [ $((head - pb)) -lt 3000 ] || fail "page block $pb not near head $head (fixture?)"
pass "page read at live testnet block $pb (head $head)"
assert_no_errors
echo "PASS cachet browser e2e"
