# opencode.db read-only queries

Validated against OpenCode **1.18.x** on a real 5.7 GB database (2026-08). If a column
errors out after an OpenCode upgrade, report the schema mismatch — do not improvise
guesses about the new schema.

## Connection — always read-only

OpenCode keeps this database open (WAL). Concurrent readers are fine; writers are not.

```bash
sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro" "SELECT ..."
```

No `sqlite3` CLI? Use bun:sqlite read-only:

```ts
import { Database } from "bun:sqlite";
const db = new Database(`${process.env.HOME}/.local/share/opencode/opencode.db`, { readonly: true });
```

Respect `$XDG_DATA_HOME`/`$OPENCODE_DATA_HOME` if the user has a custom data dir
(check the effective OpenCode config before assuming the default path).

## Schema orientation

- `session` — one row per session. `version` is the **OpenCode version** that created
  it. Cost/token aggregate columns: `cost`, `tokens_input`, `tokens_output`,
  `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`. `time_created` is
  epoch **milliseconds**.
- `message` — one row per message; `data` JSON carries `role`, `providerID`,
  `modelID`, `agent`, `cost`, `tokens` for assistant messages.
- `part` — one row per message part; `data` JSON with `type: "step-finish"` carries
  final per-step tokens: `tokens.input`, `tokens.output`, `tokens.reasoning`,
  `tokens.cache.read`, `tokens.cache.write`.

## Hit-rate formula (must match the vvoc CLI)

`cacheRead / (cacheRead + cacheWrite + input)` **summed over cache-eligible steps**
( eligible := cache.read + cache.write > 0 ), token-weighted. `NULLIF` guards the
division; NULL hit rate means "no eligible steps" → report `n/a`, not 0%.

## (a) Cache hit rate by OpenCode version

```sql
SELECT s.version AS opencode,
       COUNT(*) AS steps,
       SUM(CASE WHEN json_extract(p.data,'$.tokens.cache.read')
                 + json_extract(p.data,'$.tokens.cache.write') > 0
            THEN 1 ELSE 0 END) AS eligible,
       ROUND(100.0 * SUM(json_extract(p.data,'$.tokens.cache.read')) /
             NULLIF(SUM(json_extract(p.data,'$.tokens.cache.read')
                      + json_extract(p.data,'$.tokens.cache.write')
                      + json_extract(p.data,'$.tokens.input')), 0), 1) AS hit_pct
FROM part p JOIN session s ON s.id = p.session_id
WHERE json_extract(p.data,'$.type') = 'step-finish'
GROUP BY s.version
ORDER BY MIN(s.time_created) DESC;
```

## (b) Cache hit rate by month

```sql
SELECT strftime('%Y-%m', p.time_created/1000, 'unixepoch') AS month,
       COUNT(*) AS steps,
       ROUND(100.0 * SUM(json_extract(p.data,'$.tokens.cache.read')) /
             NULLIF(SUM(json_extract(p.data,'$.tokens.cache.read')
                      + json_extract(p.data,'$.tokens.cache.write')
                      + json_extract(p.data,'$.tokens.input')), 0), 1) AS hit_pct
FROM part p
WHERE json_extract(p.data,'$.type') = 'step-finish'
GROUP BY month
ORDER BY month DESC;
```

## (c) Recent sessions: cost and token totals

Straight from the session table — no JSON extraction needed:

```sql
SELECT substr(s.id, 1, 8) AS session,
       s.title,
       s.version AS opencode,
       ROUND(s.cost, 3) AS cost,
       s.tokens_cache_read  AS cache_read,
       s.tokens_cache_write AS cache_write,
       s.tokens_input       AS fresh_in,
       datetime(s.time_created/1000, 'unixepoch') AS started
FROM session s
ORDER BY s.time_created DESC
LIMIT 20;
```

Caveat: `cost` is what OpenCode recorded (often `0` for subscription/zai providers);
say "recorded cost" in findings, do not treat 0 as free.

## (d) Step-finish counts by provider/model

Model attribution lives on the message, so join through it:

```sql
SELECT json_extract(m.data,'$.providerID') AS provider,
       json_extract(m.data,'$.modelID')    AS model,
       COUNT(*) AS steps
FROM part p JOIN message m ON m.id = p.message_id
WHERE json_extract(p.data,'$.type') = 'step-finish'
GROUP BY provider, model
ORDER BY steps DESC;
```

To get hit rate per model instead of counts, wrap snippet (a)'s `SUM/NULLIF`
expression in the same query but group by `json_extract(m.data,'$.providerID') ||
'/' || json_extract(m.data,'$.modelID')`.
