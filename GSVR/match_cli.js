#!/usr/bin/env node
/*
 * match_cli.js - run venue strings through the same production matcher used by
 * content.js. This file only creates a Node/browser shim and formats results.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const vm = require('vm');

const ROOT = __dirname;
const INDEX_JSON = path.join(ROOT, 'data', 'rankings-index.json');

function createDocumentStub() {
  const noopElement = {
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild() { return null; },
    insertAdjacentElement() { return null; },
    remove() {},
    setAttribute() {},
    getAttribute() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    textContent: '',
  };
  return {
    readyState: 'complete',
    documentElement: noopElement,
    body: noopElement,
    createElement() { return { ...noopElement, classList: { ...noopElement.classList }, dataset: {}, style: {} }; },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
}

function createFetchStub() {
  return async function fetchStub(input) {
    const requested = String(input || '');
    const filePath = requested.endsWith('rankings-index.json') ? INDEX_JSON : requested;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async json() {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      },
      async text() {
        return fs.readFileSync(filePath, 'utf8');
      },
      headers: { get() { return null; } },
    };
  };
}

function createChromeStub() {
  return {
    runtime: {
      getURL(relativePath) {
        return path.join(ROOT, relativePath);
      },
      sendMessage: async () => null,
      lastError: null,
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined,
      },
      onChanged: {
        addListener() {},
      },
    },
  };
}

function loadProductionMatcher(options = {}) {
  const quiet = options.quiet === true;
  const context = {
    console: {
      ...console,
      log() {},
      debug() {},
      ...(quiet ? { info() {}, warn() {} } : {}),
    },
    setTimeout,
    clearTimeout,
    performance,
    URLSearchParams,
    Headers,
    Response,
    GSVR_DISABLE_AUTO_INIT: true,
    chrome: createChromeStub(),
    document: createDocumentStub(),
    location: { pathname: '/match-cli', search: '', href: 'https://scholar.google.com/match-cli' },
    MutationObserver: class { observe() {} disconnect() {} },
    HTMLElement: class {},
    HTMLAnchorElement: class {},
    Node: class {},
    fetch: createFetchStub(),
    GSVRVenueData: require('./venue_data.js'),
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  context.GSVRUtils = require('./rank_core.js');
  context.GSVRSettings = require('./settings.js');

  vm.createContext(context);
  const source = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  vm.runInContext(source, context, { filename: path.join(ROOT, 'content.js') });
  if (!context.GSVRProductionMatcher?.createProductionVenueMatchReport) {
    throw new Error('content.js did not expose GSVRProductionMatcher.');
  }
  return context.GSVRProductionMatcher;
}

let cachedMatcher = null;
function getProductionMatcher(options = {}) {
  if (!cachedMatcher || options.fresh === true) {
    cachedMatcher = loadProductionMatcher(options);
  }
  return cachedMatcher;
}

function formatDecision(decision) {
  const rank = decision?.rank || 'N/A';
  const system = decision?.system || 'UNKNOWN';
  const reason = decision?.naReason || decision?.reason || null;
  return reason && rank === 'N/A' ? `${rank} (${reason})` : `${rank} (${system})`;
}

function formatConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'N/A';
}

async function report(query, year) {
  const matcher = getProductionMatcher();
  const result = await matcher.createProductionVenueMatchReport(query, year ?? null, '');
  const dblp = result.dblpVenueMatch || {};
  const decision = result.decision || {};

  console.log(`\nQuery:      ${JSON.stringify(query)}`);
  console.log(`Venue:      ${JSON.stringify(result.venueName)}`);
  console.log(`Normalized: ${JSON.stringify(result.normalizedVenue)}${year != null ? `   (year ${year})` : ''}`);

  console.log('\nDBLP venue catalog');
  if (dblp.status === 'matched' && dblp.entry) {
    console.log(`  => ${dblp.entry.type}  ${dblp.entry.id}  "${dblp.entry.title}"  score=${formatConfidence(dblp.score)}  (${dblp.matchedBy || 'match'})`);
  } else if (dblp.status === 'ambiguous') {
    console.log(`  => ambiguous (${dblp.matchedBy || 'match'}); closest DBLP venues:`);
    for (const candidate of dblp.topCandidates || []) {
      console.log(`       ${formatConfidence(candidate.confidence)}  ${candidate.status || ''}  ${candidate.matchedKey || ''}  "${candidate.matchedVenue || ''}"`);
    }
  } else if (dblp.catalogAvailable === false) {
    console.log('  => DBLP venue catalog unavailable');
  } else {
    console.log('  => no DBLP venue match');
  }

  console.log('\nProduction decision');
  console.log(`  => ${formatDecision(decision)}`);
  if (decision.matchedVenue) console.log(`     matched venue: ${decision.matchedVenue}`);
  if (decision.matchedKey) console.log(`     matched key:   ${decision.matchedKey}`);
  if (decision.matchedSourceId) console.log(`     source id:     ${decision.matchedSourceId}`);
  if (decision.sourceYear) console.log(`     source year:   ${decision.sourceYear}${decision.sourceYearFallback ? ' (fallback)' : ''}`);
  if (typeof decision.venueMatchConfidence === 'number') console.log(`     confidence:    ${formatConfidence(decision.venueMatchConfidence)}`);
  if (decision.decisionStatus) console.log(`     status:        ${decision.decisionStatus}`);
  if (Array.isArray(decision.decisionEvidence) && decision.decisionEvidence.length) {
    console.log(`     evidence:      ${decision.decisionEvidence.join(', ')}`);
  }
  console.log(`\nVERDICT: ${formatDecision(decision)}\n${'-'.repeat(70)}`);
}

function runCli() {
  const args = process.argv.slice(2);
  let argYear = null;
  if (args.length && /^\d{4}$/.test(args[args.length - 1])) {
    argYear = parseInt(args.pop(), 10);
  }
  const query = args.join(' ').trim();

  if (query) {
    report(query, argYear).catch((error) => {
      console.error(error);
      process.exit(1);
    });
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'venue> ' });
  console.log('Enter a venue string (optionally end with a 4-digit year). Ctrl-D to exit.');
  rl.prompt();
  rl.on('line', async (line) => {
    const value = line.trim();
    if (value) {
      const match = value.match(/\s(\d{4})$/);
      try {
        await report(match ? value.slice(0, match.index).trim() : value, match ? parseInt(match[1], 10) : null);
      } catch (error) {
        console.error(error);
      }
    }
    rl.prompt();
  }).on('close', () => process.exit(0));
}

if (require.main === module) {
  runCli();
}

module.exports = {
  loadProductionMatcher,
  getProductionMatcher,
  report,
  formatDecision,
  formatConfidence,
};
