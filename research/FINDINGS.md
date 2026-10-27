# Reference-simulator findings

Target: the public system-design simulator at prismhld.com, captured 2026-10-27.
Sources: shipped bundles (`canvas-core.js` 1.3 MB, `canvas-app.js`, no source maps),
public GET payloads, and 17 crafted probes (14 × `POST /simulate`, 3 × `POST /api/stress-test`).
Raw captures contain the reference site's own text and are kept out of the repository (`research/private/`,
git-ignored). `probes/` holds numbers-only copies of the 14 `/simulate` responses for the golden tests, and
`catalog-extracted.json` only the numeric component defaults. REA evidence for the bundle analysis:
`ev_1cf6cb338f5ddec2fde03beb036266fee8884e29f7b20dd09406439da946bb99` (static only, nothing executed).

Legend: **[O]** observed in shipped code or a probe response · **[I]** inferred by fitting probe numbers · **[U]** unknown.

## Architecture
- [O] Vanilla JS, globals on `window`, SVG canvas. No framework, no source maps.
- [O] The simulation runs server-side. Main button → `POST /simulate`; live validation → `POST /api/validate`;
  failure drills → `POST /api/stress-test` (catalogue at `GET /api/stress-test/catalogue`).
- [O] Payload: `{graph:{nodes:[{id,type,config,position,x,y}],edges:[{source,target,connection_type:"sync"|"async",direction}]}, mode, traffic_profile, hints_used}`.
- [O] Node `config` = flattened `{...basic, ...advanced, name, description, basic, advanced}`; ids are `${type}-${counter}`.
- [O] 16 component types with defaults (`catalog-extracted.json`): User, CDN, LoadBalancer, Server, Cache, Database,
  BlobStorage, SearchIndex, Queue, Worker, RateLimiter, Service, APIGateway, ReverseProxy, WebSocketServer, ThirdPartyAPI.
  Each has `basic:{capacity, base_latency}` and type-specific `advanced` settings.

## Traffic model
- [O] Entry load = `User.number_of_users × requests_per_user` rps.
- [O] Capacity = `capacity × replicas` (Service 3 replicas → 3000; LB 50000 × 2 → 100000).
- [I] Database read scaling: `cap = capacity × shards / (w + r / replicas)` with `r = read_ratio/100`, `w = 1 − r`.
  Fits exactly: replicas 3, read 80 % → 4285.7; plus 2 shards → 8571.4.
- [O] `effective_rps = min(incoming, capacity)`; `overflow = incoming − capacity`; downstream sees only `effective_rps`.
- [O] Cache passes `(1 − hit_ratio)` of its traffic downstream (50 % → DB 1000 of 2000; 90 % → 200).
- [I] A node with several children splits its output evenly between them (Service → Queue 500 + DB 500).
- [O] System `error_rate = dropped / incoming` (2000 in, 1000 served → 0.5).

## Latency model
- [O] Node latency = `base_latency + queue_delay`.
- [I] Queue delay is an M/M/c-style (Erlang C) wait with utilisation clamped near 0.99; it is ~0 below 50 %,
  rises steeply past 75 %, and at u ≥ 1 equals ~4.3× base for Service, ~0.5× base for Database, ~7.7× base for Worker.
  Overloaded nodes (u > 1) cap the delay at 10 × base (Service 22 → 220 ms). The exact server count per type is **[U]**;
  our fit uses c ≈ 12/replica (Service/Server), 40/replica (Database), 4 × concurrency (Worker).
- [O] Percentiles: `p95 = lat × (1 + 0.9·u²)`, `p99 = lat × (1 + 1.8·u²)`, with u clamped to 1.5. Exact on every probe.
- [O] End-to-end latency = expected value along the sync path, weighting each child branch by its traffic share;
  async edges add 0 to user-facing latency. (Cache 90 %: 20 + 22 + 5 + 0.1 × 80 = 55 ✓.)

## Health and bottleneck
- [O] Node `status`: `healthy` up to u = 1, `overloaded` when u > 1.
- [I] System status: `healthy` when max u < 0.75, `degrading` for 0.75 ≤ u ≤ 1, `failing` when anything drops traffic.
- [I] `bottleneck_node_id` = hottest node once it reaches 0.75; `null` otherwise.
- [O] `first_failure_rps` = lowest entry rps at which some node saturates; `capacity_headroom = first_failure_rps / incoming`.

## Score
- [O] `total = arch_pts + sim_pts`, max 88 (`arch_max 63`, `sim_max 25`). Grades seen: 25 F, 34–46 D, 54 C.
- [O] Component bonuses: LoadBalancer +5, Service +4 each, Cache +6, Queue +7, Worker +7, any async edge +4.
- [I] `arch_pts = 7 + component bonuses − penalties`.
- [I] `sim_pts`: 20 baseline, 18 when the hottest node is at 100 %, 9 when traffic is dropped, 24 with a cache that cuts latency. Exact formula **[U]**.
- [O] Large rule set of findings: security (auth, HTTPS, rate limit, encryption at rest, backups), topology
  (single server, single DB, no replication), missing components per problem, bottleneck advice.

## Stress test
- [O] Response: `{verdict:{pass,status,breaks_at_rps,headroom,first_to_give,served,latency_ms,why[]}, ramp:[{x,rps,latency_ms,error,hottest,hottest_utilization,load:{id:u}}], scenarios:[{id,name,pass,served,latency_ms,why[]}], focused:[…], components:[…], curves:{failure,spike,latency}}`.
- [O] Ramp multiples 0.25 → 5 × expected load. Scenarios include "3× traffic spike", "Lose a copy of <busiest>",
  "Cache restarts empty", plus the per-area catalogue tests (write surge, read spike, slow queries, hot-key expiry, slow consumers…).
- [O] Retries amplify load under overload (`retry_limit` on Service).

## Clone status
See `src/engine/` – capacity, routing, percentiles, latency aggregation, health, bottleneck and headroom are implemented
to match the observed rules exactly; queue delay and `sim_pts` are approximations. Golden tests in `src/engine/golden.test.ts`.
