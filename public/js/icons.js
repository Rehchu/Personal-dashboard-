// Inline SVG glyph set. Original stylized marks (evocative, not copied),
// single currentColor, legible 16-40px. No defs/ids, no scripts — safe to
// inject anywhere via innerHTML. Sized 1em so they track font-size.

export const ICONS = {
  // Eagle-beak chevron insignia: pointed peak, two swept wings, notch below.
  assassins: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M12 2.5c2 5.1 5.5 10.5 9 14h-4.2c-1.9-2.3-3.6-4.9-4.8-7.7-1.2 2.8-2.9 5.4-4.8 7.7H3c3.5-3.5 7-8.9 9-14Z"/><path d="M12 12.4l2.4 4.2-2.4 3.9-2.4-3.9Z"/></svg>',

  // Glitched square: corner notch cut, middle slice band shoved sideways.
  cyberpunk: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M4 4h9v3.5h7V11H4Z"/><path d="M6.5 13h16v3h-16Z"/><path d="M4 18h16v2.5H4Z"/></svg>',

  // Wanted star.
  gtav: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M12 2l2.7 6.4 6.8.5-5.2 4.5 1.6 6.7-5.9-3.6-5.9 3.6 1.6-6.7-5.2-4.5 6.8-.5Z"/></svg>',

  // Isometric cube, three shaded faces.
  minecraft: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><polygon points="12 3 21 7.5 12 12 3 7.5"/><polygon points="3 7.5 12 12 12 21 3 16.5" fill-opacity=".7"/><polygon points="21 7.5 21 16.5 12 21 12 12" fill-opacity=".45"/></svg>',

  // Angular N-zigzag with a diagonal slash stripe alongside.
  masseffect: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M4.6 2h2.9L3.4 22H.5Z"/><path d="M8.5 20V4h3.3l7.1 10.3V4h3.3v16h-3.3L11.8 9.7V20Z"/></svg>',

  // Orb: circle outline, soft x-cross inside.
  xboxgreen: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="8.75" fill="none" stroke="currentColor" stroke-width="2"/><path d="M7.6 7.4c2.9 3.4 5.9 6 8.8 9.2M16.4 7.4c-2.9 3.4-5.9 6-8.8 9.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',

  // 2x2 face-button grid: triangle, circle, cross, square.
  ps: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.8 10.4 9.7H3.6Z"/><circle cx="17" cy="6.9" r="3.2"/><path d="m3.9 14 6.2 6.2M10.1 14l-6.2 6.2"/><rect x="13.9" y="14" width="6.2" height="6.2" rx=".8"/></g></svg>',

  // Filled disc with a bold x cut out.
  xbox: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 7.2 3.7-3.7 2.8 2.8L14.8 12l3.7 3.7-2.8 2.8L12 14.8l-3.7 3.7-2.8-2.8L9.2 12 5.5 8.3l2.8-2.8Z"/></svg>',

  trophy: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M6.5 3h11v4.8a5.5 5.3 0 0 1-11 0Z"/><path d="M6.5 5H3.2v1.2a4.4 4.4 0 0 0 4 4.4M17.5 5h3.3v1.2a4.4 4.4 0 0 1-4 4.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M10.6 12.8h2.8l.5 4.8H10.1Z"/><path d="M7.8 21v-1.6c0-1 .8-1.9 1.9-1.9h4.6c1 0 1.9.9 1.9 1.9V21Z"/></svg>',

  controller: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M7.2 6.5h9.6c3 0 5.5 2.1 6 5l1 4.9a3 3 0 0 1-5.1 2.7L15.6 16H8.4l-3.1 3.1a3 3 0 0 1-5.1-2.7l1-4.9c.5-2.9 3-5 6-5ZM7.3 9h1.8v1.7h1.7v1.8H9.1v1.7H7.3v-1.7H5.6v-1.8h1.7Zm8 2.4a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Zm2.5-2.3a1.3 1.3 0 1 1 0 2.6 1.3 1.3 0 0 1 0-2.6Z"/></svg>',

  home: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M12 3l9 7.6V21h-6.4v-6.2H9.4V21H3V10.6Z"/></svg>',

  sound: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M4 9.2v5.6h3.6L13 19.4V4.6L7.6 9.2Z"/><path d="M15.8 8.7a4.7 4.7 0 0 1 0 6.6M18.4 6.2a8.2 8.2 0 0 1 0 11.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',

  soundOff: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M4 9.2v5.6h3.6L13 19.4V4.6L7.6 9.2Z"/><path d="M15.4 8.4l6.2 7.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',

  sparkle: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true"><path d="M12 2c.7 5.2 4.8 9.3 10 10-5.2.7-9.3 4.8-10 10-.7-5.2-4.8-9.3-10-10 5.2-.7 9.3-4.8 10-10Z"/></svg>',
};
