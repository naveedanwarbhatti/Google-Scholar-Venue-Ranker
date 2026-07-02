/*
 * Standalone smoke test: run a handful of real DBLP-style journal names
 * against the 2024 SCImago CSV using the SHARED journal matcher
 * (core/journal_match.js) — the same code path the content script, the
 * benchmark mirror, and the index generator use.
 *
 * Usage: node GSVR/tests/sjr_smoke_test.js
 */
const fs = require('fs');
const path = require('path');

const jm = require('../core/journal_match.js');

function parseSjrCsv(text) {
  const rows = [];
  let currentField = '';
  let currentRow = [];
  let inQuotes = false;
  const sanitized = text.split(String.fromCharCode(0xfeff)).join('');

  for (let i = 0; i < sanitized.length; i++) {
    const char = sanitized[i];
    if (char === '"') {
      if (inQuotes && sanitized[i + 1] === '"') {
        currentField += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ';' && !inQuotes) {
      currentRow.push(currentField);
      currentField = '';
    } else if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && sanitized[i + 1] === '\n') i++;
      currentRow.push(currentField);
      currentField = '';
      if (currentRow.some(v => v.trim().length > 0)) rows.push(currentRow);
      currentRow = [];
    } else {
      currentField += char;
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.some(v => v.trim().length > 0)) rows.push(currentRow);
  }

  return rows;
}

function loadDataset(year = 2024) {
  // Read SCImago rows for the given year from the unified rankings.csv.
  const text = fs.readFileSync(path.join(__dirname, '..', 'data', 'rankings.csv'), 'utf8');
  const byNormalized = new Map();
  const entries = [];
  let field = '', row = [], inQuotes = false, header = true;
  const endRow = () => {
    row.push(field); field = '';
    if (!header && row.length >= 5) {
      const [source, yStr, title, , rank] = row;
      if (source === 'SCImago' && parseInt(yStr, 10) === year && title && /^Q[1-4]$/.test(rank)) {
        const normalizedTitle = normalizeJournalName(title);
        if (normalizedTitle && !byNormalized.has(normalizedTitle)) {
          const entry = { normalizedTitle, resolvedTitle: title, quartile: rank, tokenSet: createTokenSet(normalizedTitle) };
          byNormalized.set(normalizedTitle, entry);
          entries.push(entry);
        }
      }
    }
    header = false; row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { if (inQuotes && text[i + 1] === '"') { field += '"'; i++; } else inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { row.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !inQuotes) { if (ch === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else field += ch;
  }
  if (field.length || row.length) endRow();
  return { byNormalized, entries };
}

function findBestSjrMatch(normalizedQuery, dataset) {
  const direct = dataset.byNormalized.get(normalizedQuery);
  if (direct) return { entry: direct, score: 1.0 };

  const queryTokens = normalizedQuery.split(' ').map(t => t.trim()).filter(t => t.length >= 3);
  const queryTokenSet = new Set(queryTokens);

  let best = null;
  for (const entry of dataset.entries) {
    let sharesToken = queryTokens.length === 0;
    if (!sharesToken) {
      for (const t of queryTokenSet) {
        if (entry.tokenSet.has(t)) { sharesToken = true; break; }
      }
    }
  }

  return { entries, byNormalized, byIssn, tokenIndex: jm.createSjrTokenIndex(entries) };
}

const dataset = loadDataset(2024);

const examples = [
  'Int. J. Distributed Sens. Networks',
  'Commun. ACM',
  'Comput. Commun. Rev.',
  'J. Syst. Archit.',
  'J. Netw. Comput. Appl.',
  'ACM Comput. Surv.',
  'Int. J. Wirel. Inf. Networks',
  'Inf. Process. Manag.',
  'Information Processing & Management',
];

let failures = 0;
for (const name of examples) {
  const variants = jm.generateJournalNormalizationVariants(name);
  let found = null;
  for (const v of variants) {
    const match = jm.findBestSjrMatch({ normalizedQuery: v, queryIssns: [], dataset, rawQuery: name });
    if (match && match.status === 'matched' && match.entry) {
      found = { ...match, v };
      break;
    }
  }
  if (!found) {
    failures++;
    console.log(`NO MATCH: ${name} -> variants=${variants.join(' | ')}`);
  } else {
    console.log(`MATCH: ${name} -> ${found.entry.resolvedTitle} quartile=${found.entry.quartile} score=${found.score.toFixed(3)} matchedBy=${found.matchedBy} norm=${found.v}`);
  }
}

// Identity-model regression: previously-merged journals must now stay distinct.
const collisionChecks = [
  ['Diabetes', 'Journal of Diabetes'],
  ['Genetics', 'Journal of Genetics'],
  ['Neuroscience', 'Journal of Neuroscience'],
];
for (const [a, b] of collisionChecks) {
  const matchA = jm.findBestSjrMatch({ normalizedQuery: jm.normalizeJournalName(a), queryIssns: [], dataset, rawQuery: a });
  const matchB = jm.findBestSjrMatch({ normalizedQuery: jm.normalizeJournalName(b), queryIssns: [], dataset, rawQuery: b });
  const okA = matchA.status === 'matched' && matchA.entry.resolvedTitle === a;
  const okB = matchB.status === 'matched' && matchB.entry.resolvedTitle === b;
  if (!okA || !okB) {
    failures++;
    console.log(`IDENTITY FAIL: "${a}" -> ${matchA.status}/${matchA.entry?.resolvedTitle}; "${b}" -> ${matchB.status}/${matchB.entry?.resolvedTitle}`);
  } else {
    console.log(`IDENTITY OK: "${a}" (${matchA.entry.quartile}) stays distinct from "${b}" (${matchB.entry.quartile})`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} smoke check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll SJR smoke checks passed.');
}
