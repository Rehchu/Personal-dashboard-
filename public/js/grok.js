// Grok (xAI) export -> archive records, in the same shape the Claude importer
// produces, so search, categories and topics work across both assistants.
//
// The export nests one level deeper than Claude's:
//   { conversations: [ { conversation: {...}, responses: [ { response: {...} } ] } ],
//     projects: [], tasks: [], media_posts: [ {...} ] }
// and account files that ship alongside it (billing, auth/session data) are
// deliberately ignored - session ids, IPs and a birth date never belong in an
// archive that syncs.

const SENDER_HUMAN = new Set(['human', 'user']);

// message timestamps arrive as Mongo extended JSON: {$date:{$numberLong:"ms"}}
function msAt(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  const long = v?.$date?.$numberLong ?? v?.$date;
  const n = Number(long);
  return Number.isFinite(n) ? n : 0;
}

const iso = ms => (ms ? new Date(ms).toISOString() : '');

export function isGrokExport(data) {
  if (!data || typeof data !== 'object') return false;
  if (Array.isArray(data.media_posts) && !data.conversations) return true;
  const list = data.conversations;
  return Array.isArray(list) && list.length > 0
    && !!list[0] && typeof list[0] === 'object'
    && 'conversation' in list[0] && 'responses' in list[0];
}

function grokMessages(responses) {
  return (Array.isArray(responses) ? responses : [])
    .map(r => r?.response)
    .filter(m => m && typeof m.message === 'string' && m.message.trim())
    // the tree is stored unordered; time is the only reliable sequence
    .sort((a, b) => msAt(a.create_time) - msAt(b.create_time))
    .map(m => ({
      // sender is 'human', 'assistant', 'ASSISTANT', or a model id like 'grok-4'
      s: SENDER_HUMAN.has(String(m.sender || '').toLowerCase()) ? 'h' : 'a',
      t: m.message.trim(),
    }));
}

export function grokConvos(data) {
  return (data?.conversations || [])
    .map(entry => {
      const c = entry?.conversation;
      if (!c || !c.id) return null;
      const msgs = grokMessages(entry.responses);
      const created = c.create_time || '';
      return {
        uuid: `grok:${c.id}`,
        name: (c.title || '').trim() || '(untitled chat)',
        created,
        updated: c.modify_time || created,
        source: 'grok',
        starred: !!c.starred,
        msgs,
      };
    })
    .filter(Boolean);
}

// generated images and videos: the prompt is the searchable part
export function grokMedia(data) {
  return (data?.media_posts || [])
    .map(p => {
      if (!p || !p.id) return null;
      const prompt = (p.original_prompt || '').trim();
      const when = iso(msAt(p.create_time)) || p.create_time || '';
      return {
        uuid: `grok-media:${p.id}`,
        name: prompt ? prompt.slice(0, 70) : `${p.media_type || 'media'} generation`,
        created: when,
        updated: when,
        source: 'grok',
        kind: p.media_type || 'media',
        msgs: [
          { s: 'h', t: prompt || '(no prompt recorded)' },
          ...(p.link ? [{ s: 'a', t: `${p.media_type || 'media'} · ${p.link}` }] : []),
        ],
      };
    })
    .filter(Boolean);
}

// Grok projects/tasks are usually empty, but import them when present so the
// archive does not quietly drop a category the export contains.
export function grokProjects(data) {
  const out = [];
  for (const p of data?.projects || []) {
    if (!p?.id && !p?.uuid) continue;
    const when = p.create_time || p.modify_time || '';
    const body = [p.description, p.system_prompt, p.instructions]
      .filter(t => typeof t === 'string' && t.trim()).join('\n\n');
    out.push({
      uuid: `grok-project:${p.id || p.uuid}`,
      name: (p.name || p.title || '').trim() || '(untitled project)',
      created: when,
      updated: p.modify_time || when,
      source: 'grok',
      msgs: body ? [{ s: 'h', t: body }] : [],
    });
  }
  for (const t of data?.tasks || []) {
    if (!t?.id) continue;
    const when = t.create_time || '';
    const body = [t.prompt, t.description, t.result].filter(x => typeof x === 'string' && x.trim()).join('\n\n');
    out.push({
      uuid: `grok-task:${t.id}`,
      name: (t.title || t.name || '').trim() || '(untitled task)',
      created: when,
      updated: t.modify_time || when,
      source: 'grok',
      msgs: body ? [{ s: 'h', t: body }] : [],
    });
  }
  return out;
}

export function grokRecords(data) {
  return [...grokConvos(data), ...grokProjects(data), ...grokMedia(data)];
}

// An xAI account dump also includes billing and auth/session files. They hold
// live session ids, IP addresses and a birth date, so they are recognised only
// to be refused - never stored, never synced.
export function isGrokAccountFile(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.balance_map && Object.keys(data).length === 1) return true;
  return !!(data.user && Array.isArray(data.sessions));
}
