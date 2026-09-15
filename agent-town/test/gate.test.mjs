/* bashGate, run for real.

   The whole function is sliced out of town.mjs with the portal block it depends
   on, given its dependencies, and called exactly as the Agent SDK calls it.
   Nothing here is a copy of the rules — it IS the rules, so an edit to one
   cannot quietly diverge from the other.

   bashGate is the OUTER layer. It is signposting and credential hygiene: it
   keeps a villager from wasting turns on a request that cannot work, and keeps
   secret values out of files that get pushed to GitHub. It is deliberately not
   the thing standing between Ctrl and a customer's inbox — the broker is
   (see broker.test.mjs), because a gate that reads a shell command is guessing
   what the shell will do. Defeating anything here wins an unauthenticated
   request, which the portal refuses.

   Run: node agent-town/test/gate.test.mjs
*/
import { readFileSync } from 'node:fs';

const SRC = new URL('../town.mjs', import.meta.url);
const src = readFileSync(SRC, 'utf8');
const lines = src.split('\n');
const at = marker => {
  const i = lines.findIndex(l => l.includes(marker));
  if (i < 0) throw new Error(`town.mjs no longer contains: ${marker}`);
  return i;
};

const portalBlock = src.slice(src.indexOf('const SEG = '), src.indexOf("/* Every secret this process holds"));
const gateStart = at('function bashGate(agent) {');
let depth = 0, gateEnd = -1;
for (let i = gateStart; i < lines.length; i++) {
  for (const ch of lines[i]) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  if (depth === 0 && i > gateStart) { gateEnd = i; break; }
}
if (gateEnd < 0) throw new Error('could not find the end of bashGate');

const KEY = 'cak_00c8c92c46b4042fc32f483a0f9cfb0ad9ed55b28d7cc81a';
const GH = 'ghp_AAAABBBBCCCCDDDDEEEEFFFF0000111122';

const M = await import('data:text/javascript,' + encodeURIComponent(`
import { webcrypto } from 'node:crypto';
import { resolve, join, sep } from 'node:path';
const WORKSHOP = '/w';
const PORTAL_AGENT = 'ctrl';
const PORTAL_BASE = 'https://myfaithtech.com/api/admin';
let PORTAL_KEY = ${JSON.stringify(KEY)};
const GH_TOKEN = ${JSON.stringify(GH)};
const TOWN_KEY = 'townpass-secret-1234';
const CF_TOKEN = 'cfplayground-tok-1234';
const CF_DEPLOY_TOKEN = 'cfdeploy-tok-12345678';
const agentById = id => ({ id, name: id === 'ctrl' ? 'Ctrl' : 'Spork' });
const deployGrants = new Map();
const liveGrant = () => null;
${portalBlock}
function leaksSecret(text) {
  const t = String(text || '');
  if (!t) return false;
  return [GH_TOKEN, PORTAL_KEY, TOWN_KEY, CF_TOKEN, CF_DEPLOY_TOKEN]
    .some(s => s && String(s).length >= 12 && t.includes(s));
}
${lines.slice(gateStart, gateEnd + 1).join('\n')}
export { bashGate, oneWay, normalizePortalPath, portalPaths };
`));

const gate = M.bashGate({ id: 'ctrl', name: 'Ctrl' });
const other = M.bashGate({ id: 'spork', name: 'Spork' });
const B = 'https://myfaithtech.com/api/admin';

let fail = 0;
const rows = [];
async function check(group, label, want, tool, input, who = gate) {
  const r = await who(tool, input);
  const allowed = r?.behavior === 'allow';
  const good = allowed === (want === 'allow');
  if (!good) fail++;
  rows.push({ group, label, allowed, good, want });
}

const G = {
  direct: 'a direct call to the shop is refused — no villager holds a key',
  cred: 'credential hygiene',
  files: 'the workshop boundary',
  script: 'a script is a command with a delay on it',
  work: 'ordinary work is not in the way',
};

for (const [label, cmd] of [
  ['Ctrl emails a customer directly', `curl -X POST ${B}/email/send`],
  ['Ctrl reads the shop directly', `curl -s ${B}/dashboard`],
]) await check(G.direct, label, 'deny', 'Bash', { command: cmd });
await check(G.direct, 'another villager tries the shop', 'deny', 'Bash', { command: `curl -s ${B}/customers` }, other);

for (const [label, cmd] of [
  ['echo the ticket', 'echo $CTRL_ALT_PORTAL_TICKET'],
  ['ticket into a file', 'printf "$CTRL_ALT_PORTAL_TICKET" > t.txt'],
  ['echo the old key var', 'echo $CTRL_ALT_API_KEY'],
  ['bare env', 'env'],
  ['env redirected', 'env > o.txt'],
  ['env after &&', 'cd repo && env'],
  ['printenv', 'printenv'],
  ['export -p', 'export -p > e.sh'],
  ['/proc/self/environ', 'cat /proc/self/environ'],
  ['the github token by name', 'echo $GITHUB_TOKEN'],
  ['a secret file', 'cat ../../ctrl-portal-key.txt'],
  ['the town key file', 'cat ../../town-key.txt'],
  ['a literal key in a command', `curl -H "Authorization: Bearer ${KEY}" ${B}/dashboard`],
]) await check(G.cred, label, 'deny', 'Bash', { command: cmd });
await check(G.cred, 'a literal key written to a file', 'deny', 'Write', { file_path: 'k.env', content: `KEY=${KEY}` });
await check(G.cred, 'the github token written to a file', 'deny', 'Write', { file_path: 'gh.txt', content: `token ${GH}` });

await check(G.files, 'Read above the workshop', 'deny', 'Read', { file_path: '../../town.mjs' });
await check(G.files, 'Read a secret file', 'deny', 'Read', { file_path: '../../ctrl-portal-key.txt' });
await check(G.files, 'Grep the folder above', 'deny', 'Grep', { path: '../..', pattern: 'cak_' });
await check(G.files, 'Read a colleague’s work', 'allow', 'Read', { file_path: '../draco/notes.md' });

await check(G.script, 'a script that emails a customer', 'deny', 'Write', { file_path: 's.js', content: `fetch('${B}/email/send',{method:'POST'})` });
await check(G.script, 'a script that emails through the door', 'deny', 'Write', { file_path: 's.js', content: `fetch(process.env.CTRL_ALT_PORTAL+'/email/send',{method:'POST'})` });
await check(G.script, 'a script that charges a card', 'deny', 'Write', { file_path: 's.js', content: `fetch('${B}/pos/checkout',{method:'POST'})` });
await check(G.script, 'a script that only reads', 'allow', 'Write', { file_path: 's.js', content: `fetch('${B}/inquiries?status=new')` });
await check(G.script, 'a script that drafts a reply', 'allow', 'Write', { file_path: 's.js', content: `fetch(process.env.CTRL_ALT_PORTAL+'/inquiries/3/draft-reply',{method:'POST'})` });

for (const [label, cmd] of [
  ['read the shop through the door', 'curl -s "$CTRL_ALT_PORTAL/dashboard" -H "x-town-ticket: $CTRL_ALT_PORTAL_TICKET"'],
  ['list inquiries through the door', 'curl -s "$CTRL_ALT_PORTAL/inquiries?status=new" -H "x-town-ticket: $CTRL_ALT_PORTAL_TICKET"'],
  ['npm run build', 'npm run build'],
  ['git commit', 'git commit -m "refresh the prebuilt ladder"'],
  ['env VAR=1 cmd', 'env NODE_ENV=production node build.js'],
  ['grep the repo', 'grep -rn "settings" src/'],
]) await check(G.work, label, 'allow', 'Bash', { command: cmd });
await check(G.work, 'write a normal file', 'allow', 'Write', { file_path: 'notes.md', content: '# the prebuilt ladder\n' });

// the classifier the Write guard and request_portal share
const one = (p, body, parsed) => Boolean(M.oneWay(p, body, parsed));
const CLASS = 'the one-way classifier';
for (const [label, got, want] of [
  ['/email/send', one('/email/send'), true],
  ['/pos/checkout', one('/pos/checkout'), true],
  ['/shipping/buy', one('/shipping/buy'), true],
  ['/invoices/42/email', one('/invoices/42/email'), true],
  ['/invoices/42/email-copy', one('/invoices/42/email-copy'), true],
  ['//email//send normalizes', one('//email//send'), true],
  ['/email%2Fsend normalizes', one('/email%2Fsend'), true],
  ['/x/../email/send normalizes', one('/x/../email/send'), true],
  ['status + notify:true', one('/tickets/7/status', '', { notify: true }), true],
  ['status + notify:1', one('/tickets/7/status', '', { notify: 1 }), true],
  ['status + notify:"yes"', one('/tickets/7/status', '', { notify: 'yes' }), true],
  ['status + nested notify', one('/tickets/7/status', '', { options: { notify: true } }), true],
  ['status + notify:false', one('/tickets/7/status', '', { notify: false }), false],
  ['status alone', one('/tickets/7/status', '', { status: 'done' }), false],
  ['/email/sender is a read', one('/email/sender'), false],
  ['/inquiries/3/draft-reply', one('/inquiries/3/draft-reply'), false],
  ['/dashboard', one('/dashboard'), false],
]) {
  const good = got === want;
  if (!good) fail++;
  rows.push({ group: CLASS, label, allowed: got, good, want: want ? 'one-way' : 'ordinary' });
}

let group = '';
for (const r of rows) {
  if (r.group !== group) { group = r.group; console.log(`\n${group}`); }
  const shown = r.group === CLASS ? (r.allowed ? 'one-way ' : 'ordinary') : (r.allowed ? 'allowed' : 'refused');
  console.log(`  ${r.good ? '   ' : '>>>'} ${shown}  ${r.label}${r.good ? '' : `   <-- wanted ${r.want}`}`);
}
console.log(fail ? `\n${fail} of ${rows.length} FAILED\n` : `\nall ${rows.length} passed\n`);
process.exit(fail ? 1 : 0);
