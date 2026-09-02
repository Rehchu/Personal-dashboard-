// Today module — the daily briefing: greeting, stat cards, weather, verse of
// the day, and quick capture. First tile of the dashboard.

import { load, save, todayISO, esc, alive } from './store.js';
import { captureBox, inboxList } from './capture.js';

const WX_CACHE_MS = 30 * 60 * 1000;

// Timestamps out of the shop's D1 are SQLite's 'YYYY-MM-DD HH:MM:SS'. Safari
// will not parse that with a space in it, so normalise to ISO first — otherwise
// the age reads as blank on the iPad and the briefing loses its urgency.
const daysSince = ts => {
  if (!ts) return null;
  const t = Date.parse(String(ts).replace(' ', 'T'));
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null;
};

// Public-domain KJV fallbacks, rotated by day-of-year when the votd API fails.
const FALLBACK_VERSES = [
  { ref: 'John 3:16', text: 'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.' },
  { ref: 'Psalm 23:1', text: 'The LORD is my shepherd; I shall not want.' },
  { ref: 'Philippians 4:13', text: 'I can do all things through Christ which strengtheneth me.' },
  { ref: 'Proverbs 3:5-6', text: 'Trust in the LORD with all thine heart; and lean not unto thine own understanding. In all thy ways acknowledge him, and he shall direct thy paths.' },
  { ref: 'Psalm 118:24', text: 'This is the day which the LORD hath made; we will rejoice and be glad in it.' },
  { ref: 'Isaiah 40:31', text: 'But they that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles; they shall run, and not be weary; and they shall walk, and not faint.' },
  { ref: 'Joshua 1:9', text: 'Be strong and of a good courage; be not afraid, neither be thou dismayed: for the LORD thy God is with thee whithersoever thou goest.' },
  { ref: 'Psalm 46:1', text: 'God is our refuge and strength, a very present help in trouble.' },
  { ref: 'Romans 8:28', text: 'And we know that all things work together for good to them that love God, to them who are the called according to his purpose.' },
  { ref: 'Matthew 6:33', text: 'But seek ye first the kingdom of God, and his righteousness; and all these things shall be added unto you.' },
  { ref: 'Psalm 119:105', text: 'Thy word is a lamp unto my feet, and a light unto my path.' },
  { ref: '1 Thessalonians 5:16-18', text: 'Rejoice evermore. Pray without ceasing. In every thing give thanks: for this is the will of God in Christ Jesus concerning you.' },
  { ref: 'Lamentations 3:22-23', text: 'It is of the LORD\'s mercies that we are not consumed, because his compassions fail not. They are new every morning: great is thy faithfulness.' },
  { ref: 'Micah 6:8', text: 'He hath shewed thee, O man, what is good; and what doth the LORD require of thee, but to do justly, and to love mercy, and to walk humbly with thy God?' },
];

function dayKey(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function greetWord() {
  const h = new Date().getHours();
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function dayOfYear() {
  const now = new Date();
  return Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
}

function fitStats() {
  // alive(): deleted workouts persist as sync tombstones and must not count
  const workouts = alive(load('fit.workouts', []));
  const dates = new Set(workouts.map(w => w.date));
  let streak = 0;
  const offset = dates.has(dayKey(0)) ? 0 : 1; // today counts; else streak may end yesterday
  while (dates.has(dayKey(offset + streak))) streak++;
  const week = new Set();
  for (let i = 0; i < 7; i++) week.add(dayKey(i));
  const minutes = workouts.filter(w => week.has(w.date))
    .reduce((s, w) => s + (Number(w.minutes) || 0), 0);
  return { streak, minutes };
}

// writing.daylog is {date: totalWordsAtEndOfDay}. Today's words = today's (or
// latest) total minus the most recent prior day's total. null = no data yet.
function wordsToday() {
  const log = load('writing.daylog', {});
  const keys = Object.keys(log).sort();
  if (!keys.length) return null;
  const today = todayISO();
  const prior = keys.filter(k => k < today);
  const base = prior.length ? Number(log[prior[prior.length - 1]]) || 0 : 0;
  const total = log[today] !== undefined
    ? Number(log[today]) || 0
    : Number(log[keys[keys.length - 1]]) || 0;
  return Math.max(0, total - base);
}

function habitStats() {
  const habits = alive(load('habits', [])); // deleted habits are tombstones
  const today = todayISO();
  return {
    done: habits.filter(h => h.days && h.days[today]).length,
    total: habits.length,
  };
}

function wxLook(code) {
  const c = Number(code);
  if (c === 0) return ['☀️', 'Clear'];
  if (c >= 1 && c <= 3) return ['⛅', 'Clouds'];
  if (c === 45 || c === 48) return ['🌫️', 'Fog'];
  if (c >= 51 && c <= 67) return ['🌧️', 'Rain'];
  if (c >= 71 && c <= 77) return ['❄️', 'Snow'];
  if (c >= 80 && c <= 82) return ['🌦️', 'Showers'];
  if (c >= 95 && c <= 99) return ['⛈️', 'Storm'];
  return ['🌡️', 'Weather'];
}

// Whether a day is workable outdoors, in the order the conditions actually stop
// a job site: lightning and heavy rain send everyone home, sustained wind stops
// anything going up high, a freeze stops concrete and adhesives, and a decent
// chance of rain is worth knowing about even when the day still goes ahead.
// Thresholds are deliberately conservative — this flags a day to plan around,
// it does not make the call for you.
// Open-Meteo daily dates are bare 'YYYY-MM-DD'. new Date() reads those as UTC
// midnight, which lands on the previous day everywhere west of Greenwich — so
// build the date locally instead and the weekday labels stay honest in Chicago.
const dayName = iso => {
  const [y, m, d] = String(iso).split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short' }) : '';
};

// null must not become 0 here: Number(null) is 0, which would sail under every
// threshold below and report a day with no data as a clear one.
const numOrNaN = v => (v === null || v === undefined || v === '' ? NaN : Number(v));

export function workOutlook(day) {
  const pop = numOrNaN(day.pop);
  const wind = numOrNaN(day.wind);
  const hi = numOrNaN(day.hi);
  const code = numOrNaN(day.code);

  if (code >= 95) return { tone: 'stop', label: 'storms' };
  if (pop >= 70) return { tone: 'stop', label: 'rain likely' };
  if (wind >= 25) return { tone: 'warn', label: `wind ${Math.round(wind)}mph` };
  if (hi <= 32) return { tone: 'warn', label: 'freezing' };
  if (code >= 71 && code <= 77) return { tone: 'warn', label: 'snow' };
  if (pop >= 40) return { tone: 'warn', label: `${Math.round(pop)}% rain` };
  // Nothing tripped — but only call a day clear if the two numbers that decide
  // it actually arrived. Silence is not the same as good weather.
  if (!Number.isFinite(pop) || !Number.isFinite(wind)) return { tone: 'unknown', label: 'no data' };
  return { tone: 'go', label: 'clear' };
}

function fallbackVerse() {
  const v = FALLBACK_VERSES[dayOfYear() % FALLBACK_VERSES.length];
  return { date: todayISO(), ref: v.ref, text: v.text, source: 'KJV' };
}

function injectStyle() {
  if (document.getElementById('today-style')) return;
  const style = document.createElement('style');
  style.id = 'today-style';
  style.textContent = `
    #today-greet { margin: 4px 0 18px; animation: today-rise .4s ease both; }
    .today-hello { font-family: var(--font-display); color: var(--ink-2); font-size: 1.1rem; letter-spacing: .04em; }
    .today-date { font-family: var(--font-display); color: var(--ink); font-size: clamp(1.6rem, 4vw, 2.4rem); line-height: 1.15; }
    .today-wx { display: flex; align-items: center; gap: 14px; }
    .today-wx-emoji { font-size: 2.4rem; line-height: 1; }
    .today-wx-temp { font-family: var(--font-display); color: var(--ink); font-size: 1.6rem; }
    .today-week { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(58px, 1fr);
      gap: 6px; margin: 14px 0 0; overflow-x: auto; scrollbar-width: thin; }
    .today-day { display: flex; flex-direction: column; align-items: center; gap: 3px;
      padding: 8px 4px; border-radius: 10px; text-align: center;
      background: var(--surface-2); border: 1px solid var(--line, rgba(255,255,255,.12));
      border-top: 3px solid var(--tone); }
    .today-day.t-go   { --tone: #3f9a5a; }
    .today-day.t-warn { --tone: #c98a1a; }
    .today-day.t-stop { --tone: #d64545; }
    .today-day.t-unknown { --tone: var(--ink-3); }
    .today-day-n { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--ink-2); }
    .today-day-i { font-size: 1.1rem; line-height: 1.2; }
    .today-day-t { font-family: var(--font-display); color: var(--ink); font-size: 1rem; }
    .today-day-l { font-size: 10px; color: var(--tone); font-weight: 600; line-height: 1.25; }
    .today-week-note { margin: 10px 0 0; font-size: 13px; }
    .today-verse { margin: 0 0 10px; padding-left: 12px; border-left: 3px solid var(--accent); color: var(--ink-2); font-style: italic; line-height: 1.55; }
    #today-briefing { display: flex; flex-direction: column; gap: 8px; margin: 0 0 16px; }
    #today-briefing:empty { display: none; }
    .today-brief { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
      padding: 12px 14px; border-radius: 12px; cursor: pointer;
      background: color-mix(in oklab, var(--accent) 12%, var(--surface-2));
      border: 1px solid color-mix(in oklab, var(--accent) 30%, transparent);
      color: var(--ink); font: 600 14px var(--font-body, system-ui); }
    .today-brief:hover { background: color-mix(in oklab, var(--accent) 20%, var(--surface-2)); }
    .today-brief-go { margin-left: auto; color: var(--accent); font-size: 20px; }
    #today-town { display: flex; flex-direction: column; gap: 8px; margin: 0 0 16px; }
    #today-town:empty { display: none; }
    .today-brief.town-digest { align-items: flex-start; font-weight: 500; line-height: 1.45; }
    .today-brief.town-approve { background: color-mix(in oklab, #c98a1a 16%, var(--surface-2));
      border-color: color-mix(in oklab, #c98a1a 40%, transparent); }
    .today-brief.town-approve .today-brief-go { color: #c98a1a; }
    @keyframes today-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { #today-greet { animation: none; } }`;
  document.head.append(style);
}

export function mount(root, tools) {
  injectStyle();

  const yr = new Date().getFullYear();
  const yearDays = (yr % 4 === 0 && (yr % 100 !== 0 || yr % 400 === 0)) ? 366 : 365;
  tools.innerHTML = `<span class="muted">Day ${dayOfYear()} of ${yearDays}</span>`;

  const bigDate = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  root.innerHTML = `
    <div id="today-greet">
      <div class="today-hello">${greetWord()}, Bradly.</div>
      <div class="today-date">${esc(bigDate)}</div>
    </div>
    <div class="stat-row" id="today-stats"></div>
    <div id="today-briefing"></div>
    <div id="today-town"></div>
    <div class="grid-2">
      <div class="panel" id="today-wx-panel">
        <h3>Weather</h3>
        <div id="today-weather"><p class="muted">Checking the sky…</p></div>
      </div>
      <div class="panel">
        <h3>Verse of the day</h3>
        <div id="today-verse"></div>
      </div>
    </div>
    <div class="panel" style="margin-top:18px">
      <h3>Quick capture</h3>
      <div id="today-capture"></div>
    </div>`;

  let alive = true;
  const ac = new AbortController();
  const wxPanel = root.querySelector('#today-wx-panel');
  const wxBox = root.querySelector('#today-weather');
  const verseBox = root.querySelector('#today-verse');

  function renderStats() {
    const statsEl = root.querySelector('#today-stats');
    if (!statsEl) return; // module was closed; a late data event must not throw
    const toSunday = (7 - new Date().getDay()) % 7;
    const fit = fitStats();
    const words = wordsToday();
    const hb = habitStats();
    statsEl.innerHTML = [
      [toSunday === 0 ? '🙌' : `${toSunday}d`, toSunday === 0 ? 'It\'s Sunday' : 'to Sunday'],
      [`${fit.streak}d`, `streak · ${fit.minutes} min this week`],
      [words === null ? '—' : words.toLocaleString(), 'words today'],
      [hb.total ? `${hb.done} / ${hb.total}` : '—', 'habits today'],
    ].map(([v, l]) => `<div class="stat-tile"><div class="stat-value">${v}</div><div class="stat-label">${l}</div></div>`).join('');
  }

  // Personal briefing lines drawn from data the dashboard already has cached:
  // the shop's real workload and a nudge toward the dragon book on a zero day.
  // Every line fails utterly silently — a missing cache shows nothing, never an
  // error. Tapping one opens the relevant module.
  function renderBriefing() {
    const el = root.querySelector('#today-briefing');
    if (!el) return;
    const lines = [];

    const shop = load('biz.shop', null)?.data;
    if (shop && shop.configured !== false) {
      const waiting = Number(shop.leads?.customer) || 0;
      const days = daysSince(shop.leads?.oldestCustomerAt);
      const tix = shop.tickets?.length || 0;

      // A customer who wrote in and has heard nothing back is the only thing on
      // this screen that costs real money by sitting still, so once it goes
      // stale it stops sharing a line with everything else and says the number
      // of days out loud.
      if (waiting) {
        const stale = days !== null && days >= 2;
        lines.push({
          ico: stale ? '📨' : '✉️',
          text: stale
            ? `${waiting} customer${waiting === 1 ? '' : 's'} still waiting on a reply — oldest is ${days} days old.`
            : `${waiting} new customer inquir${waiting === 1 ? 'y' : 'ies'} to answer.`,
          open: 'ops',
        });
      }
      if (tix) lines.push({ ico: '🖥️', text: `At the shop: ${tix} ticket${tix === 1 ? '' : 's'} open`, open: 'ops' });
    }

    const w = wordsToday();
    if (w === 0) lines.push({ ico: '🐉', text: 'Dragons: 0 words today — even one sentence counts.', open: 'writing' });

    if (!lines.length) { el.innerHTML = ''; return; }
    el.innerHTML = lines.map(l =>
      `<button class="today-brief" data-open="${l.open}"><span>${l.ico}</span> ${esc(l.text)} <span class="today-brief-go">›</span></button>`
    ).join('');
    el.querySelectorAll('[data-open]').forEach(b =>
      b.addEventListener('click', () => window.dispatchEvent(new CustomEvent('pd:open', { detail: b.dataset.open }))));
  }

  // The town's overnight read, folded into the morning briefing: the one-line
  // chronicle it wrote while I slept, and — louder, in amber — any decisions the
  // villagers are waiting on me to approve. Shows the last known read instantly
  // from cache, then refreshes; it keeps showing that read even when the town is
  // currently paused or offline, and fails utterly silently like every other
  // briefing line. Tapping either opens the Dyer Town tile.
  function renderTown() {
    const el = root.querySelector('#today-town');
    if (!el) return;

    const paint = (t) => {
      if (!el) return;
      const lines = [];
      if (t && t.pending > 0) lines.push(
        `<button class="today-brief town-approve" data-open="town"><span>🏛️</span> ${t.pending} town decision${t.pending === 1 ? '' : 's'} waiting on your approval <span class="today-brief-go">›</span></button>`);
      if (t && t.text) lines.push(
        `<button class="today-brief town-digest" data-open="town"><span>🌙</span> <span>Overnight in the town: ${esc(t.text)}</span> <span class="today-brief-go">›</span></button>`);
      el.innerHTML = lines.join('');
      el.querySelectorAll('[data-open]').forEach(b =>
        b.addEventListener('click', () => window.dispatchEvent(new CustomEvent('pd:open', { detail: b.dataset.open }))));
    };

    paint(load('today.town', null)); // the last known read, instantly

    (async () => {
      try {
        const res = await fetch('/api/town/state', { signal: ac.signal });
        if (!res.ok) return; // not signed in, or no town — keep the cached read
        const d = await res.json();
        // state is present even when the town is paused (online:false); that last
        // snapshot IS the morning read, so use it whenever it exists.
        if (!alive || !d || !d.state) return;
        const st = d.state;
        const pending = (Array.isArray(st.approvals) ? st.approvals : [])
          .filter(ap => ap && ap.status === 'pending').length;
        const digs = Array.isArray(st.digests) ? st.digests : [];
        const latest = digs.length ? digs[digs.length - 1] : null;
        let text = latest && latest.text ? String(latest.text).trim() : '';
        if (text.length > 170) text = text.slice(0, 167).trimEnd() + '…';
        const payload = { pending, text, at: Date.now() };
        save('today.town', payload);
        paint(payload);
      } catch { /* silent — the town may just be off */ }
    })();
  }

  function paintWeather(w) {
    const [emoji, word] = wxLook(w.code);
    wxPanel.hidden = false;

    // A payload cached before the forecast landed has no days array, so the
    // strip is optional: current conditions still paint and the week fills
    // itself in on the next fetch rather than blanking the panel.
    const days = Array.isArray(w.days) ? w.days : [];
    const strip = days.length ? `
      <div class="today-week">
        ${days.map((d, i) => {
          const o = workOutlook(d);
          const [ico] = wxLook(d.code);
          return `<div class="today-day t-${o.tone}">
            <div class="today-day-n">${i === 0 ? 'Today' : esc(dayName(d.date))}</div>
            <div class="today-day-i">${ico}</div>
            <div class="today-day-t">${Number.isFinite(d.hi) ? `${d.hi}°` : '—'}</div>
            <div class="today-day-l">${esc(o.label)}</div>
          </div>`;
        }).join('')}
      </div>` : '';

    const bad = days.findIndex(d => workOutlook(d).tone === 'stop');
    const note = !days.length ? ''
      : bad === -1
        ? '<p class="muted today-week-note">Nothing in the next 7 days that should stop a day outside.</p>'
        : `<p class="muted today-week-note">Plan around ${bad === 0 ? 'today' : esc(dayName(days[bad].date))} — ${esc(workOutlook(days[bad]).label)}.</p>`;

    wxBox.innerHTML = `
      <div class="today-wx">
        <div class="today-wx-emoji">${emoji}</div>
        <div>
          <div class="today-wx-temp">${Number(w.temp)}°F</div>
          <div class="muted">${word} · feels ${Number(w.feels)}° · H ${Number(w.hi)}° / L ${Number(w.lo)}°</div>
        </div>
      </div>
      ${strip}
      ${note}`;
  }

  async function fetchWeather(lat, lon) {
    try {
      // wind_speed_unit is explicit: temperature_unit=fahrenheit does not carry
      // over to wind, and the default km/h would read as a gale at every
      // threshold below.
      const url = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}`
        + '&current=temperature_2m,apparent_temperature,weather_code'
        + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,weather_code'
        + '&forecast_days=7'
        + '&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto';
      const res = await fetch(url, { signal: ac.signal });
      if (!res.ok) throw new Error(res.status);
      const j = await res.json();
      const d = j.daily || {};
      const days = (d.time || []).map((date, i) => ({
        date,
        hi: Math.round(d.temperature_2m_max?.[i]),
        lo: Math.round(d.temperature_2m_min?.[i]),
        pop: d.precipitation_probability_max?.[i] ?? null,
        wind: d.wind_speed_10m_max?.[i] ?? null,
        code: d.weather_code?.[i] ?? null,
      }));
      const data = {
        at: Date.now(),
        temp: Math.round(j.current.temperature_2m),
        feels: Math.round(j.current.apparent_temperature),
        code: j.current.weather_code,
        hi: Math.round(j.daily.temperature_2m_max[0]),
        lo: Math.round(j.daily.temperature_2m_min[0]),
        days,
      };
      save('today.weather', data);
      if (alive) paintWeather(data);
    } catch {
      // offline / aborted — keep whatever the cache painted, else hide
      if (alive && !load('today.weather', null)) wxPanel.hidden = true;
    }
  }

  function renderWeather() {
    const cached = load('today.weather', null);
    if (cached) paintWeather(cached);
    if (cached && Date.now() - cached.at < WX_CACHE_MS) return;
    if (!('geolocation' in navigator)) {
      if (!cached) wxPanel.hidden = true;
      return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => { if (alive) fetchWeather(pos.coords.latitude, pos.coords.longitude); },
      () => { if (alive && !cached) wxBox.innerHTML = '<p class="muted">Enable location for weather</p>'; },
      { maximumAge: 10 * 60 * 1000, timeout: 10000 },
    );
  }

  function paintVerse(v) {
    verseBox.innerHTML = `
      <blockquote class="today-verse">${esc(v.text)}</blockquote>
      <p class="muted" style="margin:0">${esc(v.ref)} · ${v.source === 'NET' ? 'NET Bible' : 'KJV'}</p>`;
  }

  async function renderVerse() {
    const today = todayISO();
    const cached = load('today.verse', null);
    if (cached && cached.date === today) return paintVerse(cached);
    paintVerse(fallbackVerse()); // something readable while we try the API
    try {
      const res = await fetch('https://labs.bible.org/api/?passage=votd&type=json', { signal: ac.signal });
      if (!res.ok) throw new Error(res.status);
      const arr = await res.json();
      if (!Array.isArray(arr) || !arr.length) throw new Error('empty');
      const first = arr[0];
      const last = arr[arr.length - 1];
      const verse = {
        date: today,
        ref: `${first.bookname} ${first.chapter}:${first.verse}${arr.length > 1 ? `-${last.verse}` : ''}`,
        text: arr.map(v => String(v.text).replace(/<[^>]*>/g, '').trim()).join(' '),
        source: 'NET',
      };
      save('today.verse', verse);
      if (alive) paintVerse(verse);
    } catch {
      if (!ac.signal.aborted) save('today.verse', fallbackVerse()); // fallback is already painted
    }
  }

  const composer = captureBox();
  const inbox = inboxList({ limit: 5 });
  root.querySelector('#today-capture').append(composer, inbox);

  const onData = () => { renderStats(); renderBriefing(); };
  window.addEventListener('pd:data-changed', onData);

  renderStats();
  renderBriefing();
  renderTown();
  renderWeather();
  renderVerse();

  return function unmount() {
    alive = false;
    ac.abort();
    window.removeEventListener('pd:data-changed', onData);
    try { composer.destroy && composer.destroy(); } catch { /* already gone */ }
    try { inbox.destroy && inbox.destroy(); } catch { /* already gone */ }
  };
}
