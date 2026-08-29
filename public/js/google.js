// Google Takeout "My Activity" -> archive records.
//
// Takeout is not a chat export: it is an activity log, one entry per thing you
// did, with the assistant's replies usually absent. So Gemini prompts import as
// one record each (the prompt is the searchable part), while plain searches are
// far too many to import individually and are grouped into one record per day.

const GEMINI_HEADERS = new Set(['gemini apps', 'bard', 'google ai', 'search labs', 'ai mode']);
const MAX_SEARCH_DAYS = 400; // a long history should not become tens of thousands of rows

// Takeout writes "Prompted <text>", "Searched for <text>", "Asked <text>"
const stripVerb = title =>
  String(title || '').replace(/^(prompted|searched for|asked|viewed|used)\s+/i, '').trim();

const dayOf = iso => String(iso || '').slice(0, 10);

export function isTakeoutActivity(data) {
  const list = Array.isArray(data) ? data : null;
  if (!list || !list.length) return false;
  const first = list[0];
  return !!first && typeof first === 'object'
    && typeof first.header === 'string'
    && typeof first.time === 'string'
    && ('title' in first || 'titleUrl' in first);
}

const isGemini = row => GEMINI_HEADERS.has(String(row?.header || '').toLowerCase());
const isSearch = row => String(row?.header || '').toLowerCase() === 'search';

export function takeoutRecords(data) {
  const rows = Array.isArray(data) ? data : [];
  const out = [];
  const searchDays = new Map();

  rows.forEach((row, i) => {
    if (!row || typeof row !== 'object') return;
    const when = typeof row.time === 'string' ? row.time : '';

    if (isGemini(row)) {
      const prompt = stripVerb(row.title);
      if (!prompt) return;
      // Takeout has no stable per-entry id, so derive one from time and position
      out.push({
        uuid: `gemini:${when || 'na'}:${i}`,
        name: prompt.slice(0, 70),
        created: when,
        updated: when,
        source: 'gemini',
        msgs: [
          { s: 'h', t: prompt },
          // details sometimes carry the answer or a link; keep whatever is there
          ...(row.titleUrl ? [{ s: 'a', t: row.titleUrl }] : []),
        ],
      });
      return;
    }

    if (isSearch(row)) {
      const q = stripVerb(row.title);
      if (!q) return;
      const day = dayOf(when);
      if (!day) return;
      if (!searchDays.has(day)) searchDays.set(day, []);
      searchDays.get(day).push(q);
    }
  });

  // one record per day of searches, newest days first if we have to trim
  const days = [...searchDays.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, MAX_SEARCH_DAYS);
  for (const [day, queries] of days) {
    out.push({
      uuid: `gsearch:${day}`,
      name: `Searches · ${day} (${queries.length})`,
      created: `${day}T00:00:00Z`,
      updated: `${day}T23:59:59Z`,
      source: 'search',
      msgs: [{ s: 'h', t: queries.join('\n') }],
    });
  }
  return out;
}

// Rough count of what a Takeout file will contribute, for the import report.
export function takeoutSummary(data) {
  const rows = Array.isArray(data) ? data : [];
  let gemini = 0;
  const days = new Set();
  for (const row of rows) {
    if (isGemini(row)) gemini += 1;
    else if (isSearch(row) && row.time) days.add(dayOf(row.time));
  }
  return { gemini, searchDays: days.size };
}

/* ---------- Takeout's HTML form ----------
   Takeout defaults My Activity to HTML, not JSON, so most exports arrive as
   MyActivity.html per product. The markup is regular enough to read directly,
   which beats making someone wait out a second export: each activity is an
   .outer-cell whose header names the product and whose body holds the text
   followed by the timestamp. */

const HTML_MARKERS = /outer-cell|mdl-typography--title/;
// "Aug 21, 2026, 10:00:00 AM CDT" trailing the activity text
const WHEN_RE = /([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4},\s+\d{1,2}:\d{2}:\d{2}\s*[AP]M(?:\s+[A-Z]{2,5})?)\s*$/;

export function isTakeoutHtml(text) {
  return typeof text === 'string' && /<html/i.test(text.slice(0, 2000)) && HTML_MARKERS.test(text);
}

function cellRows(doc) {
  const rows = [];
  for (const cell of doc.querySelectorAll('.outer-cell')) {
    const header = cell.querySelector('.header-cell .mdl-typography--title');
    const body = cell.querySelector('.content-cell.mdl-typography--body-1');
    if (!body) continue;
    // <br> separates the activity from its timestamp; make that a newline
    const raw = body.innerText || body.textContent || '';
    const flat = raw.replace(/\s+/g, ' ').trim();
    const whenMatch = flat.match(WHEN_RE);
    const when = whenMatch ? whenMatch[1] : '';
    const title = (whenMatch ? flat.slice(0, whenMatch.index) : flat).trim();
    if (!title) continue;
    const t = when ? Date.parse(when.replace(/\s+[A-Z]{2,5}$/, '')) : NaN;
    rows.push({
      header: (header?.textContent || '').trim(),
      title,
      time: Number.isFinite(t) ? new Date(t).toISOString() : '',
    });
  }
  return rows;
}

// Parsed in the browser with DOMParser — no HTML parser is shipped for this.
export function takeoutHtmlRecords(text) {
  if (typeof DOMParser === 'undefined') return [];
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return takeoutRecords(cellRows(doc));
}

export function takeoutHtmlSummary(text) {
  if (typeof DOMParser === 'undefined') return { gemini: 0, searchDays: 0 };
  const doc = new DOMParser().parseFromString(text, 'text/html');
  return takeoutSummary(cellRows(doc));
}
