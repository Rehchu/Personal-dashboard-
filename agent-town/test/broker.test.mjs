/* The broker, run for real.

   The shipped route handler is sliced out of town.mjs (the block inside
   http.createServer that serves PORTAL_ROUTE) and mounted on a real HTTP
   server, with a stand-in shop upstream that records what actually arrived.
   Then the attacks are fired at it over real HTTP.

   Two things are checked on every one-way attempt: that the broker refuses it,
   AND that the stand-in shop recorded no request — because "the gate said no"
   and "no email went out" are different claims, and only the second one matters.

   Run: node agent-town/test/broker.test.mjs
*/
import { readFileSync } from 'node:fs';
import http from 'node:http';

const SRC = new URL('../town.mjs', import.meta.url);
const src = readFileSync(SRC, 'utf8');
const lines = src.split('\n');
const cut = (a, b) => lines.slice(a - 1, b).join('\n');

const at = marker => {
  const i = lines.findIndex(l => l.includes(marker));
  if (i < 0) throw new Error(`town.mjs no longer contains: ${marker}`);
  return i + 1;
};
// the matchers, the broker's ticket table and the grant store, all as shipped
const portalBlock = src.slice(src.indexOf('const SEG = '), src.indexOf("/* Every secret this process holds"));
// +1 so the closing brace of the `if (req.url…startsWith(PORTAL_ROUTE))` comes too
const brokerBlock = cut(at("The broker. Ctrl's requests"), at('return res.end(text);') + 1);
// `at` returns the FIRST match, so a handler added ABOVE Ctrl's that also ends
// in `return res.end(text);` makes this slice end before it starts. That once
// yielded an empty broker and a server that 404'd every attack — which reads as
// the gate holding, the one failure this file must never report as a pass.
if (!brokerBlock.includes('PORTAL_ROUTE')) {
  throw new Error('sliced no broker out of town.mjs — is another handler above Ctrl\'s, ending in the same line?');
}

// ---- a stand-in shop, so a "send" that escapes is visible, not theoretical ----
const arrived = [];
const shop = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => {
    arrived.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: b });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, saw: req.url }));
  });
});
await new Promise(r => shop.listen(0, '127.0.0.1', r));
const SHOP = `http://127.0.0.1:${shop.address().port}`;

const KEY = 'cak_deadbeef46b4042fc32f483a0f9cfb0ad9ed55b28d7cc81a';
const mod = `
import { webcrypto } from 'node:crypto';
export const PORTAL_BASE = ${JSON.stringify(SHOP)};
export const PORTAL_AGENT = 'ctrl';
export let PORTAL_KEY = ${JSON.stringify(KEY)};
export const world = { tick: 1 };
const memories = new Map();
export const agentById = id => {
  if (!memories.has(id)) memories.set(id, { id, name: id === 'ctrl' ? 'Ctrl' : 'Spork', memory: [] });
  return memories.get(id);
};
export const log = () => {};
${portalBlock}
function readBody(req) {
  return new Promise(resolve => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => resolve(b)); });
}
export async function handler(req, res) {
  const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
${brokerBlock}
  return send(404, 'text/plain', 'no');
}
export { grantPortal, portalGrants, portalTickets, normalizePortalPath, oneWay };
`;
const M = await import('data:text/javascript,' + encodeURIComponent(mod));
// the real ticket table, with two known tickets in it
M.portalTickets.set('TICKET', 'ctrl');
M.portalTickets.set('SPORKTICKET', 'spork');

const town = http.createServer((req, res) => M.handler(req, res));
await new Promise(r => town.listen(0, '127.0.0.1', r));
const DOOR = `http://127.0.0.1:${town.address().port}/portal`;

let fail = 0;
const results = [];
async function call(label, path, { method = 'GET', body, ticket = 'TICKET', ct = 'application/json' } = {}) {
  const before = arrived.length;
  const res = await fetch(DOOR + path, {
    method,
    headers: { ...(ticket ? { 'x-town-ticket': ticket } : {}), ...(body ? { 'content-type': ct } : {}) },
    body,
  });
  const text = await res.text();
  return { label, status: res.status, reached: arrived.length > before, sent: arrived[arrived.length - 1], text };
}
const expect = (r, { blocked, note = '' }) => {
  // blocked => the broker refused AND nothing reached the shop
  const good = blocked ? (r.status === 403 && !r.reached) : (r.status === 200 && r.reached);
  if (!good) fail++;
  results.push({ ...r, good, want: blocked ? 'refused' : 'forwarded', note });
};

console.log('\n— one-way calls must be refused, and must not reach the shop —');
for (const [label, path, opts] of [
  ['POST /email/send', '/email/send', { method: 'POST', body: '{}' }],
  ['thread reply', '/email/thread/9/reply', { method: 'POST', body: '{}' }],
  ['inquiry reply', '/inquiries/9/reply', { method: 'POST', body: '{}' }],
  ['invoice email', '/invoices/42/email', { method: 'POST', body: '{}' }],
  ['pos checkout', '/pos/checkout', { method: 'POST', body: '{}' }],
  ['shipping buy', '/shipping/buy', { method: 'POST', body: '{}' }],
  ['refund', '/invoices/42/refund', { method: 'POST', body: '{}' }],
  // the shapes that beat the text gate
  ['double slash //email//send', '//email//send', { method: 'POST', body: '{}' }],
  ['percent-encoded slash', '/email%2Fsend', { method: 'POST', body: '{}' }],
  ['percent-encoded letter', '/%65mail/send', { method: 'POST', body: '{}' }],
  ['double-encoded', '/email%252Fsend', { method: 'POST', body: '{}' }],
  ['dot segment', '/./email/send', { method: 'POST', body: '{}' }],
  ['parent segment', '/x/../email/send', { method: 'POST', body: '{}' }],
  ['trailing slash', '/email/send/', { method: 'POST', body: '{}' }],
  ['with a query string', '/email/send?draft=0', { method: 'POST', body: '{}' }],
  // notify, every truthy spelling
  ['status notify:true', '/tickets/7/status', { method: 'POST', body: '{"notify":true}' }],
  ['status notify:1', '/tickets/7/status', { method: 'POST', body: '{"notify":1}' }],
  ['status notify:"true"', '/tickets/7/status', { method: 'POST', body: '{"notify":"true"}' }],
  ['status notify:"yes"', '/tickets/7/status', { method: 'POST', body: '{"notify":"yes"}' }],
  ['status notify:"on"', '/tickets/7/status', { method: 'POST', body: '{"notify":"on"}' }],
  ['status nested notify', '/tickets/7/status', { method: 'POST', body: '{"options":{"notify":true}}' }],
  ['status form-encoded', '/tickets/7/status', { method: 'POST', body: 'status=done&notify=true', ct: 'application/x-www-form-urlencoded' }],
  ['status notifyCustomer', '/tickets/7/status', { method: 'POST', body: '{"notifyCustomer":true}' }],
  // storefront money — public the moment it lands, and the number a customer pays
  ['sell price on an item', '/inventory/42', { method: 'PUT', body: '{"sell_price":1299.99}' }],
  ['cost price on an item', '/inventory/42', { method: 'PUT', body: '{"cost_price":940}' }],
  ['bare price on a prebuilt', '/prebuilts/7', { method: 'PUT', body: '{"price":2658}' }],
  ['unit price on a build', '/builds/3', { method: 'PATCH', body: '{"unit_price":120}' }],
  ['a plan price', '/service-plans/2', { method: 'PUT', body: '{"price":29}' }],
  ['a price nested in items', '/prebuilts/7', { method: 'PUT', body: '{"items":[{"name":"RAM","unit_cost":210}]}' }],
  ['form-encoded price', '/inventory/42', { method: 'PUT', body: 'sell_price=1299', ct: 'application/x-www-form-urlencoded' }],
  ['publishing a prebuilt', '/prebuilts/7', { method: 'PUT', body: '{"status":"published"}' }],
  ['publish flag', '/prebuilts/7', { method: 'PUT', body: '{"is_published":true}' }],
  ['creating a priced prebuilt', '/prebuilts', { method: 'POST', body: '{"name":"Arc 570","sell_price":1516}' }],
]) expect(await call(label, path, opts), { blocked: true });

console.log('— ordinary work must go through, with the key attached —');
for (const [label, path, opts] of [
  ['the dashboard', '/dashboard', {}],
  ['list tickets', '/tickets?customer_id=4', {}],
  ['email threads', '/email/threads?mailbox=support', {}],
  ['read one thread', '/email/thread/91', {}],
  ['AI draft reply', '/inquiries/12/draft-reply', { method: 'POST', body: '{}' }],
  ['AI triage', '/inquiries/12/analyze', { method: 'POST', body: '{}' }],
  ['status, no notify', '/tickets/7/status', { method: 'POST', body: '{"status":"in_progress"}' }],
  ['status notify:false', '/tickets/7/status', { method: 'POST', body: '{"notify":false}' }],
  ['create an invoice', '/invoices', { method: 'POST', body: '{}' }],
  ['/email/sender is not /email/send', '/email/sender', {}],
  // reading prices is the point of having the door — only the write waits
  ['read the inventory', '/inventory', {}],
  ['read one prebuilt', '/prebuilts/7', {}],
  ['read the builds', '/builds', {}],
  ['supplier price LOOKUP', '/inventory/42/price-search', { method: 'POST', body: '{}' }],
  ['a stock count is not a price', '/inventory/42', { method: 'PUT', body: '{"qty_on_hand":4}' }],
  ['renaming an item', '/inventory/42', { method: 'PUT', body: '{"name":"RTX 4070 Super"}' }],
  ['a draft prebuilt stays draft', '/prebuilts/7', { method: 'PUT', body: '{"status":"draft"}' }],
]) expect(await call(label, path, opts), { blocked: false });

console.log('— the ticket —');
{
  const r = await call('no ticket', '/dashboard', { ticket: '' });
  if (!(r.status === 401 && !r.reached)) fail++;
  results.push({ ...r, good: r.status === 401 && !r.reached, want: '401' });
  const s = await call('another villager’s ticket', '/dashboard', { ticket: 'SPORKTICKET' });
  if (!(s.status === 403 && !s.reached)) fail++;
  results.push({ ...s, good: s.status === 403 && !s.reached, want: '403' });
  const b = await call('a made-up ticket', '/dashboard', { ticket: 'guessing' });
  if (!(b.status === 401 && !b.reached)) fail++;
  results.push({ ...b, good: b.status === 401 && !b.reached, want: '401' });
}

console.log('— an approval buys exactly one call —');
M.grantPortal('ctrl', '/invoices/42/email');
expect(await call('the approved call', '/invoices/42/email', { method: 'POST', body: '{}' }), { blocked: false });
expect(await call('the same call again', '/invoices/42/email', { method: 'POST', body: '{}' }), { blocked: true });
M.grantPortal('ctrl', '/invoices/42/email');
expect(await call('a different invoice', '/invoices/91/email', { method: 'POST', body: '{}' }), { blocked: true });
expect(await call('the approved path, obfuscated', '/invoices/42/email%2F', { method: 'POST', body: '{}' }), { blocked: false });

console.log('— what actually left the building —');
// exact paths — `/email/sender` is a read and merely CONTAINS `/email/send`
const sends = arrived.filter(a => M.oneWay(a.url.replace(/\?.*$/, ''), a.body, (() => {
  try { return a.body ? JSON.parse(a.body) : undefined; } catch { return undefined; }
})()));
const approvedOnly = sends.every(a => a.url === '/invoices/42/email');
if (!approvedOnly) fail++;
const keyed = arrived.every(a => a.auth === `Bearer ${KEY}`);
if (!keyed) fail++;
const normalized = arrived.every(a => !/%|\/\/|\/\.\.?\//.test(a.url));

for (const r of results) console.log(`  ${r.good ? '   ' : '>>>'} ${String(r.status).padEnd(3)} ${r.reached ? 'reached shop' : 'stopped     '}  ${r.label}${r.good ? '' : `   <-- wanted ${r.want}`}`);
console.log(`\n  ${arrived.length} requests reached the stand-in shop`);
console.log(`  every forwarded request carried the key: ${keyed}`);
console.log(`  every forwarded path was normalized: ${normalized}`);
console.log(`  the only one-way call that got out was the approved one: ${approvedOnly}`);
console.log(fail ? `\n${fail} FAILED\n` : `\nall ${results.length} passed\n`);

shop.close(); town.close();
process.exit(fail ? 1 : 0);
