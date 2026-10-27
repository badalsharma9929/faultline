# Faultline

A system-design simulator that runs entirely in the browser. Drag components onto a canvas, connect them,
send traffic through, and watch where the design bends and breaks. Then stress-test it with failure drills.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fbadalsharma9929%2Ffaultline&project-name=faultline&repository-name=faultline)

## Features

- **Library**: 53 interview problems in 9 categories, plus 12 real-world architectures
  (Uber, Netflix, WhatsApp, Instagram, YouTube, Twitter/X, Amazon checkout, Airbnb, Spotify, Discord,
  Slack, Stripe) modelled from the companies' engineering write-ups, with sources. Every reference
  design is tested to run healthy at its stated peak load (`src/presets/presets.test.ts`).
- **Practice**: start with only Users, build a design for the problem, then Simulate or Stress test.
- **Learn**: load the reference design for the problem with notes on why it looks that way.
- **Simulate**: per-node load, utilisation, queueing latency, p95/p99, drops, bottleneck, headroom, score.
- **Stress test**: ramps traffic from 0.25× to 5×, then runs failure drills (spike, lost instances,
  write surge, slow queries, cold cache, slow consumers, slow dependency).
- **Traffic weights**: when a component has several outgoing connections, each carries a share of its
  traffic (shown on the edge). Select a connection to set its share; the others keep their proportions.
  Shares default to an even split. In preset flows, `api>cache@9, api>db@1` sends 90% / 10%.
- **Fan-out mode**: a component with several connections either *splits* requests between them (above)
  or *calls all* of them for every request (set it in the component's inspector, or `fanout: 'all'` in a
  preset). Call-all sends full load down every branch, waits for the slowest sync call and fails if any
  sync call fails; async branches never add latency.
- **Adding components**: drag from the palette, or click/tap an item to drop it in a free spot on screen.
- **Export / Import** designs as JSON. The current design is remembered in the browser (`localStorage`).

There is no backend: the simulation engine, problems and your work all live in the browser, so the
production build is a set of static files.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm run dev      # http://localhost:5183
npm test         # engine and preset tests, including golden replays of reference probes
npm run e2e      # editor interactions in headless Edge/Chrome (needs npm run dev); screenshots in e2e/shots/
npm run build    # type-checks and builds static files into dist/
npm run preview  # serves dist/ locally
```

## Deploy to Vercel

The app is a static Vite build, so it deploys to Vercel with no server configuration.
`vercel.json` pins the settings: build command `npm run build`, output directory `dist`, framework Vite.

### Option 1: one click

Click **Deploy with Vercel** above. Vercel copies this repository to your GitHub account, builds it and
gives you a URL. Every push to the default branch then redeploys automatically.

### Option 2: import from the dashboard

1. Push this repository to GitHub (or fork it).
2. In Vercel, choose **Add New → Project** and import the repository.
3. Leave the detected settings as they are (Framework **Vite**, Build **`npm run build`**, Output **`dist`**).
   No environment variables are needed.
4. Click **Deploy**. Pushes to the default branch deploy to production; pull requests get preview URLs.

### Option 3: Vercel CLI

```bash
npm i -g vercel
vercel login
vercel          # first run links the folder to a project and creates a preview deployment
vercel --prod   # deploys to production
```

### Notes

- Fonts load from Google Fonts at runtime; everything else is bundled.
- The app has a single route, so no rewrites are needed. If you add client-side routes later, add a
  rewrite to `index.html` in `vercel.json`.
- `npm run e2e` and the files in `research/` and `scripts/` are development tools; they are not part
  of the deployed site.

## How the simulation works

`src/engine/` is a framework-free TypeScript simulator. Load starts at the Users node and flows along
connections; each component has a per-instance capacity and base latency, scaled by replicas, shards,
cache hit ratio and similar settings. Queueing delay follows an M/M/c (Erlang C) model, and p95/p99 grow
with utilisation. The model was rebuilt from the observed behaviour of a public reference simulator;
`research/FINDINGS.md` records what was observed, what was inferred, and what is approximated.

## Code map

- `src/engine/`: simulator (`simulate.ts`, `stress.ts`, `score.ts`, `findings.ts`, `catalog.ts`, `graph.ts`).
- `src/canvas/`, `src/App.tsx`, `src/store.ts`: React Flow UI and state.
- `src/presets/`: problems in `problems/*.ts`, written with the small `problem()` / flow DSL in `dsl.ts`;
  real-world architectures come from `data/companies.json` and are sized by the engine.
- `scripts/check-presets.ts`: prints how every reference design behaves at its load
  (`npx vite-node scripts/check-presets.ts`). `scripts/list-fanouts.ts` and `scripts/suggest-sizing.ts`
  help when editing designs.
- `research/`: findings and numbers-only reference probes used by the golden tests.
