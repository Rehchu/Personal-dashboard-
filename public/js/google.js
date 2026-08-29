// Google Takeout "My Activity" -> archive records.
//
// Takeout is not a chat export: it is an activity log, one entry per thing you
// did, with the assistant's replies usually absent. So Gemini prompts import as
// one record each (the prompt is the searchable part), while plain searches are
// far too many to import individually and are grouped into one record per day.

const GEMINI_HEADERS = new Set(['gemini apps', 'bard', 'google ai', 'search labs']);
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
