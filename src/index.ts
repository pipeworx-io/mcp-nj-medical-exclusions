interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Shared "count records by a named date field over a year or range" helper —
 * fleet #3170.
 *
 * WHY THIS EXISTS. Four baked-table packs (ny-omig-exclusions,
 * tx-medical-exclusions, ca-medical-exclusions, fl-medical-exclusions) each
 * hold thousands of rows and each had only a list-wide total — no way to
 * answer "how many took effect in year Y" without a caller paging through
 * every row itself. A benchmark probe (fleet #3170/#3149) asked exactly that
 * question against two of them and both returned the SAME list-wide total on
 * every one of 7-8 rounds; the model ran out of rounds and refused rather
 * than get a wrong number. This is the one piece of that fix every pack
 * shares: parsing `year` or `start_date`/`end_date` into an inclusive
 * YYYY-MM-DD range, or a NAMED reason when the input can't be turned into
 * one. It deliberately never returns a silent zero for a bad argument —
 * root CLAUDE.md's silent-zero policy applies to a malformed count request
 * exactly as it does to an upstream outage.
 *
 * WHAT IT DOES NOT DO. It does not touch the rows — each pack's own ISO date
 * field (already YYYY-MM-DD in every one of these four) is filtered by plain
 * string comparison, which is correct for YYYY-MM-DD strings and avoids a
 * Date() parse / timezone trap entirely. Each pack is responsible for saying
 * which of its own fields it counted (data varies: NY/TX/CA have exactly one
 * exclusion-date field each; FL additionally splits "all sanction orders" vs
 * "participation exclusions" within the matched range).
 */

interface DateRange {
  /** Inclusive start date, YYYY-MM-DD. */
  start: string;
  /** Inclusive end date, YYYY-MM-DD. */
  end: string;
  /** Human label for the range, e.g. "2025" or "2024-06-01 to 2025-06-01". */
  label: string;
}

interface DateRangeError {
  error: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Reads `args.year`, `args.start_date` and `args.end_date` and returns:
 *   - `null` if none were passed (no date-range count was requested at all —
 *     the caller should fall through to its normal, non-counting response);
 *   - `{ error }` if something WAS passed but can't be turned into a valid
 *     range (bad format, start after end, year out of a sane bound) — the
 *     caller must surface this as a named reason, never as a zero count;
 *   - `{ start, end, label }` otherwise.
 *
 * start_date/end_date, if either is present, take precedence over `year`
 * (an explicit range is a more specific request than a calendar year).
 */
function parseYearOrDateRange(args: Record<string, unknown>): DateRange | DateRangeError | null {
  const startRaw = typeof args.start_date === 'string' ? args.start_date.trim() : '';
  const endRaw = typeof args.end_date === 'string' ? args.end_date.trim() : '';
  const yearRaw = args.year;
  const yearGiven = yearRaw !== undefined && yearRaw !== null && yearRaw !== '';

  if (!startRaw && !endRaw && !yearGiven) return null;

  if (startRaw || endRaw) {
    if (!DATE_RE.test(startRaw) || !DATE_RE.test(endRaw)) {
      return {
        error:
          `start_date and end_date must BOTH be present and in YYYY-MM-DD form ` +
          `(got start_date=${startRaw ? JSON.stringify(startRaw) : '(missing)'}, end_date=${endRaw ? JSON.stringify(endRaw) : '(missing)'}).`,
      };
    }
    if (startRaw > endRaw) {
      return { error: `start_date (${startRaw}) is after end_date (${endRaw}).` };
    }
    return { start: startRaw, end: endRaw, label: startRaw === endRaw ? startRaw : `${startRaw} to ${endRaw}` };
  }

  const year = Math.floor(Number(yearRaw));
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return { error: `year must be a 4-digit calendar year between 1900 and 2100 (got ${JSON.stringify(yearRaw)}).` };
  }
  return { start: `${year}-01-01`, end: `${year}-12-31`, label: String(year) };
}

function isDateRangeError(r: DateRange | DateRangeError | null): r is DateRangeError {
  return r != null && typeof (r as DateRangeError).error === 'string';
}

/** Inclusive YYYY-MM-DD membership test; `null`/empty dates never match. */
function inRange(date: string | null | undefined, range: DateRange): boolean {
  return Boolean(date) && (date as string) >= range.start && (date as string) <= range.end;
}

const DATE_RANGE_ARG_SCHEMA = {
  year: {
    type: 'number' as const,
    description: 'Count records whose date field falls in this calendar year (e.g. 2025), counted over the WHOLE list, not a page. Ignored if start_date/end_date are given.',
  },
  start_date: {
    type: 'string' as const,
    description: 'Inclusive range start, YYYY-MM-DD. Use with end_date for a custom date range instead of a calendar year.',
  },
  end_date: {
    type: 'string' as const,
    description: 'Inclusive range end, YYYY-MM-DD. Use with start_date for a custom date range instead of a calendar year.',
  },
};
/**
 * New Jersey Department of the Treasury Ineligible Provider List (Medical
 * category) screening — fleet #3281, the eighth state exclusion pack after
 * mcps/ny-omig-exclusions (#2788), mcps/ca-medical-exclusions (#2805),
 * mcps/tx-medical-exclusions (#2809), mcps/fl-medical-exclusions,
 * mcps/pa-medical-exclusions (#3277), mcps/ga-medical-exclusions (#3279)
 * and mcps/oh-medical-exclusions (#3278).
 *
 * Beside the federal HHS OIG LEIE (mcps/leie) and the SAM federal
 * exclusions list, New Jersey runs its own Medicaid exclusion list through
 * the Department of the Treasury's Division of Revenue and Enterprise
 * Services: individuals and entities debarred, suspended, or disqualified
 * from New Jersey's Medicaid program. This is that list, for New Jersey
 * only — one pack per jurisdiction (root CLAUDE.md rule 5).
 *
 * SOURCE AND SHAPE. Treasury's "Medical Debarment Search" page
 * (https://www.nj.gov/treasury/revenue/debarment/debarsearch-medical.shtml)
 * states plainly: "The Ineligible Provider List serves to provide notice
 * that an entity and/or an individual is excluded from the New Jersey
 * Medicaid program." It links a plain, unauthenticated tab-delimited
 * download of the whole list — no login, no CAPTCHA, verified live
 * 2026-10-18 with a laptop curl: 200, text/plain, 4,089 usable data rows.
 * See scripts/bake-index.mjs for the full column layout and the code->label
 * tables for Reason, Debarring Department, and Debarring Agency.
 *
 * Root CLAUDE.md's standing rule 3 still applies regardless of
 * reachability: a baked table this size never sits in gateway module
 * scope. It is baked into src/nj-ips-index-data.ts, registered in
 * workers/gateway/src/pack-baked-indexes.json, uploaded to KV at deploy,
 * and injected here as `args._bakedIndex` — same pattern as the seven
 * precedent packs (fleet #2754).
 *
 * This is an official New Jersey State public enforcement record that
 * Treasury's Division of Revenue and Enterprise Services publishes
 * specifically so providers, payers and the public can screen against it —
 * baking a copy needs no reuse grant, same footing as the federal LEIE and
 * the seven precedent state packs.
 *
 * NO HOME ADDRESS — this source carries both a business (Firm) and a home
 * (Individual) street/city/state/ZIP for every row; neither is baked or
 * served here, matching the field set the seven precedent packs serve (root
 * CLAUDE.md's personal-data carve-out and the task that filed this pack: do
 * not add home addresses beyond what the existing packs serve).
 *
 * ACTION IS ONE OF THREE KINDS, NOT A SINGLE "EXCLUDED" FLAG — Debarment,
 * Suspension, or Disqualification, served as published under `action`.
 * `currently_excluded` is DERIVED from Expiration Date and the Permanent
 * Debarment flag, never guessed: only ~12% of rows carry an expiration
 * date, so a row with neither an expiration date nor a permanent-debarment
 * flag is reported `currently_excluded: null, status_unknown: true` rather
 * than assumed still-active.
 *
 * THIS IS THE "EVER EXCLUDED" FILE, NOT "CURRENTLY EXCLUDED ONLY" — same
 * shape as every precedent pack: rows go back to 1976 and include providers
 * whose debarment/suspension has since expired.
 *
 * MATCHING MODEL, same discipline as the seven precedent packs: an NPI or
 * vendor ID match identifies a specific provider or business (both are
 * exact, provider/business-specific identifiers in this data). A name
 * match — even an exact one — is a CANDIDATE, never an identification: this
 * list has no date of birth, and common surnames repeat across 4,089 rows
 * spanning 1976-2026.
 *
 * Keyless.
 */
import type { NjIpsRow } from './nj-ips-index-data.js';

// fleet #2754 / root CLAUDE.md rule 3 — the baked table is injected by the
// gateway as `args._bakedIndex`, loaded from KV once per isolate. NEVER
// value-import ./nj-ips-index-data.js here — only the type-only import
// above, which is erased at compile time. A value import puts the whole
// table back in the bundle and into every isolate's heap;
// scripts/check-gateway-bundle-size.mjs fails the deploy if that happens.
let ROWS: NjIpsRow[] = [];
let DATA_AS_OF = '';
let SOURCE_URL = '';
let SEARCH_URL = '';
let CAPTURED_AT = '';
let TOTAL_ROWS = 0;

function ensureIndex(args: Record<string, unknown>): void {
  if (ROWS.length) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const rows = idx?.NJ_IPS_ROWS;
  if (!Array.isArray(rows) || rows.length === 0) {
    // Loud on purpose (root CLAUDE.md rule 2): answering "no match found"
    // from an empty table would be a silent wrong answer, indistinguishable
    // from a real clean screening result.
    throw new Error(
      `nj-medical-exclusions: the baked NJ Treasury Ineligible Provider List index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into this pack; this is a server-side fault, not a bad query — retry shortly.',
    );
  }
  ROWS = rows as NjIpsRow[];
  DATA_AS_OF = String(idx?.NJ_IPS_DATA_AS_OF ?? '');
  SOURCE_URL = String(idx?.NJ_IPS_SOURCE_URL ?? 'https://www.nj.gov/treasury/treasfiles/debarment/Debarment-MEDICAL.txt');
  SEARCH_URL = String(idx?.NJ_IPS_SEARCH_URL ?? 'https://www.nj.gov/treasury/revenue/debarment/debarsearch-medical.shtml');
  CAPTURED_AT = String(idx?.NJ_IPS_CAPTURED_AT ?? '');
  TOTAL_ROWS = Number(idx?.NJ_IPS_TOTAL_ROWS ?? ROWS.length);
}

const SOURCE_LABEL = 'New Jersey Department of the Treasury, Division of Revenue and Enterprise Services — Ineligible Provider List (Medical)';

const STATUS_CAVEAT =
  'This dataset does not publish a single current-status field. currently_excluded is DERIVED: true only when an expiration_date is in the future AND permanent_debarment is not true is treated separately — see ever_vs_current_caveat. A row with no expiration_date and no permanent_debarment flag (the large majority) is reported currently_excluded:null, status_unknown:true rather than assumed still active.';

const EVER_VS_CURRENT_CAVEAT =
  'This is New Jersey Treasury\'s "ever excluded" Ineligible Provider List (Medical), not a currently-excluded-only list — it includes providers whose debarment, suspension, or disqualification has since expired, with rows going back to 1976. action is one of DEBARMENT, SUSPENSION, or DISQUALIFICATION, as published; it does not by itself mean currently active (see status_caveat).';

const NOT_AN_ANSWER =
  'Name matches are CANDIDATES, not identifications — this list has no date of birth to tell same-named providers apart. Only an NPI or Vendor ID match identifies a specific provider or business. Confirm a name match against one of those before acting on it.';

function normalize(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

function isTenDigitNpi(s: string): boolean {
  return /^\d{10}$/.test(s);
}

function displayName(r: NjIpsRow): string {
  return r.individual_name || r.firm_name || 'Unknown';
}

function currentlyExcluded(r: NjIpsRow): boolean | null {
  if (r.permanent_debarment === true) return true;
  if (r.expiration_date) {
    const today = new Date().toISOString().slice(0, 10);
    return r.expiration_date > today;
  }
  return null;
}

type MatchType = 'npi_match' | 'vendor_id_match' | 'name_candidate_exact' | 'name_candidate_partial';

const MATCH_MEANING: Record<MatchType, string> = {
  npi_match: 'The NPI matched exactly against this provider\'s listed NPI. An NPI identifies one provider, so this is an identification.',
  vendor_id_match: 'The Vendor ID matched exactly. A Vendor ID identifies one business/provider record in this data, so this is an identification.',
  name_candidate_exact: 'The name matched exactly (individual name or firm name), but this list has no date of birth to confirm it is the same person or entity — several excluded providers can share a name. Confirm with NPI or Vendor ID before acting.',
  name_candidate_partial: 'The name is a partial/substring match, not exact, checked against the individual name and firm name. Treat as a lead to check, not a finding. Confirm with NPI or Vendor ID.',
};

function shape(r: NjIpsRow, matchType: MatchType) {
  const current = currentlyExcluded(r);
  return {
    individual_name: r.individual_name,
    firm_name: r.firm_name,
    vendor_id: r.vendor_id,
    npi: r.npi,
    action: r.action,
    reason: r.reason_label ?? r.reason_code,
    reason_code: r.reason_code,
    debarring_department: r.debarring_department_label ?? r.debarring_department_code,
    debarring_agency: r.debarring_agency_label ?? r.debarring_agency_code,
    currently_excluded: current,
    status_unknown: current === null,
    permanent_debarment: r.permanent_debarment,
    effective_date: r.effective_date,
    expiration_date: r.expiration_date,
    match_type: matchType,
    what_that_means: MATCH_MEANING[matchType],
  };
}

async function checkExclusion(args: Record<string, unknown>) {
  const nameRaw = typeof args.name === 'string' ? args.name.trim() : '';
  const npiRaw = typeof args.npi === 'string' ? digitsOnly(args.npi) : '';
  const vendorIdRaw = typeof args.vendor_id === 'string' ? args.vendor_id.trim() : '';

  if (!nameRaw && !npiRaw && !vendorIdRaw) {
    return {
      found: false,
      reason: 'no_query',
      hint: 'Pass name (the provider or business to screen), and/or npi, and/or vendor_id. An NPI or Vendor ID match is an identification; a name match is a lead.',
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  const limit = Math.max(1, Math.min(50, Math.floor(typeof args.limit === 'number' ? args.limit : 10)));

  const npiMatches = npiRaw && isTenDigitNpi(npiRaw) ? ROWS.filter((r) => r.npi && digitsOnly(r.npi) === npiRaw) : [];
  const vendorMatches = vendorIdRaw ? ROWS.filter((r) => r.vendor_id && r.vendor_id.trim() === vendorIdRaw) : [];

  const identitySeen = new Set<NjIpsRow>();
  const identityResults: ReturnType<typeof shape>[] = [];
  for (const r of npiMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'npi_match'));
  }
  for (const r of vendorMatches) {
    if (identitySeen.has(r)) continue;
    identitySeen.add(r);
    identityResults.push(shape(r, 'vendor_id_match'));
  }

  let nameResults: ReturnType<typeof shape>[] = [];
  if (nameRaw) {
    const qNorm = normalize(nameRaw);
    const qTokens = qNorm.split(' ').filter(Boolean);
    const exact: ReturnType<typeof shape>[] = [];
    const partial: ReturnType<typeof shape>[] = [];
    for (const r of ROWS) {
      if (identitySeen.has(r)) continue;
      const indivNorm = r.individual_name ? normalize(r.individual_name) : '';
      const firmNorm = r.firm_name ? normalize(r.firm_name) : '';
      if ((indivNorm && qNorm === indivNorm) || (firmNorm && qNorm === firmNorm)) {
        exact.push(shape(r, 'name_candidate_exact'));
      } else if (
        qTokens.length > 0 &&
        qTokens.every((t) => indivNorm.includes(t) || firmNorm.includes(t))
      ) {
        partial.push(shape(r, 'name_candidate_partial'));
      }
    }
    nameResults = [...exact, ...partial];
  }

  const combined = [...identityResults, ...nameResults];
  const truncated = combined.length > limit;
  const matches = combined.slice(0, limit);

  if (matches.length === 0) {
    return {
      found: false,
      result: 'No match found in the New Jersey Treasury Ineligible Provider List (Medical) for that provider.',
      screened: { name: nameRaw || null, npi: npiRaw || null, vendor_id: vendorIdRaw || null },
      caveat: `This checks the New Jersey Treasury Ineligible Provider List (Medical) only. It does not cover the federal HHS OIG LEIE, the federal SAM exclusions list, or any other state's Medicaid exclusion list (see ny-omig-exclusions, ca-medical-exclusions, tx-medical-exclusions, fl-medical-exclusions, pa-medical-exclusions, ga-medical-exclusions, oh-medical-exclusions). ${EVER_VS_CURRENT_CAVEAT}`,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }

  return {
    found: true,
    screened: { name: nameRaw || null, npi: npiRaw || null, vendor_id: vendorIdRaw || null },
    count: matches.length,
    truncated,
    matches,
    not_an_identification: NOT_AN_ANSWER,
    status_caveat: STATUS_CAVEAT,
    ever_vs_current_caveat: EVER_VS_CURRENT_CAVEAT,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
    data_as_of: DATA_AS_OF,
  };
}

async function coverage(args: Record<string, unknown>) {
  const withNpi = ROWS.filter((r) => r.npi).length;
  const withVendorId = ROWS.filter((r) => r.vendor_id).length;
  const currentlyExcludedCount = ROWS.filter((r) => currentlyExcluded(r) === true).length;
  const endedCount = ROWS.filter((r) => currentlyExcluded(r) === false).length;
  const statusUnknownCount = ROWS.filter((r) => currentlyExcluded(r) === null).length;
  const dates = ROWS.map((r) => r.effective_date).filter((d): d is string => Boolean(d)).sort();
  const actions = new Set(ROWS.map((r) => r.action).filter(Boolean));

  // fleet #3170: count-by-date-range mode, same as the seven precedent state
  // packs. Counted field is effective_date (Treasury's "Effective Date" —
  // when the debarment/suspension/disqualification took effect). This
  // dataset has no separate "date added to the published list" field, so
  // there is no second date to confuse it with.
  const range = parseYearOrDateRange(args);
  if (isDateRangeError(range)) {
    return {
      found: false,
      reason: 'invalid_date_range',
      hint: range.error,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
      data_as_of: DATA_AS_OF,
    };
  }
  if (range) {
    const count = ROWS.filter((r) => inRange(r.effective_date, range)).length;
    return {
      found: true,
      mode: 'date_range_count',
      count,
      date_field_counted: 'effective_date — Treasury\'s Effective Date (when the debarment, suspension, or disqualification took effect).',
      range: { start: range.start, end: range.end, label: range.label },
      counted_over: 'the whole list (4,000+ rows), not a page',
      total_rows_all_time: TOTAL_ROWS,
      oldest_effective_date: dates[0] ?? null,
      newest_effective_date: dates[dates.length - 1] ?? null,
      data_as_of: DATA_AS_OF,
      index_captured_at: CAPTURED_AT,
      ever_vs_current_caveat: EVER_VS_CURRENT_CAVEAT,
      source: SOURCE_LABEL,
      source_url: SOURCE_URL,
    };
  }

  return {
    found: true,
    total_rows: TOTAL_ROWS,
    currently_excluded: currentlyExcludedCount,
    ended: endedCount,
    status_unknown: statusUnknownCount,
    with_npi: withNpi,
    with_vendor_id: withVendorId,
    distinct_actions: [...actions].sort(),
    oldest_effective_date: dates[0] ?? null,
    newest_effective_date: dates[dates.length - 1] ?? null,
    data_as_of: DATA_AS_OF,
    index_captured_at: CAPTURED_AT,
    status_caveat: STATUS_CAVEAT,
    ever_vs_current_caveat: EVER_VS_CURRENT_CAVEAT,
    search_url: SEARCH_URL,
    source: SOURCE_LABEL,
    source_url: SOURCE_URL,
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'nj_medical_check_exclusion',
    description:
      'Is this healthcare provider debarred, suspended, or disqualified from the New Jersey Medicaid program? Screens a person or business name, an NPI, and/or a Vendor ID against the New Jersey Department of the Treasury Ineligible Provider List (Medical) — the state-level counterpart to the federal HHS OIG LEIE (see the leie pack) for New Jersey specifically, and the sibling of ny_omig_check_exclusion (New York), ca_medical_check_exclusion (California), tx_medical_check_exclusion (Texas), fl_medical_check_exclusion (Florida), pa_medical_check_exclusion (Pennsylvania), ga_medical_check_exclusion (Georgia) and oh_medical_check_exclusion (Ohio). Answers "is this provider excluded from New Jersey Medicaid", "check this NPI against the NJ Ineligible Provider List", or pre-payment/credentialing screening for a New Jersey Medicaid provider. '
      + 'An NPI or Vendor ID match is an IDENTIFICATION (both are exact, provider- or business-specific identifiers); a name match — even an exact one — is a CANDIDATE lead only, since this list carries no date of birth to tell same-named providers apart. Every match carries the published action (Debarment, Suspension, or Disqualification), the reason code and label, the debarring department and agency, and a currently_excluded flag DERIVED from the expiration date and permanent-debarment flag — null with status_unknown:true on the majority of rows that carry neither, rather than a guess. This dataset covers everyone EVER excluded, not only those currently excluded. Pass npi or vendor_id to turn a name lead into an identification. Sourced from the New Jersey Department of the Treasury Ineligible Provider List (Medical), keyless.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Provider or business name to screen, e.g. "Smith, John" or "Acme Home Health Inc". Matched against the individual name and firm name, any word order.' },
        npi: { type: 'string', description: 'The provider\'s 10-digit NPI, if known. An NPI match is an identification rather than a name lead — always pass it when known.' },
        vendor_id: { type: 'string', description: 'New Jersey Vendor ID of the business, if known. A Vendor ID match is an identification. Populated on a small minority of rows.' },
        limit: { type: 'number', description: 'Maximum matches to return (default 10, max 50).' },
      },
    },
  },
  {
    name: 'nj_medical_exclusion_coverage',
    description:
      'What the New Jersey Treasury Ineligible Provider List (Medical) data covers and how current it is: total rows ever recorded, how many are currently excluded vs. ended vs. status-unknown, how many carry an NPI or Vendor ID, the distinct action types (Debarment/Suspension/Disqualification), and the oldest/newest exclusion effective dates. Use to check the screening data is fresh enough to rely on before a compliance decision, and to see the one-line notes on the status field\'s gaps and the ever-vs-currently-excluded distinction. '
      + 'Pass year (e.g. 2025) or start_date/end_date to instead COUNT how many exclusions have an effective date in that year or range, counted over the whole 4,000+ row list, not a page — answers "how many NJ Medicaid exclusions took effect in 2025". The response names the date field counted (effective_date — Treasury\'s Effective Date). Sourced from the New Jersey Department of the Treasury Ineligible Provider List (Medical), keyless.',
    inputSchema: { type: 'object' as const, properties: { ...DATE_RANGE_ARG_SCHEMA } },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  ensureIndex(args);
  switch (name) {
    case 'nj_medical_check_exclusion':
      return checkExclusion(args);
    case 'nj_medical_exclusion_coverage':
      return coverage(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export { tools, callTool };
export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
