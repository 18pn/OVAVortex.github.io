// Test der JSON-RPC-Verifikation gegen Solana Mainnet (ohne Deploy, Node >= 20).
import * as sol from '../src/solana.js';
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const MERCHANT = '5fzfBAiPfJ8y6s9jCBbypsVLNFUd9rLVEQHzewdHcxBD';
let fail = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fail++; };

// 1) Unbezahlte, frische Referenz -> muss "nicht bezahlt" (null) liefern
for (const token of ['SOL', 'USDC']) {
  const reference = sol.newReference();
  const r = await sol.findValidPayment(RPC, { recipient: MERCHANT, amount: token === 'SOL' ? '0.010000' : '1.00', reference, tokenSymbol: token });
  ok(r === null, `unbezahlte Referenz (${token}) ${reference} -> nicht bezahlt`);
}

// 2) Parser-Test mit einer echten Mainnet-Transaktion (USDC-Transfer): Empfänger mit positivem Delta
const sigs = await sol.rpc(RPC, 'getSignaturesForAddress', [sol.USDC_MINT, { limit: 25 }]);
let tested = false;
for (const s of sigs) {
  if (s.err) continue;
  let tx; try { tx = await sol.getParsedTransaction(RPC, s.signature); } catch (e) { continue; }
  if (!tx || tx.meta.err) continue;
  const pre = tx.meta.preTokenBalances.filter(b => b.mint === sol.USDC_MINT);
  const post = tx.meta.postTokenBalances.filter(b => b.mint === sol.USDC_MINT);
  const owners = [...new Set(post.map(b => b.owner))];
  const sum = (arr, o) => arr.filter(b => b.owner === o).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n);
  const winner = owners.find(o => sum(post, o) - sum(pre, o) > 0n);
  if (!winner) continue;
  const delta = sum(post, winner) - sum(pre, winner);
  const keys = tx.transaction.message.accountKeys.map(k => k.pubkey);
  const reference = keys.find(k => k !== winner) ;
  const good = sol.checkTransaction(tx, { recipient: winner, reference, tokenSymbol: 'USDC', expectedUnits: delta });
  const tooMuch = sol.checkTransaction(tx, { recipient: winner, reference, tokenSymbol: 'USDC', expectedUnits: delta * 2n + 10n });
  const wrongRcpt = sol.checkTransaction(tx, { recipient: MERCHANT, reference, tokenSymbol: 'USDC', expectedUnits: 1n });
  const wrongRef = sol.checkTransaction(tx, { recipient: winner, reference: sol.newReference(), tokenSymbol: 'USDC', expectedUnits: 1n });
  ok(good.ok, `echte USDC-Tx ${s.signature.slice(0, 16)}… akzeptiert (Delta ${delta})`);
  ok(!tooMuch.ok, 'zu hoher Betrag abgelehnt');
  ok(!wrongRcpt.ok, 'falscher Empfänger abgelehnt');
  ok(!wrongRef.ok, 'fehlende Referenz abgelehnt');
  tested = true; break;
}
ok(tested, 'Mainnet-Parser-Test durchgeführt');

// 3) Rechenlogik
ok(sol.toBaseUnits('0.123456', 9) === 123456000n, 'toBaseUnits');
ok(sol.quoteFromRate(1500, 'SOL', 150).amount === '0.100000', 'quote 15 € @150 = 0.1 SOL');
ok(sol.quoteFromRate(1500, 'USDC', 0.92).amount === '16.31', 'quote 15 € @0.92 = 16.31 USDC (aufgerundet)');
ok(sol.isPubkey(MERCHANT) && !sol.isPubkey('abc'), 'isPubkey');
ok(sol.base58Decode(sol.newReference()).length === 32, 'Referenz = 32 Byte');
const rates = await sol.getEurRates().catch(e => null);
ok(rates && rates.SOL > 0, 'CoinGecko-Kurs SOL/EUR: ' + (rates && rates.SOL));
process.exit(fail ? 1 : 0);
