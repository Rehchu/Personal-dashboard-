/* What bashGate refuses, checked against the engine that actually ships.

   town.mjs is one file that starts a town when you import it, so these tests
   can't just `import { bashGate }`. Instead they slice the relevant source text
   out of town.mjs and evaluate THAT — the real regexes, not a second copy that
   drifts the first time someone edits one and not the other.

   Run: node agent-town/test/gate.test.mjs
*/
import { readFileSync } from 'node:fs';

const SRC = new URL('../town.mjs', import.meta.url);
const src = readFileSync(SRC, 'utf8');

// ---- the portal's one-way doors: the table and matchers, lifted whole ----
const start = src.indexOf('const SEG = ');
const end = src.indexOf('/* One approved call');
if (start < 0 || end < 0) throw new Error('town.mjs no longer contains the portal door block');
const { oneWay, portalPaths } = await import('data:text/javascript,' + encodeURIComponent(
  src.slice(start, end) + '\nexport { oneWay, portalPaths };'));

// ---- the credential denials: single regex literals, lifted by line ----
const lift = marker => {
  const line = src.split('\n').find(l => l.includes(marker));
  if (!line) throw new Error(`town.mjs no longer has the line matching ${marker}`);
  const m = line.match(/\/(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\])+\/[gimsuy]*/);
  const cut = m[0].lastIndexOf('/');
  return new RegExp(m[0].slice(1, cut), m[0].slice(cut + 1));
};
const printsKey = lift('echo|printf|printenv|cat|tee|set');
const redirectsKey = lift('CTRL_ALT_API_KEY\\b[^;&|');
const dumpsEnv = lift('printenv|env|set|export');

const B = 'https://myfaithtech.com/api/admin';
let fail = 0;
const t = (label, got, want) => {
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${label}${ok ? '' : `  (got ${JSON.stringify(got)})`}`);
};
const gated = cmd => Boolean(oneWay(cmd, cmd));
const denied = cmd => printsKey.test(cmd) || redirectsKey.test(cmd) || dumpsEnv.test(cmd);

console.log('\n— a call that cannot be taken back needs the owner’s yes —');
t('email a customer', gated(`curl -X POST ${B}/email/send -d '{}'`), true);
t('reply in a thread', gated(`curl -X POST ${B}/email/thread/91/reply -d '{}'`), true);
t('reply to an inquiry', gated(`curl -sX POST "${B}/inquiries/abc-12/reply"`), true);
t('email an invoice', gated(`curl -X POST ${B}/invoices/42/email`), true);
t('email a records copy', gated(`curl -X POST ${B}/invoices/42/email-copy`), true);
t('email a pay link', gated(`curl -X POST ${B}/invoices/42/send-pay-link`), true);
t('email a payment link', gated(`curl -X POST ${B}/payment-links/7/email`), true);
t('email a waiver', gated(`curl -X POST ${B}/tickets/7/waiver-email`), true);
t('confirm an appointment', gated(`curl -X POST ${B}/appointments/7/confirm-email`), true);
t('charge a card', gated(`curl -X POST ${B}/pos/checkout -d '{}'`), true);
t('buy a label', gated(`curl -X POST ${B}/shipping/buy`), true);
t('refund money', gated(`curl -X POST ${B}/invoices/42/refund`), true);
t('status WITH notify:true', gated(`curl -X POST ${B}/tickets/7/status -d '{"status":"done","notify":true}'`), true);
t('…quoted', gated(`curl -X POST "${B}/email/send" -H "x: y"`), true);
t('…with a query string', gated(`curl -X POST "${B}/email/send?draft=0"`), true);
t('…base hidden in a shell variable', gated(`B=${B}; curl -X POST $B/email/send -d '{}'`), true);
t('…buried in a script body', gated(`fetch('${B}/invoices/42/email', {method:'POST'})`), true);

console.log('\n— ordinary shop work must not need one —');
t('the dashboard', gated(`curl -s ${B}/dashboard -H "Authorization: Bearer $CTRL_ALT_API_KEY"`), false);
t('list tickets', gated(`curl -s "${B}/tickets?customer_id=4"`), false);
t('list threads', gated(`curl -s "${B}/email/threads?mailbox=support"`), false);
t('read one thread', gated(`curl -s ${B}/email/thread/91`), false);
t('AI draft reply (not sent)', gated(`curl -X POST ${B}/inquiries/12/draft-reply`), false);
t('AI triage', gated(`curl -X POST ${B}/inquiries/12/analyze`), false);
t('inquiry → ticket', gated(`curl -X POST ${B}/inquiries/12/convert`), false);
t('status without notify', gated(`curl -X POST ${B}/tickets/7/status -d '{"status":"in_progress"}'`), false);
t('status notify:false', gated(`curl -X POST ${B}/tickets/7/status -d '{"notify":false}'`), false);
t('create an invoice', gated(`curl -X POST ${B}/invoices -d '{}'`), false);
t('invoice line items', gated(`curl -s ${B}/invoices/42/items`), false);
t('invoice pay-url', gated(`curl -s ${B}/invoices/42/pay-url`), false);
t('/email/sender is not /email/send', gated(`curl -s ${B}/email/sender`), false);
t('ticket photos', gated(`curl -s ${B}/tickets/7/photos`), false);

console.log('\n— the path an approval is matched against —');
t('one call, one path', JSON.stringify(portalPaths(`curl -X POST ${B}/invoices/42/email`)), '["/invoices/42/email"]');
t('query string dropped', JSON.stringify(portalPaths(`curl "${B}/tickets?x=1"`)), '["/tickets"]');
t('two calls are both seen', portalPaths(`curl ${B}/invoices/42/email ; curl ${B}/invoices/91/email`).length, 2);

console.log('\n— looking at a credential is refused —');
t('echo the key', denied('echo $CTRL_ALT_API_KEY'), true);
t('printf the key', denied('printf "%s" "$CTRL_ALT_API_KEY"'), true);
t('key into a file', denied('echo $CTRL_ALT_API_KEY > k.txt'), true);
t('key appended to notes', denied('printf "$CTRL_ALT_API_KEY" >> notes.md'), true);
t('bare env', denied('env'), true);
t('env > o.txt', denied('env > o.txt'), true);
t('env | grep', denied('env | grep TOKEN'), true);
t('printenv', denied('printenv'), true);
t('printenv after &&', denied('cd repo && printenv'), true);
t('export -p', denied('export -p > e.sh'), true);

console.log('\n— using a credential still works —');
t('Bearer header', denied(`curl -s ${B}/dashboard -H "Authorization: Bearer $CTRL_ALT_API_KEY"`), false);
t('Bearer header on a POST', denied(`curl -X POST ${B}/inquiries/3/draft-reply -H "Authorization: Bearer $CTRL_ALT_API_KEY" -d '{}'`), false);
t('curl -o saves the RESPONSE', denied(`curl -s ${B}/tickets -H "Authorization: Bearer $CTRL_ALT_API_KEY" -o t.json`), false);
t('env VAR=1 cmd', denied('env NODE_ENV=production node x.js'), false);
t('npm run build', denied('npm run build'), false);
t('git status', denied('git status'), false);
t('grep the repo', denied('grep -rn "settings" src/'), false);

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
