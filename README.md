# Dyer HQ — Personal Dashboard

A PS5-style personal dashboard, built as a zero-build static web app and served by a
Cloudflare Worker. One horizontal tile rail launches everything:

| Tile | What it is |
| --- | --- |
| **GitHub Projects** | Every repo on [github.com/Rehchu](https://github.com/Rehchu), fetched live from the GitHub API |
| **Fitness** | Workout log, weigh-ins, streaks, 14-day activity and weight-trend charts (stored on-device) |
| **Book Writing** | Writing studio for the Dragons book — chapters, word-count goals, autosave, Markdown export |
| **Notebook** | Pressure-sensitive handwriting canvas made for Apple Pencil on iPad — pages, undo, PNG export |
| **Arise Hub** | [arisehub.myfaithtech.com](https://arisehub.myfaithtech.com) |
| **Arise Church Website** | [arisecenla.church](https://www.arisecenla.church/) |
| **ApexCoach** | [apextraining.dev](https://apextraining.dev) |
| **Ctrl+Alt PC Repair** | [ctrl-alt-pc-repair.dyer-hq.workers.dev](https://ctrl-alt-pc-repair.dyer-hq.workers.dev) |
| **Arise IT Portal / Super Spork / 3D Models** | The rest of the workshop |

## Themes

Five game skins, switchable from the top-right (or press `t`), remembered per device:
**Assassin's Creed** · **Cyberpunk** · **GTA V** · **Minecraft** · **Mass Effect**

## Console controls

`←` `→` browse the rail · `Enter` open · `Esc` back — or click/tap. Tiles for the
built-in modules open full-screen; app tiles launch in a new tab.

## Apple Pencil notebook

The notebook uses pointer events with coalescing, so Pencil strokes are smooth and
pressure-sensitive. Options: pen / highlighter / eraser, colors, stroke size,
**pressure** on/off, and **pencil only** (palm rejection — fingers won't draw).
Pages are stored as vector strokes in `localStorage` and re-render crisply at any
size; export any page as PNG.

> Tip: on iPad, open the deployed site in Safari and use **Share → Add to Home
> Screen** for a full-screen, console-like app.

## Data & privacy

Fitness logs, book chapters, and notebook pages live entirely in the browser's
`localStorage` on the device you use — nothing is sent to a server. The only
outbound request is the public GitHub API for the repo list.

## Develop

```sh
npm install
npm run dev        # wrangler dev → http://localhost:8787
```

No build step — plain HTML/CSS/ES modules in `public/`.

## Deploy to Cloudflare

Manual (first time run `npx wrangler login`):

```sh
npm run deploy     # → https://personal-dashboard.<your-subdomain>.workers.dev
```

Automatic — every push to `main` deploys via GitHub Actions
(`.github/workflows/deploy.yml`). Add two repository secrets under
**Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — create at dash.cloudflare.com → My Profile → API Tokens
  with the **Edit Cloudflare Workers** template
- `CLOUDFLARE_ACCOUNT_ID` — shown in the Cloudflare dashboard's right sidebar

## Structure

```
public/
  index.html          shell (rail, hero, module host)
  css/base.css        PS5-style layout + shared component styles
  css/themes.css      the five game themes (design tokens + fx layers)
  js/main.js          rail focus/keyboard/theming/module host
  js/data.js          tile definitions (apps, links, accents)
  js/github.js        live repo cards (cached 10 min)
  js/fitness.js       workouts, weigh-ins, streaks, charts
  js/writing.js       books → chapters editor, goals, .md export
  js/notebook.js      Apple Pencil vector canvas
  js/charts.js        tiny SVG line/bar charts with tooltips
  js/store.js         namespaced localStorage helpers
wrangler.jsonc        Cloudflare Worker (static assets only)
```
