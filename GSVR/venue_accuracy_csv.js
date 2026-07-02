#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { loadProductionMatcher } = require('./match_cli.js');

const DEFAULT_CSV = path.join(__dirname, 'tests', 'fixtures', 'venue_accuracy.csv');

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (inQuotes) {
    throw new Error('CSV parse error: unclosed quoted field');
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const RANK_LABELS = new Set(['A*', 'A', 'B', 'C', 'Q1', 'Q2', 'Q3', 'Q4', 'N/A']);

function normalizeRankValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (['NA', 'N.A.', 'NONE', 'NOT FOUND', 'UNRANKED'].includes(upper)) return 'N/A';
  return upper;
}

function normalizeOutcomeLabel(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const upper = raw.toUpperCase();
  if (RANK_LABELS.has(upper)) return upper;
  const lower = raw.toLowerCase().replace(/\s+/g, ' ');
  if (lower === 'venue not in dblp') return 'N/A';
  if (lower === 'ambiguous venue match' || lower === 'ambiguous dblp venue match') return 'ambiguous';
  if (lower === 'not found' || lower === 'missing') return 'N/A';
  return lower;
}

function classifyExpected(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { type: 'missing', display: '', value: '' };
  if (raw === 'N/A') return { type: 'rank', display: 'N/A', value: 'N/A' };
  const rank = normalizeRankValue(raw);
  if (RANK_LABELS.has(rank) && rank !== 'N/A') {
    return { type: 'rank', display: rank, value: rank };
  }
  if (['NA', 'N.A.', 'NONE', 'NOT FOUND'].includes(raw.toUpperCase())) {
    return { type: 'rank', display: 'N/A', value: 'N/A' };
  }
  const label = normalizeOutcomeLabel(raw);
  return { type: 'label', display: raw, value: label };
}

function getActualOutcome(decision) {
  const rank = normalizeRankValue(decision?.rank || 'N/A');
  const reason = decision?.naReason || decision?.reason || '';
  const reasonLabel = normalizeOutcomeLabel(reason);
  return {
    rank,
    label: rank === 'N/A' ? (reasonLabel || 'N/A') : rank,
    display: rank === 'N/A' && reason ? reason : rank,
  };
}

function matchesExpected(expected, actual) {
  if (expected.type === 'rank') return actual.rank === expected.value;
  if (expected.type === 'label') {
    if (actual.label === expected.value) return true;
    if (expected.value === 'unranked' && String(actual.label || '').startsWith('unranked')) return true;
  }
  return false;
}

function parseYear(value, rowNumber) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (!/^\d{4}$/.test(raw)) {
    throw new Error(`Row ${rowNumber}: year must be a four-digit year, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

function readCases(csvPath) {
  const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text).filter((row) => row.some((field) => String(field || '').trim()));
  if (!rows.length) {
    throw new Error(`No rows found in ${csvPath}`);
  }

  const headers = rows[0].map((header) => String(header || '').trim().toLowerCase());
  const stringIndex = headers.indexOf('string');
  const yearIndex = headers.indexOf('year');
  const rankIndex = headers.indexOf('rank');
  if (stringIndex < 0 || yearIndex < 0 || rankIndex < 0) {
    throw new Error('CSV must have headers: string, year, rank');
  }

  return rows.slice(1).map((row, index) => {
    const rowNumber = index + 2;
    const query = String(row[stringIndex] ?? '').trim();
    const expected = classifyExpected(row[rankIndex]);
    if (!query) throw new Error(`Row ${rowNumber}: string is required`);
    if (!expected.value) throw new Error(`Row ${rowNumber}: rank is required`);
    return {
      rowNumber,
      query,
      year: parseYear(row[yearIndex], rowNumber),
      expected,
    };
  });
}

function printUsage() {
  console.log([
    'Usage:',
    '  npm run venue:accuracy -- path/to/cases.csv',
    '',
    'CSV headers:',
    '  string,year,rank',
    '',
    'Example row:',
    '  "17th European Conference on Computer Systems (EuroSys), 1-16",2022,A',
    '  "Proceedings of the 5th Workshop on Machine Learning and Systems, 74-81",2025,Workshop',
    '',
    'Use uppercase N/A for any N/A outcome, or labels like Workshop, Preprint, Unranked, Ambiguous, N/A for specific N/A reasons.',
    'This is a strict test: any mismatch exits nonzero.',
    `Default path if omitted: ${path.relative(process.cwd(), DEFAULT_CSV)}`,
  ].join('\n'));
}

function buildConfusionKey(expected, actual) {
  return `${expected} -> ${actual}`;
}

async function main() {
  const args = process.argv.slice(2);
  const showAll = args.includes('--show-all');
  const csvArg = args.find((arg) => arg !== '--show-all');
  const csvPath = path.resolve(process.cwd(), csvArg || DEFAULT_CSV);

  if (!csvArg && !fs.existsSync(csvPath)) {
    printUsage();
    process.exit(1);
  }

  const cases = readCases(csvPath);
  const matcher = loadProductionMatcher({ quiet: true });
  const results = [];
  const confusion = new Map();

  for (const item of cases) {
    const report = await matcher.createProductionVenueMatchReport(item.query, item.year, '');
    const decision = report.decision || {};
    const actual = getActualOutcome(decision);
    const correct = matchesExpected(item.expected, actual);
    const key = buildConfusionKey(item.expected.display, actual.display);
    confusion.set(key, (confusion.get(key) || 0) + 1);
    results.push({
      ...item,
      actualRank: actual.rank,
      actualLabel: actual.label,
      actualDisplay: actual.display,
      correct,
      system: decision.system || null,
      status: decision.decisionStatus || null,
      matchedVenue: decision.matchedVenue || null,
      matchedSourceId: decision.matchedSourceId || null,
    });
  }

  const correctCount = results.filter((item) => item.correct).length;
  const total = results.length;
  const accuracy = total ? correctCount / total : 0;

  console.log(`Venue accuracy: ${correctCount}/${total} (${(accuracy * 100).toFixed(1)}%)`);
  console.log(`CSV: ${csvPath}`);

  console.log('\nConfusion:');
  for (const [key, count] of Array.from(confusion.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    console.log(`  ${key}: ${count}`);
  }

  const visibleRows = showAll ? results : results.filter((item) => !item.correct);
  console.log(showAll ? '\nRows:' : '\nMismatches:');
  if (!visibleRows.length) {
    console.log('  none');
  } else {
    for (const item of visibleRows) {
      const marker = item.correct ? 'OK' : 'MISS';
      const venue = item.matchedVenue ? `; matched=${item.matchedVenue}` : '';
      const source = item.matchedSourceId ? `; source=${item.matchedSourceId}` : '';
      const status = item.status ? `; status=${item.status}` : '';
      console.log(`  [${marker}] row ${item.rowNumber}: expected=${item.expected.display}, actual=${item.actualDisplay}, rank=${item.actualRank}${status}${source}${venue}`);
      console.log(`       ${item.query}`);
    }
  }

  if (correctCount !== total) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
