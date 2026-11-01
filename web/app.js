const RPC = 'https://rpc.mainnet.fastnear.com';
const SIGNER = 'v1.signer';
function nearblocksLink(a){ return '<a href="https://nearblocks.io/address/' + a + '" target="_blank" rel="noopener">' + a + '</a>'; }
function mempoolLink(a){ return '<a href="https://mempool.space/address/' + a + '" target="_blank" rel="noopener">' + a + '</a>'; }
function setHtml(id, html){ const e = document.getElementById(id); if (e) e.innerHTML = html; }
function setText(id, text){ const e = document.getElementById(id); if (e) e.textContent = text; }

async function rpc(body){
  const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + r.statusText);
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j;
}
function b64(s){ return btoa(unescape(encodeURIComponent(s))); }

function base58Decode(s){
  const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of s){
    const i = ALPH.indexOf(c);
    if (i < 0) throw new Error('bad base58 char');
    n = n * 58n + BigInt(i);
  }
  let zeros = 0;
  for (const c of s){ if (c === '1') zeros++; else break; }
  const bytes = [];
  while (n > 0n){ bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = zeros; i < out.length; i++) out[i] = bytes[i - zeros];
  return out;
}

async function sha256(bytes){
  const h = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(h);
}

function ripemd160(data){
  // ported from ripemd160 npm package
  const zl=[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13];
  const zr=[5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11];
  const sl=[11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6];
  const sr=[8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11];
  const hl=[0x00000000,0x5a827999,0x6ed9eba1,0x8f1bbcdc,0xa953fd4e];
  const hr=[0x50a28be6,0x5c4dd124,0x6d703ef3,0x7a6d76e9,0x00000000];
  function rotl(x,n){return (x<<n)|(x>>>(32-n));}
  function fn1(a,b,c,d,e,m,k,s){return rotl(((a+((b^c^d)+m+k))|0),s)+e|0;}
  function fn2(a,b,c,d,e,m,k,s){return rotl(((a+(((b&c)|(~b&d))+m+k))|0),s)+e|0;}
  function fn3(a,b,c,d,e,m,k,s){return rotl(((a+(((b|~c)^d)+m+k))|0),s)+e|0;}
  function fn4(a,b,c,d,e,m,k,s){return rotl(((a+(((b&d)|(c&~d))+m+k))|0),s)+e|0;}
  function fn5(a,b,c,d,e,m,k,s){return rotl(((a+((b^(c|~d))+m+k))|0),s)+e|0;}
  // pad
  const msgLen=data.length;
  const bitLen=msgLen*8;
  const padLen=(msgLen%64<56)?(56-(msgLen%64)):(120-(msgLen%64));
  const buf=new Uint8Array(msgLen+padLen+8);
  buf.set(data); buf[msgLen]=0x80;
  let len=bitLen;
  for(let i=0;i<8;i++){buf[msgLen+padLen+i]=len&0xff;len>>>=8;}
  let a=0x67452301|0,b=0xefcdab89|0,c=0x98badcfe|0,d=0x10325476|0,e=0xc3d2e1f0|0;
  for(let off=0;off<buf.length;off+=64){
    const words=new Array(16);
    for(let j=0;j<16;j++){const k2=off+j*4;words[j]=(buf[k2])|(buf[k2+1]<<8)|(buf[k2+2]<<16)|(buf[k2+3]<<24);}
    let al=a,bl=b,cl=c,dl=d,el=e;
    let ar=a,br=b,cr=c,dr=d,er=e;
    for(let i=0;i<80;i++){
      let tl,tr;
      if(i<16){tl=fn1(al,bl,cl,dl,el,words[zl[i]],hl[0],sl[i]);tr=fn5(ar,br,cr,dr,er,words[zr[i]],hr[0],sr[i]);}
      else if(i<32){tl=fn2(al,bl,cl,dl,el,words[zl[i]],hl[1],sl[i]);tr=fn4(ar,br,cr,dr,er,words[zr[i]],hr[1],sr[i]);}
      else if(i<48){tl=fn3(al,bl,cl,dl,el,words[zl[i]],hl[2],sl[i]);tr=fn3(ar,br,cr,dr,er,words[zr[i]],hr[2],sr[i]);}
      else if(i<64){tl=fn4(al,bl,cl,dl,el,words[zl[i]],hl[3],sl[i]);tr=fn2(ar,br,cr,dr,er,words[zr[i]],hr[3],sr[i]);}
      else{tl=fn5(al,bl,cl,dl,el,words[zl[i]],hl[4],sl[i]);tr=fn1(ar,br,cr,dr,er,words[zr[i]],hr[4],sr[i]);}
      al=el;el=dl;dl=rotl(cl,10)|0;cl=bl;bl=tl;
      ar=er;er=dr;dr=rotl(cr,10)|0;cr=br;br=tr;
    }
    const t=(b+cl+dr)|0;
    b=(c+dl+er)|0;
    c=(d+el+ar)|0;
    d=(e+al+br)|0;
    e=(a+bl+cr)|0;
    a=t;
  }
  const out=new Uint8Array(20);
  const hh=[a,b,c,d,e];
  for(let i=0;i<5;i++){
    out[i*4]=hh[i]&0xff;
    out[i*4+1]=(hh[i]>>>8)&0xff;
    out[i*4+2]=(hh[i]>>>16)&0xff;
    out[i*4+3]=(hh[i]>>>24)&0xff;
  }
  return out;
}

async function hash160(bytes){
  const h = await sha256(bytes);
  return ripemd160(h);
}

function bech32Encode(hrp, witver, witprog){
  const GEN = [0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];
  function polymod(values){
    let chk=1;
    for(const v of values){
      const b=chk>>25;
      chk=((chk&0x1ffffff)<<5)^v;
      for(let i=0;i<5;i++) if((b>>i)&1) chk^=GEN[i];
    }
    return chk;
  }
  function hrpExpand(hrp){
    const r=[];
    for(let i=0;i<hrp.length;i++) r.push(hrp.charCodeAt(i)>>5);
    r.push(0);
    for(let i=0;i<hrp.length;i++) r.push(hrp.charCodeAt(i)&31);
    return r;
  }
  function convertBits(data, from, to, pad){
    let acc=0, bits=0, result=[];
    const maxv=(1<<to)-1;
    for(const v of data){
      acc=(acc<<from)|v; bits+=from;
      while(bits>=to){ bits-=to; result.push((acc>>bits)&maxv); }
    }
    if(pad && bits>0) result.push((acc<<(to-bits))&maxv);
    return result;
  }
  const data = [witver].concat(convertBits(witprog, 8, 5, true));
  const combined = hrpExpand(hrp).concat(data).concat([0,0,0,0,0,0]);
  const mod = polymod(combined) ^ 1;
  const checksum = [];
  for(let i=0;i<6;i++) checksum.push((mod>>(5*(5-i)))&31);
  const CHARSET='qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  let out = hrp + '1';
  for(const d of data.concat(checksum)) out += CHARSET[d];
  return out;
}

async function pubkeyToAddress(keyStr){
  const b58 = keyStr.replace(/^secp256k1:/, '');
  const raw = base58Decode(b58);
  if (raw.length !== 64) throw new Error('expected 64 bytes, got ' + raw.length);
  const xy = raw;
  const pub = new Uint8Array(33);
  pub[0] = 2 + (xy[63] & 1);
  pub.set(xy.slice(0,32), 1);
  const h = await hash160(pub);
  return bech32Encode('bc', 0, Array.from(h));
}

async function loadBlock(){
  try {
    const j = await rpc({ jsonrpc:'2.0', id:1, method:'block', params:{ finality:'final' } });
    const h = j.result.header;
    const ts = new Date(Number(h.timestamp)/1e6).toISOString();
    setHtml('block', 'block height: ' + h.height + '<br>timestamp: ' + ts + '<br>block hash: <span class="val">' + h.hash + '</span>');
  } catch (e){ setHtml('block', '<span class="err">' + String(e) + '</span>'); }
}

async function checkAccount(id){
  const acct = (id || document.getElementById('contract').value || 'cachet.near').trim();
  document.getElementById('contract').value = acct;
  try {
    const j = await rpc({ jsonrpc:'2.0', id:1, method:'query', params:{ request_type:'view_account', finality:'final', account_id: acct } });
    const r = j.result;
    setHtml('acct', 'account: ' + nearblocksLink(acct) + '<br>amount: ' + r.amount + ' yoctoNEAR<br>block height: ' + r.block_height);
  } catch (e){
    setHtml('acct', '<span class="err">' + String(e) + '</span><br><span class="small">No such account. Create it or enter a deployed contract account id.</span>');
  }
}

async function derive(){
  const contract = (document.getElementById('contract').value || '').trim();
  const token = (document.getElementById('token').value || '').trim();
  const slot = (document.getElementById('slot').value || '0').trim();
  if (!contract || !token){
    setHtml('derived', '<span class="err">nothing configured: enter contract account id and token id</span>');
    setHtml('mempool','<span class="small">Derive needs a contract account and token id. v1.signer path is cachet/&lt;token&gt;/&lt;slot&gt;.</span>');
    return;
  }
  const path = 'cachet/' + token + '/' + slot;
  const predecessor = contract;
  try {
    const args = { path: path, predecessor: predecessor, domain_id: 0 };
    const j = await rpc({ jsonrpc:'2.0', id:1, method:'query', params:{ request_type:'call_function', finality:'final', account_id: SIGNER, method_name:'derived_public_key', args_base64: b64(JSON.stringify(args)) } });
    const bytes = j.result.result;
    const str = String.fromCharCode.apply(null, bytes);
    const key = JSON.parse(str);
    const addr = await pubkeyToAddress(key);
    const bh = j.result.block_height;
    setHtml('derived',
      'path: ' + path + '<br>' +
      'predecessor: ' + nearblocksLink(predecessor) + '<br>' +
      'derived key: <span class="val">' + key + '</span><br>' +
      'BTC address: <span class="val">' + mempoolLink(addr) + '</span><br>' +
      'read at block: ' + bh);
    setHtml('mempool', 'mempool.space: ' + mempoolLink(addr));
    fetchMempool(addr);
  } catch (e){
    setHtml('derived', '<span class="err">' + String(e) + '</span>');
  }
}

async function fetchMempool(addr){
  try {
    const r = await fetch('https://mempool.space/api/address/' + addr);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const funded = (j.chain_stats && j.chain_stats.funded_txo_sum) || 0;
    const spent = (j.chain_stats && j.chain_stats.spent_txo_sum) || 0;
    const txs = (j.chain_stats && j.chain_stats.tx_count) || 0;
    setHtml('mpdata', 'address: ' + mempoolLink(addr) + '<br>funded: ' + funded + ' sat<br>spent: ' + spent + ' sat<br>tx count: ' + txs);
  } catch (e){
    setHtml('mpdata', '<span class="err">' + String(e) + '</span>');
  }
}

async function loadSigner(){
  try {
    const j = await rpc({ jsonrpc:'2.0', id:1, method:'query', params:{ request_type:'view_account', finality:'final', account_id: SIGNER } });
    const r = j.result;
    setHtml('signer', 'account: ' + nearblocksLink(SIGNER) + '<br>amount: ' + r.amount + ' yoctoNEAR<br>block height: ' + r.block_height);
  } catch (e){ setHtml('signer', '<span class="err">' + String(e) + '</span>'); }
}

document.getElementById('checkAcct').addEventListener('click', () => checkAccount());
document.getElementById('derive').addEventListener('click', () => derive());

loadBlock();
checkAccount('cachet.near');
loadSigner();
const params = new URLSearchParams(location.search);
const c = params.get('contract');
const t = params.get('token');
const s = params.get('slot');
if (c) document.getElementById('contract').value = c;
if (t) document.getElementById('token').value = t;
if (s) document.getElementById('slot').value = s;
if (c && t) derive();
JSEOF
echo written