# @pipeworx/nj-medical-exclusions

Screens a provider or business name, an NPI, or a Vendor ID against New
Jersey's Medicaid provider exclusion/debarment list — the state-level
counterpart to the federal HHS OIG LEIE for New Jersey specifically, and the
sibling of ny-omig-exclusions, ca-medical-exclusions, tx-medical-exclusions,
fl-medical-exclusions, pa-medical-exclusions, ga-medical-exclusions and
oh-medical-exclusions.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1843+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `nj_medical_check_exclusion(name?, npi?, vendor_id?, limit?)` — screens a
  provider or business against the list. An NPI or Vendor ID match is an
  IDENTIFICATION; a name match is a CANDIDATE lead only (no date of birth in
  this data). Every match carries the published action (Debarment,
  Suspension, or Disqualification), the reason code/label, the debarring
  department/agency, and a `currently_excluded` flag DERIVED from the
  expiration date and permanent-debarment flag — `null` with
  `status_unknown:true` when neither signal is present, never a guess.
- `nj_medical_exclusion_coverage(year?, start_date?, end_date?)` — with no
  arguments, reports total rows, how many are currently excluded vs. ended
  vs. status-unknown, how many carry an NPI or Vendor ID, the distinct
  action types, and the oldest/newest effective dates. With `year` or a
  date range, counts how many exclusions took effect in that window
  (counted by `effective_date`, over the whole list, not a page).

## Auth

Keyless.

## Data sources

- New Jersey Department of the Treasury, Division of Revenue and Enterprise
  Services — Ineligible Provider List (Medical) — the state's debarment,
  suspension, and disqualification notices for entities and individuals
  excluded from the New Jersey Medicaid program. No login, no CAPTCHA.

## Notes

- **This is the "ever excluded" file, not "currently excluded only."** Rows
  go back to 1976 and include providers whose debarment/suspension/
  disqualification has since expired or been lifted.
- **No home address is served.** The upstream carries both a business (Firm)
  and a home (Individual) street/city/state/ZIP for every row; neither is
  baked or served here, matching the field set the seven precedent state
  exclusion packs serve.
- **`currently_excluded` is derived, not published.** New Jersey does not
  publish a single current-status field. Only a minority of rows carry an
  expiration date, and the Permanent Debarment flag is Y/N/blank. A row with
  neither signal reports `status_unknown:true` rather than an assumed
  still-active status.
- **No parsed first/last name split** — unlike the TX/PA/NY precedent packs,
  this dataset's Individual Name field is Treasury's own combined display
  string ("LAST, FIRST MIDDLE (TITLE)"), with no separate first/last
  columns. Matching works on the combined string and the Firm Name field.
- **Vendor ID is sparse** — populated on a small minority of rows; an NPI
  match is the more common identification path.
- **One known upstream data-entry artifact**: a single row's effective date
  carries an implausible year ("4014"), kept and reported as published
  rather than silently corrected.
- Refreshed by `scripts/bake-index.mjs`, which re-fetches the published file
  and rebuilds `src/nj-ips-index-data.ts`; re-run periodically and recommit.
  `data_as_of` on every response says how stale the baked copy is.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "nj-medical-exclusions": {
      "url": "https://gateway.pipeworx.io/nj-medical-exclusions/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/nj-medical-exclusions/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1843+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/nj_medical_check_exclusion \
  -H 'Content-Type: application/json' \
  -d '{"name":"ABBASSI"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/nj_medical_check_exclusion`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "nj-medical-exclusions": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-nj-medical-exclusions"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-nj-medical-exclusions
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Nj Medical Exclusions data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
