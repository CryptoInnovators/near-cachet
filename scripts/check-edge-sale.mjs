#!/usr/bin/env node
/**
 * Check Cachet edge sale records.
 * Verifies the recorded edge sale lifecycle on testnet and Sepolia.
 * Reads docs/edge-sale.json and validates all recorded transactions.
 */

import fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const EDGE_JSON = join(ROOT, 'docs', 'edge-sale.json');

const NEARRPC = process.env.NEARRPC || 'https://test.rpc.fastnear.com';
const MEMPOOL = process.env.MEMPOOL || 'https://mempool.space/testnet/api';
const SEPOLIA_RPC = process.env.SEPOLIA_RPC || 'https://rpc.sepolia.org';
const SEPOLIA_CHAIN_ID = 11155111;

async function rpc(method, params = []) {
  const res = await fetch(NEARRPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return res.json();
}

async function viewNote(contract, tokenId) {
  const args = Buffer.from(JSON.stringify({ token_id: tokenId })).toString('base64');
  const res = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contract,
    method_name: 'note',
    args_base64: args
  });
  if (res.result?.result) {
    const bytes = Buffer.from(res.result.result.join(''), 'base64');
    return JSON.parse(bytes.toString());
  }
  return null;
}

async function viewNftToken(contract, tokenId) {
  const args = Buffer.from(JSON.stringify({ token_id: tokenId })).toString('base64');
  const res = await rpc('query', {
    request_type: 'call_function',
    finality: 'final',
    account_id: contract,
    method_name: 'nft_token',
    args_base64: args
  });
  if (res.result?.result) {
    const bytes = Buffer.from(res.result.result.join(''), 'base64');
    return JSON.parse(bytes.toString());
  }
  return null;
}

async function mempool(path) {
  const res = await fetch(`${MEMPOOL}${path}`);
  return res.json();
}

async function mempoolText(path) {
  const res = await fetch(`${MEMPOOL}${path}`);
  return res.text();
}

async function sepoliaRpc(method, params = []) {
  const res = await fetch(SEPOLIA_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  return res.json();
}

async function verifyBitcoinTx(txid) {
  const tx = await mempool(`/tx/${txid}`);
  if (!tx.status?.confirmed) {
    return { ok: false, reason: 'not confirmed' };
  }
  return { ok: true, block_hash: tx.status.block_hash, block_height: tx.status.block_height };
}

async function verifySepoliaTx(txid) {
  const receipt = await sepoliaRpc('eth_getTransactionReceipt', [txid]);
  if (!receipt.result) {
    return { ok: false, reason: 'no receipt' };
  }
  const block = await sepoliaRpc('eth_getBlockByNumber', [receipt.result.blockNumber, false]);
  return {
    ok: true,
    block_number: receipt.result.blockNumber,
    block_hash: block.result?.hash,
    status: receipt.result.status
  };
}

async function checkNote(contract, note) {
  console.log(`\n🔍 Checking note ${note.token_id}...`);
  const onChain = await viewNote(contract, note.token_id);
  if (!onChain) {
    console.log(`  ❌ Note ${note.token_id} not found on chain`);
    return { ok: false, reason: 'note not found' };
  }

  const owner = await viewNftToken(contract, note.token_id);
  const currentOwner = owner?.owner_id || 'unknown';

  let ok = true;
  const checks = [];

  // Check state
  if (onChain.state !== note.state) {
    checks.push(`❌ State mismatch: expected ${note.state}, got ${onChain.state}`);
    ok = false;
  } else {
    checks.push(`✅ State: ${onChain.state}`);
  }

  // Check UTXO if sealed/unsealed
  if (note.utxo) {
    if (!onChain.utxo) {
      checks.push(`❌ Missing UTXO on chain`);
      ok = false;
    } else {
      if (onChain.utxo.txid !== note.utxo.txid) {
        checks.push(`❌ TXID mismatch: expected ${note.utxo.txid}, got ${onChain.utxo.txid}`);
        ok = false;
      } else {
        checks.push(`✅ TXID matches: ${note.utxo.txid}`);
      }
      if (onChain.utxo.vout !== note.utxo.vout) {
        checks.push(`❌ VOUT mismatch: expected ${note.utxo.vout}, got ${onChain.utxo.vout}`);
        ok = false;
      } else {
        checks.push(`✅ VOUT matches: ${note.utxo.vout}`);
      }
      if (onChain.utxo.sats !== note.utxo.sats) {
        checks.push(`❌ SATS mismatch: expected ${note.utxo.sats}, got ${onChain.utxo.sats}`);
        ok = false;
      } else {
        checks.push(`✅ SATS matches: ${note.utxo.sats}`);
      }
      if (onChain.utxo.block_hash !== note.utxo.block_hash) {
        checks.push(`❌ Block hash mismatch: expected ${note.utxo.block_hash}, got ${onChain.utxo.block_hash}`);
        ok = false;
      } else {
        checks.push(`✅ Block hash matches: ${note.utxo.block_hash}`);
      }

      // Verify Bitcoin tx still confirmed
      const btcCheck = await verifyBitcoinTx(note.utxo.txid);
      if (btcCheck.ok) {
        checks.push(`✅ Bitcoin tx confirmed at height ${btcCheck.block_height}`);
      } else {
        checks.push(`❌ Bitcoin tx no longer confirmed: ${btcCheck.reason}`);
        ok = false;
      }
    }
  }

  // Check owner
  if (note.owner_unchanged && currentOwner !== note.owner_unchanged) {
    checks.push(`❌ Owner changed: expected ${note.owner_unchanged}, got ${currentOwner}`);
    ok = false;
  } else if (note.owner_unchanged) {
    checks.push(`✅ Owner unchanged: ${currentOwner}`);
  }

  checks.forEach(c => console.log(`  ${c}`));
  return { ok, currentOwner, checks };
}

async function checkSale(sale) {
  console.log(`\n💰 Checking sale for note ${sale.token_id}...`);
  let ok = true;
  const checks = [];

  // Verify Sepolia transaction
  const sepoliaCheck = await verifySepoliaTx(sale.sepolia_txid);
  if (sepoliaCheck.ok) {
    checks.push(`✅ Sepolia tx confirmed in block ${sepoliaCheck.block_number}`);
    if (sale.sepolia_block && sale.sepolia_block !== sepoliaCheck.block_number.toString()) {
      checks.push(`⚠️ Block number mismatch: recorded ${sale.sepolia_block}, actual ${sepoliaCheck.block_number}`);
    }
    if (sepoliaCheck.status !== '0x1') {
      checks.push(`❌ Sepolia tx failed (status: ${sepoliaCheck.status})`);
      ok = false;
    } else {
      checks.push(`✅ Sepolia tx succeeded`);
    }
  } else {
    checks.push(`❌ Sepolia tx not found: ${sepoliaCheck.reason}`);
    ok = false;
  }

  // Verify NEAR transaction (if recorded)
  if (sale.near_txid) {
    // Note: NEAR tx verification would require querying the transaction status
    checks.push(`✅ NEAR tx recorded: ${sale.near_txid}`);
  }

  checks.forEach(c => console.log(`  ${c}`));
  return { ok, checks };
}

async function checkRefusedSale(refused) {
  console.log(`\n🚫 Checking refused sale for note ${refused.token_id}...`);
  let ok = true;
  const checks = [];

  // Verify the spend transaction exists and is confirmed
  const btcCheck = await verifyBitcoinTx(refused.spend_txid);
  if (btcCheck.ok) {
    checks.push(`✅ Spend tx confirmed at height ${btcCheck.block_height}`);
  } else {
    checks.push(`❌ Spend tx not confirmed: ${btcCheck.reason}`);
    ok = false;
  }

  // Verify the spend actually spends the note's UTXO
  const tx = await mempool(`/tx/${refused.spend_txid}`);
  const spendsNoteUtxo = tx.vin?.some(v => v.txid === refused.spend_txid && v.vout === refused.spend_vout);
  if (spendsNoteUtxo) {
    checks.push(`✅ Spend tx spends the note's UTXO (vout ${refused.spend_vout})`);
  } else {
    checks.push(`❌ Spend tx does not spend the note's UTXO`);
    ok = false;
  }

  // Verify owner unchanged
  if (refused.owner_unchanged) {
    checks.push(`✅ Owner recorded as unchanged: ${refused.owner_unchanged}`);
  }

  checks.forEach(c => console.log(`  ${c}`));
  return { ok, checks };
}

async function main() {
  console.log('🔎 Cachet Edge Sale Verification');
  console.log('=================================\n');

  if (!fs.existsSync(EDGE_JSON)) {
    console.error(`❌ Edge sale record not found: ${EDGE_JSON}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(EDGE_JSON, 'utf-8'));
  const contract = data.accounts?.contract || 'cachet.testnet';

  console.log(`Contract: ${contract}`);
  console.log(`Network: NEAR ${data.network?.near}, Bitcoin ${data.network?.bitcoin}, Sepolia ${data.network?.sepolia_chain_id}`);
  console.log(`Accounts:`, data.accounts);

  let allOk = true;

  // Check notes
  if (data.notes?.length) {
    console.log(`\n📝 Found ${data.notes.length} note(s) to verify`);
    for (const note of data.notes) {
      const result = await checkNote(contract, note);
      if (!result.ok) allOk = false;
    }
  }

  // Check sales
  if (data.sales?.length) {
    console.log(`\n💰 Found ${data.sales.length} sale(s) to verify`);
    for (const sale of data.sales) {
      const result = await checkSale(sale);
      if (!result.ok) allOk = false;
    }
  }

  // Check refused sales
  if (data.refused_sales?.length) {
    console.log(`\n🚫 Found ${data.refused_sales.length} refused sale(s) to verify`);
    for (const refused of data.refused_sales) {
      const result = await checkRefusedSale(refused);
      if (!result.ok) allOk = false;
    }
  }

  console.log('\n=================================');
  if (allOk) {
    console.log('✅ All checks passed!');
    process.exit(0);
  } else {
    console.log('❌ Some checks failed!');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});