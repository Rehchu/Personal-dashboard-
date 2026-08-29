// ChatGPT export -> archive records.
//
// The export's conversations.json stores each chat as a `mapping` of nodes
// keyed by id, not as a list: every node points at its parent and children,
// because the UI lets you edit a message and branch the thread. Reading it in
// object order would interleave abandoned branches with the real one, so the
// nodes are collected and ordered by their own timestamps instead.

const HUMAN_ROLES = new Set(['user']);
// system prompts and tool plumbing are not conversation
const SKIP_ROLES = new Set(['system', 'tool']);

const iso = secs => (Number.isFinite(secs) ? new Date(secs * 1000).toISOString() : '');

export function isChatGptExport(data) {
  const list = Array.isArray(data) ? data : data?.conversations;
  if (!Array.isArray(list) || !list.length) return false;
  const first = list[0];
  return !!first && typeof first === 'object'
    && !!first.mapping && typeof first.mapping === 'object';
}

// parts are usually strings; multimodal turns mix in objects
function partsText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content.parts)) {
    return content.parts
      .map(p => {
        if (typeof p === 'string') return p;
        if (p && typeof p.text === 'string') return p.text;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof content.text === 'string') return content.text;
  return '';
}

function messagesOf(mapping) {
  const out = [];
  for (const node of Object.values(mapping || {})) {
    const m = node?.message;
    if (!m || !m.author) continue;
    const role = String(m.author.role || '').toLowerCase();
    if (SKIP_ROLES.has(role)) continue;
    // the app hides some turns from the transcript; honour that
    if (m.metadata?.is_visually_hidden_from_conversation) continue;
    const text = partsText(m.content);
    if (!text) continue;
    out.push({ at: Number(m.create_time) || 0, s: HUMAN_ROLES.has(role) ? 'h' : 'a', t: text });
  }
  // stable: equal timestamps keep insertion order
  return out
    .map((m, i) => ({ ...m, i }))
    .sort((a, b) => (a.at - b.at) || (a.i - b.i))
    .map(({ s, t }) => ({ s, t }));
}

export function chatgptRecords(data) {
  const list = Array.isArray(data) ? data : data?.conversations || [];
  return list
    .map(c => {
      if (!c || typeof c !== 'object') return null;
      const id = c.conversation_id || c.id;
      if (!id) return null;
      const created = iso(c.create_time);
      return {
        uuid: `chatgpt:${id}`,
        name: (c.title || '').trim() || '(untitled chat)',
        created,
        updated: iso(c.update_time) || created,
        source: 'chatgpt',
        msgs: messagesOf(c.mapping),
      };
    })
    .filter(Boolean);
}

// The same export ships user.json with an email and id, plus feedback files.
// Recognised so they can be skipped rather than half-imported as junk.
export function isOpenAiAccountFile(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  return keys.length <= 6 && 'id' in data && ('email' in data || 'chatgpt_plus_user' in data);
}
