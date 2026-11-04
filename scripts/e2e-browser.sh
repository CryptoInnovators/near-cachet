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
       b"addEventListener('error',function(e){__errs.push('error: '+e.message)});"
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
ev() { "${B[@]}" use "$TAB" >/dev/null; "${B[@]}" eval "$1" | jq -r '.value'; }      # eval JS, raw value
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
  local e; e="$(ev "JSON.stringify(window.__errs||['__errs missing'])")"
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

RPC="${E2E_RPC:-https://test.rpc.fastnear.com}"
CONTRACT="${E2E_CONTRACT:-cachet.testnet}"
MEMPOOL="${E2E_MEMPOOL:-https://mempool.space/testnet/api}"
jp() { ev "$1"; }
txt() { jp "document.getElementById('$1').innerText.replace(/\\s+/g,' ')"; }

# Independent P2WPKH derivation of what the page claims to derive in the browser:
# signer derived_public_key -> secp256k1 point -> compressed -> HASH160 -> bech32 v0 (python stdlib only).
derive() { # token -> address
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
print(hrp + "1" + "".join(C[x] for x in d + [(pol >> 5 * (5 - i)) & 31 for i in range(6)]))
PY
}

cfg="$(rpc_view "$RPC" "$CONTRACT" config '{}')"
SIGNER="$(jq -r .signer_id <<<"$cfg")"; HRP="$(jq -r .hrp <<<"$cfg")"; LC="$(jq -r .btc_light_client <<<"$cfg")"

start_server
open_page "index.html?network=testnet&contract=$CONTRACT&token=1"
waitjs "document.querySelector('#keys-meta').innerText.includes('read at NEAR block') && document.querySelector('#note-meta').innerText.includes('read at NEAR block') && document.querySelector('#address-meta').innerText.includes('read at NEAR block') && /Bitcoin tip \\d+/.test(document.getElementById('address-body').innerText)" 120

for tok in 1 2; do
  if [ "$tok" = 2 ]; then
    # journey: type another token id, press "Read live"
    ev "(()=>{const t=document.getElementById('token-input');t.value='2';t.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('read-button').click();return 1})()" >/dev/null
    waitjs "document.getElementById('note-meta').innerText.includes('note(\"2\")') && document.getElementById('address-body').innerText.includes('cachet/2/0')" 90
  fi
  want_addr="$(derive "$tok")"
  [ "$(txt address-body | grep -o "$want_addr" | head -1)" = "$want_addr" ] || fail "[token $tok] page does not show the independently derived address $want_addr: $(txt address-body | head -c 300)"
  pass "[token $tok] page shows independently derived address $want_addr"
  # note record: page agrees with the contract (null -> no-note state, else the state word)
  note="$(rpc_view "$RPC" "$CONTRACT" note "{\"token_id\":\"$tok\"}")"
  if [ "$note" = null ]; then
    case "$(txt note-body)" in *"No note at token id $tok"*) pass "[token $tok] contract returns null, page says no note";; *) fail "[token $tok] chain note is null but page shows: $(txt note-body | head -c 200)";; esac
  else
    for f in state owner_id; do v="$(jq -r ".$f // .owner // empty" <<<"$note")"; [ -z "$v" ] || case "$(txt note-body)" in *"$v"*) ;; *) fail "[token $tok] note $f '$v' missing from page";; esac; done
    pass "[token $tok] note record fields match the contract"
  fi
  # bitcoin activity for that address == mempool.space
  act="$(curl -sf -m 30 "$MEMPOOL/address/$want_addr")"
  body="$(txt address-body)"
  fmt() { python3 -c 'import sys;print(f"{int(sys.argv[1]):,}")' "$1"; }
  for pair in "RECEIVED:$(jq -r '.chain_stats.funded_txo_sum + .mempool_stats.funded_txo_sum' <<<"$act")" "SPENT:$(jq -r '.chain_stats.spent_txo_sum + .mempool_stats.spent_txo_sum' <<<"$act")"; do
    lab="${pair%%:*}"; sats="$(fmt "${pair#*:}")"
    case "$body" in *"$lab $sats sats"*) pass "[token $tok] $lab $sats sats matches mempool.space";; *) fail "[token $tok] $lab: want '$sats sats' in page: $body";; esac
  done
  eq "[token $tok] bitcoin tx count" "$(grep -o 'TRANSACTIONS [0-9,]*' <<<"$body" | head -1 | tr -dc 0-9)" "$(jq -r '.chain_stats.tx_count + .mempool_stats.tx_count' <<<"$act")"
done

# trust inputs and keys are read from the chain, not typed in
trust="$(txt trust-body)"
case "$trust" in *"$SIGNER"*"$LC"*) pass "trust inputs name the contract's signer $SIGNER and light client $LC";; *) fail "trust panel does not match config: $trust";; esac
lc_page="$(grep -o 'LIGHT-CLIENT HEIGHT [0-9,]*' <<<"$trust" | tr -dc 0-9)"
lc_chain="$(rpc_view "$RPC" "$LC" get_last_block_height '{}' | jq -r .)"
[ "$lc_page" -le "$lc_chain" ] && [ $((lc_chain - lc_page)) -lt 30 ] || fail "light-client height page $lc_page vs chain $lc_chain"
pass "light-client height page $lc_page vs chain $lc_chain"
nkeys="$(rpc "$RPC" query "{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$CONTRACT\"}" | jq '.keys|length')"
if [ "$nkeys" = 0 ]; then
  case "$(txt keys-body)" in *"No access keys on this account"*) pass "keyless contract: page lists 0 access keys";; *) fail "chain has 0 keys, page shows: $(txt keys-body | head -c 200)";; esac
else
  eq "access key rows" "$(jp "document.querySelectorAll('#keys-body li, #keys-body tbody tr').length")" "$nkeys"
fi
# read blocks are live
pb="$(txt note-meta | grep -o 'NEAR block [0-9]*' | tr -dc 0-9)"
head="$(rpc "$RPC" block '{"finality":"final"}' | jq -r .header.height)"
[ "$pb" -le "$head" ] && [ $((head - pb)) -lt 3000 ] || fail "page block $pb not near head $head (fixture?)"
pass "page read at live testnet block $pb (head $head)"
assert_no_errors
echo "PASS cachet browser e2e"
