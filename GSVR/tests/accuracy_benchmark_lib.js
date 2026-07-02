const fs = require('fs');
const path = require('path');

const core = require('../rank_core.js');

const VALID_RANKS = ['A*', 'A', 'B', 'C'];
const SJR_QUARTILES = ['Q1', 'Q2', 'Q3', 'Q4'];
const DECISION_STATUS = core.DECISION_STATUS;
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'accuracy');
const BASELINE_REPORT_PATH = path.join(FIXTURE_ROOT, 'baseline.json');
const REPORTS_DIR = path.join(FIXTURE_ROOT, 'reports');
const GOLD_DIR = path.join(FIXTURE_ROOT, 'gold');
const SHADOW_DIR = path.join(FIXTURE_ROOT, 'shadow');
// Hand-curated real-world cases: identities are human-verified, expected
// ranks/quartiles read directly from the authority datasets (never from the
// resolver under test). See generate_real_fixtures.js.
const REAL_DIR = path.join(FIXTURE_ROOT, 'real');
const CORE_DATA_FILES = [
  'core/CORE_2026.json',
  'core/CORE_2023.json',
  'core/CORE_2021.json',
  'core/CORE_2020.json',
  'core/CORE_2018.json',
  'core/CORE_2017.json',
  'core/CORE_2014.json',
  'core/CORE_2013.json',
  'core/CORE_2010.json',
  'core/CORE_2008.json',
];

const FIXTURE_FAMILIES = [
  'profile_match',
  'publication_match',
  'track_classification',
  'conference_resolution',
  'journal_resolution',
  'pipeline_e2e',
  'search_queries',
];

const COMMON_ABBREVIATIONS = {
  "int'l": 'international',
  intl: 'international',
  'int.': 'international',
  int: 'international',
  'conf.': 'conference',
  conf: 'conference',
  'proc.': 'proceedings',
  proc: 'proceedings',
  'symp.': 'symposium',
  symp: 'symposium',
  'j.': 'journal',
  j: 'journal',
  jour: 'journal',
  'trans.': 'transactions',
  trans: 'transactions',
  'annu.': 'annual',
  annu: 'annual',
  'comput.': 'computer',
  comput: 'computer',
  'comp.': 'computer',
  comp: 'computer',
  'commun.': 'communications',
  commun: 'communications',
  'comm.': 'communications',
  comm: 'communications',
  'rev.': 'review',
  rev: 'review',
  'syst.': 'systems',
  syst: 'systems',
  'manag.': 'management',
  manag: 'management',
  'process.': 'processing',
  process: 'processing',
  'sci.': 'science',
  sci: 'science',
  'sens.': 'sensor',
  sens: 'sensor',
  'netw.': 'networks',
  netw: 'networks',
  'pers.': 'personal',
  pers: 'personal',
  'embed.': 'embedded',
  embed: 'embedded',
  'distr.': 'distributed',
  distr: 'distributed',
  'archit.': 'architecture',
  archit: 'architecture',
  'tech.': 'technical',
  tech: 'technical',
  technol: 'technology',
  'engin.': 'engineering',
  engin: 'engineering',
  'res.': 'research',
  res: 'research',
  'adv.': 'advances',
  adv: 'advances',
  'appl.': 'applications',
  appl: 'applications',
  'surv.': 'surveys',
  surv: 'surveys',
  'wirel.': 'wireless',
  wirel: 'wireless',
  'inf.': 'information',
  inf: 'information',
  'lectures notes': 'lecture notes',
  'lect notes': 'lecture notes',
  lncs: 'lecture notes in computer science',
};

const CONFERENCE_SEARCH_STOP_WORDS = new Set([
  'proceedings',
  'conference',
  'conf',
  'international',
  'symposium',
  'workshop',
  'journal',
  'annual',
  'meeting',
  'on',
  'of',
  'for',
  'the',
  'and',
  'in',
  'computer',
  'computing',
  'systems',
  'networks',
  'communications',
]);

const coreDataCache = new Map();
const coreAliasIndexCache = new Map();
let sjrDatasetCache = null;
let bundledRankingsIndex = null;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadBundledRankingsIndex() {
  if (!bundledRankingsIndex) {
    bundledRankingsIndex = readJson(path.join(__dirname, '..', 'data', 'rankings-index.json'));
  }
  return bundledRankingsIndex;
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function readJsonLinesFile(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Failed to parse JSONL line ${index + 1} in ${filePath}: ${error.message}`);
      }
    });
}

function writeJsonLinesFile(filePath, entries) {
  ensureDir(path.dirname(filePath));
  const body = (Array.isArray(entries) ? entries : [])
    .map((entry) => JSON.stringify(entry))
    .join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function normalizeRankForConfusion(value, validValues) {
  const candidate = String(value || '').trim().toUpperCase();
  return validValues.includes(candidate) ? candidate : 'N/A';
}

function parseYearFromText(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value || '').match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0], 10) : null;
}

function normalizeIssnValue(value) {
  const normalized = String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return normalized || null;
}

function normalizeIssnList(values) {
  const list = Array.isArray(values) ? values : String(values || '').split(/[;,]/);
  const out = [];
  const seen = new Set();
  for (const value of list) {
    const normalized = normalizeIssnValue(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function generateAcronymFromTitle(title) {
  if (!title) return '';
  const words = String(title).split(/[\s\-‑\/.,:;&]+/);
  let acronym = '';
  for (const word of words) {
    if (word.length > 0 && word[0] === word[0].toUpperCase() && /^[A-Za-z]/.test(word[0])) {
      acronym += word[0];
    }
    if (acronym.length >= 8) break;
  }
  return acronym.toUpperCase();
}

function normalizeCoreRawRankLabel(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if (VALID_RANKS.includes(upper)) return upper;
  if (/\b(unranked|merged|journal|inactive|discontinued|ceased|not\s+ranked|removed|withdrawn|retired|suspended)\b/i.test(text)) {
    return text;
  }
  return null;
}

function parseBundledCoreFile(coreDataFile) {
  const normalizedPath = String(coreDataFile || '').replace(/\\/g, '/');
  const fileName = normalizedPath.startsWith('core/') ? normalizedPath.slice(5) : normalizedPath;
  const year = String(fileName || '').match(/(\d{4})/)?.[1];
  const jsonData = loadBundledRankingsIndex().core[String(year)] || [];
  return jsonData
    .map(([title, acronym, rawRank]) => {
      const cleanedRank = normalizeCoreRawRankLabel(rawRank);
      const upper = String(cleanedRank || '').toUpperCase();
      const entry = {
        title: String(title || '').trim(),
        acronym: String(acronym || '').trim(),
        rank: VALID_RANKS.includes(upper) ? upper : 'N/A',
        rawRank: cleanedRank || null,
      };

      if (!entry.acronym && entry.title) {
        const generated = generateAcronymFromTitle(entry.title);
        if (generated.length >= 2) entry.acronym = generated;
      }

      return (entry.title || entry.acronym) ? entry : null;
    })
    .filter(Boolean);
}

function loadCoreReference(coreDataFile) {
  const normalizedPath = String(coreDataFile || '').replace(/\\/g, '/');
  const cacheKey = normalizedPath.startsWith('core/') ? normalizedPath : `core/${normalizedPath}`;
  if (!coreDataCache.has(cacheKey)) {
    const coreData = parseBundledCoreFile(cacheKey);
    coreDataCache.set(cacheKey, coreData);
    coreAliasIndexCache.set(cacheKey, core.createCoreAliasIndex(coreData));
  }
  return {
    coreData: coreDataCache.get(cacheKey),
    aliasIndex: coreAliasIndexCache.get(cacheKey),
  };
}

function getCoreDataFileForYear(pubYear) {
  if (pubYear === null || pubYear === undefined) return 'core/CORE_2026.json';
  if (pubYear >= 2026) return 'core/CORE_2026.json';
  if (pubYear >= 2023) return 'core/CORE_2023.json';
  if (pubYear >= 2021) return 'core/CORE_2021.json';
  if (pubYear >= 2020) return 'core/CORE_2020.json';
  if (pubYear >= 2018) return 'core/CORE_2018.json';
  if (pubYear >= 2017) return 'core/CORE_2017.json';
  if (pubYear >= 2014) return 'core/CORE_2014.json';
  if (pubYear >= 2013) return 'core/CORE_2013.json';
  if (pubYear >= 2010) return 'core/CORE_2010.json';
  return 'core/CORE_2008.json';
}

function getCoreDatasetYear(coreDataFile) {
  const match = String(coreDataFile || '').match(/CORE_(\d{4})/i);
  return match ? parseInt(match[1], 10) : null;
}

function cleanTextForComparison(text, isScholarVenue) {
  if (!text) return '';
  let cleanedText = String(text).toLowerCase();
  cleanedText = cleanedText.replace(/&/g, ' and ');
  cleanedText = cleanedText.replace(/[\.,\/#!$%\^;\*:{}=_`~?"“”()\[\]]/g, ' ');
  cleanedText = cleanedText.replace(/\s-\s/g, ' ');

  if (isScholarVenue) {
    cleanedText = cleanedText.replace(/^(\d{4}\s+|\d{1,2}(st|nd|rd|th)\s+)/, '');
    cleanedText = cleanedText.replace(/,\s*\d{4}$/, '');
    cleanedText = cleanedText.replace(/\(\d{4}\)$/, '');
    cleanedText = cleanedText.replace(/\b(part|volume|vol|issue|no|number)\s*\d+\b/g, ' ');
    cleanedText = cleanedText.replace(/\b\d{1,3}\b\s*$/g, '');
  }

  cleanedText = cleanedText.replace(/\b\d{1,3}\b\s*$/g, '');
  cleanedText = cleanedText.replace(/\s+/g, ' ').trim();

  for (const [abbr, expansion] of Object.entries(COMMON_ABBREVIATIONS)) {
    const regex = new RegExp(`\\b${escapeRegExp(abbr)}\\b`, 'gi');
    cleanedText = cleanedText.replace(regex, expansion);
  }

  return cleanedText.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeJournalName(name) {
  if (!name) return '';
  let cleaned = cleanTextForComparison(name, true);
  if (!cleaned) return '';
  cleaned = cleaned.replace(/\b\d{1,6}\b/g, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  const stopWords = new Set([
    'a', 'an', 'the', 'of', 'and', 'for', 'in', 'on', 'to', 'at',
    'journal', 'international', 'transactions', 'letters',
  ]);

  const stem = (token) => {
    if (token.length <= 4) return token;
    if (token.endsWith('ies') && token.length > 5) return `${token.slice(0, -3)}y`;
    if (token.endsWith('sses')) return token;
    if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
    return token;
  };

  return cleaned
    .split(' ')
    .map((token) => token.trim())
    .filter(Boolean)
    .map(stem)
    .filter((token) => token.length > 0 && !stopWords.has(token))
    .join(' ')
    .trim();
}

function generateJournalNormalizationVariants(name) {
  const base = normalizeJournalName(name);
  if (!base) return [];
  const variants = new Set([base]);
  if (/\bcomputer\b/.test(base)) {
    variants.add(base.replace(/\bcomputer\b/g, 'computing'));
  }
  if (/\bcomputing\b/.test(base)) {
    variants.add(base.replace(/\bcomputing\b/g, 'computer'));
  }
  if (/\bacm\s+computer\b/.test(base)) {
    variants.add(base.replace(/\bacm\s+computer\b/g, 'acm computing'));
  }
  if (/\bcomputer\s+survey\b/.test(base)) {
    variants.add(base.replace(/\bcomputer\b/g, 'computing'));
  }
  if (/\bcomputing\s+survey\b/.test(base)) {
    variants.add(base.replace(/\bcomputing\b/g, 'computer'));
  }
  return Array.from(variants);
}

function createSjrTokenIndex(entries) {
  const tokenToIndexes = new Map();
  const tokenFrequency = new Map();
  entries.forEach((entry, index) => {
    const sourceTokens = Array.isArray(entry.keywordTokens) && entry.keywordTokens.length
      ? entry.keywordTokens
      : core.tokenizeNormalizedText(entry.normalizedTitle, 3);
    const tokens = Array.from(new Set(sourceTokens.filter((token) => token.length >= 3)));
    for (const token of tokens) {
      if (!tokenToIndexes.has(token)) tokenToIndexes.set(token, new Set());
      tokenToIndexes.get(token).add(index);
      tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
    }
  });
  return { tokenToIndexes, tokenFrequency };
}

function loadSjrDataset() {
  if (sjrDatasetCache) return sjrDatasetCache;
  const payload = loadBundledRankingsIndex();
  const entries = [];
  const byNormalized = new Map();
  const byIssn = new Map();
  const startYear = payload.startYear || 1999;

  for (const rawEntry of payload.sjr || []) {
    const [normalizedRaw, titleRaw, quartileStringRaw, keywordTokensRaw] = rawEntry;
    const normalizedTitle = String(normalizedRaw || '').trim();
    const resolvedTitle = String(titleRaw || '').trim();
    if (!normalizedTitle || !resolvedTitle) continue;
    const quartilesByYear = {};
    const quartileString = String(quartileStringRaw || '');
    for (let index = 0; index < quartileString.length; index++) {
      const code = quartileString[index];
      if (!/[1-4]/.test(code)) continue;
      quartilesByYear[String(startYear + index)] = `Q${code}`;
    }
    const entry = {
      normalizedTitle,
      resolvedTitle,
      quartilesByYear,
      keywordTokens: Array.isArray(keywordTokensRaw) ? keywordTokensRaw.map((value) => String(value || '').trim()).filter(Boolean) : [],
      issns: [],
      sourceId: null,
      coverage: null,
    };
    entries.push(entry);
    byNormalized.set(normalizedTitle, entry);
    for (const issn of entry.issns) {
      if (!byIssn.has(issn)) byIssn.set(issn, []);
      byIssn.get(issn).push(entry);
    }
  }

  sjrDatasetCache = {
    version: payload.version || 3,
    startYear,
    endYear: payload.endYear || 2024,
    entries,
    byNormalized,
    byIssn,
    tokenIndex: createSjrTokenIndex(entries),
  };
  return sjrDatasetCache;
}

function selectSjrCandidateIndexes(queryTokens, dataset) {
  if (!Array.isArray(queryTokens) || !queryTokens.length || !dataset?.tokenIndex) return null;
  const ranked = queryTokens
    .map((token) => ({
      token,
      count: dataset.tokenIndex.tokenFrequency.get(token) || Number.POSITIVE_INFINITY,
    }))
    .filter((entry) => Number.isFinite(entry.count))
    .sort((left, right) => left.count - right.count || left.token.localeCompare(right.token));

  if (!ranked.length) return null;

  let candidateSet = null;
  for (const entry of ranked.slice(0, 3)) {
    const indexes = dataset.tokenIndex.tokenToIndexes.get(entry.token);
    if (!indexes?.size) continue;
    candidateSet = candidateSet
      ? new Set([...candidateSet].filter((index) => indexes.has(index)))
      : new Set(indexes);
    if (candidateSet.size > 0 && candidateSet.size <= 48) break;
  }

  if (candidateSet?.size) return candidateSet;
  return dataset.tokenIndex.tokenToIndexes.get(ranked[0].token) || null;
}

function findBestSjrMatch({ normalizedQuery, queryIssns, dataset }) {
  const exactIssnMatches = [];
  for (const issn of normalizeIssnList(queryIssns)) {
    const matches = dataset.byIssn.get(issn) || [];
    for (const match of matches) {
      if (!exactIssnMatches.includes(match)) exactIssnMatches.push(match);
    }
  }

  if (exactIssnMatches.length === 1) {
    return { status: DECISION_STATUS.MATCHED, entry: exactIssnMatches[0], score: 1, matchedBy: 'issn' };
  }
  if (exactIssnMatches.length > 1) {
    const exactTitleMatch = exactIssnMatches.find((entry) => entry.normalizedTitle === normalizedQuery);
    if (exactTitleMatch) {
      return { status: DECISION_STATUS.MATCHED, entry: exactTitleMatch, score: 1, matchedBy: 'issn' };
    }
    const sourceIds = new Set(exactIssnMatches.map((entry) => entry.sourceId).filter(Boolean));
    if (sourceIds.size === 1) {
      const latestSourceEntry = exactIssnMatches
        .slice()
        .sort((left, right) => {
          const rightYear = Math.max(0, ...Object.keys(right.quartilesByYear || {}).map((year) => Number(year)).filter(Number.isFinite));
          const leftYear = Math.max(0, ...Object.keys(left.quartilesByYear || {}).map((year) => Number(year)).filter(Number.isFinite));
          return rightYear - leftYear;
        })[0];
      if (latestSourceEntry) {
        return { status: DECISION_STATUS.MATCHED, entry: latestSourceEntry, score: 1, matchedBy: 'issn' };
      }
    }
    let bestIssnMatch = null;
    let secondIssnMatch = null;
    for (const entry of exactIssnMatches) {
      const score = core.hybridSimilarity(normalizedQuery, entry.normalizedTitle);
      const candidate = { entry, score };
      if (!bestIssnMatch || score > bestIssnMatch.score) {
        secondIssnMatch = bestIssnMatch;
        bestIssnMatch = candidate;
      } else if (!secondIssnMatch || score > secondIssnMatch.score) {
        secondIssnMatch = candidate;
      }
    }
    const issnGap = secondIssnMatch ? bestIssnMatch.score - secondIssnMatch.score : Number.POSITIVE_INFINITY;
    if (bestIssnMatch && (bestIssnMatch.score >= 0.97 || issnGap >= core.RANKING_CONFIG.sjrAmbiguityGap)) {
      return {
        status: DECISION_STATUS.MATCHED,
        entry: bestIssnMatch.entry,
        score: bestIssnMatch.score,
        matchedBy: 'issn',
      };
    }
    return { status: DECISION_STATUS.AMBIGUOUS, score: 1, matchedBy: 'issn' };
  }

  const directMatch = dataset.byNormalized.get(normalizedQuery);
  if (directMatch) {
    return { status: DECISION_STATUS.MATCHED, entry: directMatch, score: 1, matchedBy: 'title_exact' };
  }

  const queryTokens = normalizedQuery
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
  const candidateIndexes = selectSjrCandidateIndexes(queryTokens, dataset)
    || new Set(dataset.entries.map((_, index) => index));

  let best = null;
  let second = null;
  for (const index of candidateIndexes) {
    const entry = dataset.entries[index];
    if (!entry) continue;
    const score = core.hybridSimilarity(normalizedQuery, entry.normalizedTitle);
    if (score < core.RANKING_CONFIG.sjrFuzzyThreshold) continue;
    const candidate = { entry, score };
    if (!best || score > best.score) {
      second = best;
      best = candidate;
    } else if (!second || score > second.score) {
      second = candidate;
    }
  }

  if (!best) {
    return { status: DECISION_STATUS.MISSING };
  }

  const gap = second ? best.score - second.score : Number.POSITIVE_INFINITY;
  if (second && best.score < 0.97 && gap < core.RANKING_CONFIG.sjrAmbiguityGap) {
    return { status: DECISION_STATUS.AMBIGUOUS, score: best.score, gap, matchedBy: 'title_fuzzy' };
  }

  return {
    status: DECISION_STATUS.MATCHED,
    entry: best.entry,
    score: best.score,
    matchedBy: 'title_fuzzy',
  };
}

function selectQuartileForYear(data, publicationYear) {
  const entries = Object.entries(data.quartilesByYear || {})
    .map(([year, quartile]) => ({ year: Number(year), quartile }))
    .filter((entry) => Number.isFinite(entry.year))
    .sort((left, right) => right.year - left.year);

  if (!entries.length) {
    return { quartile: null, year: null, sourceYearFallback: false };
  }

  if (publicationYear) {
    const datasetStartYear = loadSjrDataset().startYear;
    if (Number.isFinite(datasetStartYear) && publicationYear < datasetStartYear) {
      return {
        quartile: null,
        year: null,
        sourceYearFallback: false,
        historicalCoverageUnavailable: true,
      };
    }
    const targetYear = publicationYear;
    const exact = entries.find((entry) => entry.year === targetYear);
    if (exact) {
      return { quartile: exact.quartile, year: exact.year, sourceYearFallback: false };
    }
    const previous = entries.find((entry) => entry.year < targetYear);
    if (previous) {
      return { quartile: previous.quartile, year: previous.year, sourceYearFallback: true };
    }
  }

  const latest = entries[0];
  return { quartile: latest.quartile, year: latest.year, sourceYearFallback: true };
}

function resolveJournalQuerySync(journalName, publicationYear, journalMeta) {
  const variants = generateJournalNormalizationVariants(journalName);
  if (!variants.length) {
    return {
      status: DECISION_STATUS.MISSING,
      quartile: 'N/A',
      sourceYear: null,
      matchedTitle: null,
      matchedSourceId: null,
      sourceYearFallback: false,
      matchType: null,
      confidence: null,
    };
  }

  const dataset = loadSjrDataset();
  const queryIssns = normalizeIssnList(journalMeta?.issns || []);
  let sawAmbiguous = false;

  for (const normalizedQuery of variants) {
    const match = findBestSjrMatch({ normalizedQuery, queryIssns, dataset });
    if (!match || match.status === DECISION_STATUS.MISSING) continue;
    if (match.status === DECISION_STATUS.AMBIGUOUS) {
      sawAmbiguous = true;
      continue;
    }

    const selected = selectQuartileForYear(match.entry, publicationYear ?? null);
    if (selected.historicalCoverageUnavailable) {
      return {
        status: DECISION_STATUS.UNRANKED,
        reason: 'sjr_historical_coverage_unavailable',
        quartile: 'N/A',
        sourceYear: null,
        matchedTitle: match.entry.resolvedTitle,
        matchedSourceId: match.entry.sourceId || null,
        sourceYearFallback: false,
        matchType: match.matchedBy || null,
        confidence: typeof match.score === 'number' ? match.score : null,
      };
    }
    return {
      status: DECISION_STATUS.MATCHED,
      quartile: selected.quartile || 'N/A',
      sourceYear: selected.year,
      matchedTitle: match.entry.resolvedTitle,
      matchedSourceId: match.entry.sourceId || null,
      sourceYearFallback: selected.sourceYearFallback === true,
      matchType: match.matchedBy || null,
      confidence: typeof match.score === 'number' ? match.score : null,
    };
  }

  return {
    status: sawAmbiguous ? DECISION_STATUS.AMBIGUOUS : DECISION_STATUS.MISSING,
    quartile: 'N/A',
    sourceYear: null,
    matchedTitle: null,
    matchedSourceId: null,
    sourceYearFallback: false,
    matchType: null,
    confidence: null,
  };
}

function getPossibleAcronymsFromVenue(venueQuery) {
  const query = String(venueQuery || '').trim();
  if (!query) return [];
  const results = new Set();

  const simpleToken = query.match(/^[A-Za-z][A-Za-z0-9\-]{1,11}$/);
  if (simpleToken) {
    results.add(simpleToken[0]);
  }

  const words = query
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[()]/g, ' ')
    .split(/[\s\-‑\/.,:;&]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const significantWords = words.filter((token) => !CONFERENCE_SEARCH_STOP_WORDS.has(token.toLowerCase()));
  if (significantWords.length >= 2) {
    const acronym = significantWords
      .map((token) => token[0])
      .join('')
      .slice(0, 10)
      .toUpperCase();
    if (acronym.length >= 2) results.add(acronym);
  }

  const camelCaseTokens = query.match(/[A-Z][a-z]+[A-Z][A-Za-z0-9]*/g) || [];
  for (const token of camelCaseTokens) {
    results.add(token);
  }

  return Array.from(results);
}

function buildConferenceSearchCandidates(venueQuery) {
  const query = String(venueQuery || '').trim();
  if (!query) return [];
  const candidates = [];
  const seen = new Set();

  const pushCandidate = (value) => {
    const trimmed = String(value || '').replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(trimmed);
  };

  const addExpandedVariants = (value) => {
    pushCandidate(value);
    pushCandidate(core.canonicalizeCsrankingsVenueName(value));
    for (const variant of core.expandVenueCandidates(value)) {
      pushCandidate(variant);
    }
    for (const acronym of getPossibleAcronymsFromVenue(value)) {
      pushCandidate(acronym);
    }
  };

  addExpandedVariants(query);
  const queryWithoutYear = query.replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (queryWithoutYear && queryWithoutYear !== query) {
    addExpandedVariants(queryWithoutYear);
  }
  return candidates;
}

function getConferenceSearchStatusPriority(status) {
  switch (status) {
    case DECISION_STATUS.MATCHED:
      return 4;
    case DECISION_STATUS.UNRANKED:
      return 3;
    case DECISION_STATUS.AMBIGUOUS:
      return 2;
    default:
      return 1;
  }
}

function getConferenceSearchMatchPriority(matchType) {
  switch (matchType) {
    case 'acronym_exact':
    case 'alias_exact':
      return 4;
    case 'acronym_disambiguated':
    case 'alias_disambiguated':
      return 3;
    case 'fuzzy':
      return 2;
    case 'top_venue_fallback':
      return 1;
    default:
      return 0;
  }
}

function pickBetterConferenceSearchOutcome(currentBest, nextCandidate) {
  if (!currentBest) return nextCandidate;
  const statusDelta = getConferenceSearchStatusPriority(nextCandidate.status)
    - getConferenceSearchStatusPriority(currentBest.status);
  if (statusDelta !== 0) {
    return statusDelta > 0 ? nextCandidate : currentBest;
  }

  const matchDelta = getConferenceSearchMatchPriority(nextCandidate.matchType)
    - getConferenceSearchMatchPriority(currentBest.matchType);
  if (matchDelta !== 0) {
    return matchDelta > 0 ? nextCandidate : currentBest;
  }

  const nextConfidence = typeof nextCandidate.confidence === 'number' ? nextCandidate.confidence : -1;
  const currentConfidence = typeof currentBest.confidence === 'number' ? currentBest.confidence : -1;
  if (nextConfidence !== currentConfidence) {
    return nextConfidence > currentConfidence ? nextCandidate : currentBest;
  }

  const nextMatchedVenue = String(nextCandidate.matchedVenue || '');
  const currentMatchedVenue = String(currentBest.matchedVenue || '');
  if (nextMatchedVenue.length !== currentMatchedVenue.length) {
    return nextMatchedVenue.length > currentMatchedVenue.length ? nextCandidate : currentBest;
  }

  return currentBest;
}

function searchConferenceInCoreFileSync(venueQuery, coreDataFile, customCoreData) {
  const datasetYear = getCoreDatasetYear(coreDataFile);
  const originalQuery = String(venueQuery || '').trim();
  const coreReference = customCoreData
    ? { coreData: customCoreData, aliasIndex: core.createCoreAliasIndex(customCoreData) }
    : loadCoreReference(coreDataFile);

  let best = null;
  for (const candidate of buildConferenceSearchCandidates(originalQuery)) {
    const result = core.resolveCoreVenue({
      venueKey: candidate,
      fullVenueTitle: originalQuery,
      coreData: coreReference.coreData,
      aliasIndex: coreReference.aliasIndex,
    });
    const outcome = {
      query: originalQuery,
      searchedCandidate: candidate,
      coreDataFile,
      sourceYear: datasetYear,
      rank: VALID_RANKS.includes(result.rank) ? result.rank : 'N/A',
      status: result.status || (VALID_RANKS.includes(result.rank) ? DECISION_STATUS.MATCHED : DECISION_STATUS.MISSING),
      matchedVenue: result.matchedVenue || null,
      confidence: typeof result.confidence === 'number' ? result.confidence : null,
      matchedKey: result.matchedKey || null,
      matchType: result.matchType || null,
      rawRankLabel: result.rawRankLabel || null,
      decisionEvidence: result.reason ? [result.reason] : null,
    };
    best = pickBetterConferenceSearchOutcome(best, outcome);
    if (best?.status === DECISION_STATUS.MATCHED && best.matchType && best.matchType !== 'fuzzy') break;
  }

  return best || {
    query: originalQuery,
    coreDataFile,
    sourceYear: datasetYear,
    rank: 'N/A',
    status: DECISION_STATUS.MISSING,
    matchedVenue: null,
    confidence: null,
    matchedKey: null,
    matchType: null,
    rawRankLabel: null,
    decisionEvidence: ['no_core_match'],
  };
}

function resolveConferenceSearchQuerySync(venueQuery, yearVal, customCoreData) {
  const inferredYear = Number.isFinite(yearVal) ? yearVal : parseYearFromText(venueQuery);
  const primaryFile = customCoreData ? 'custom/CORE_fixture.json' : getCoreDataFileForYear(inferredYear ?? null);
  const primary = searchConferenceInCoreFileSync(venueQuery, primaryFile, customCoreData);
  let latestRankedSnapshot = null;

  if (!customCoreData) {
    const primaryYear = getCoreDatasetYear(primaryFile) ?? Number.POSITIVE_INFINITY;
    const fallbackFiles = CORE_DATA_FILES.filter((file) => file !== primaryFile && (getCoreDatasetYear(file) ?? 0) < primaryYear);
    for (const fallbackFile of fallbackFiles) {
      const outcome = searchConferenceInCoreFileSync(venueQuery, fallbackFile);
      if (outcome.status === DECISION_STATUS.MATCHED && VALID_RANKS.includes(outcome.rank)) {
        latestRankedSnapshot = outcome;
        break;
      }
    }
  }

  return { primary, latestRankedSnapshot, primaryFile };
}

function formatCoreStatusLabel(rawRankLabel) {
  const value = String(rawRankLabel || '').trim();
  if (!value) return null;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function resolveProfileMatchFixture(input) {
  const candidates = Array.isArray(input?.candidates) ? input.candidates : [];
  if (!candidates.length) {
    return { status: DECISION_STATUS.MISSING, matchedPid: null, confidence: null, reason: 'no_candidates' };
  }

  const scored = candidates
    .map((candidate) => {
      const evaluation = core.scoreDblpProfileCandidate({
        scholarName: input.scholarName,
        scholarSamplePubs: input.scholarSamplePubs,
        candidateName: candidate.candidateName,
        dblpPublications: candidate.dblpPublications,
      });
      return { candidate, evaluation };
    })
    .sort((left, right) => {
      if ((left.evaluation.score || 0) !== (right.evaluation.score || 0)) {
        return (right.evaluation.score || 0) - (left.evaluation.score || 0);
      }
      return String(left.candidate.pid || '').localeCompare(String(right.candidate.pid || ''));
    });

  const best = scored[0];
  const second = scored[1] || null;
  if (!best || best.evaluation.status !== DECISION_STATUS.MATCHED) {
    return {
      status: DECISION_STATUS.MISSING,
      matchedPid: null,
      confidence: best?.evaluation?.confidence ?? null,
      reason: best?.evaluation?.reason || 'profile_overlap_too_low',
    };
  }

  const bestScore = best.evaluation.score || 0;
  const secondScore = second?.evaluation?.status === DECISION_STATUS.MATCHED
    ? (second.evaluation.score || 0)
    : null;
  if (secondScore !== null) {
    const gap = bestScore - secondScore;
    if (gap < core.RANKING_CONFIG.profileAmbiguityGap && bestScore < core.RANKING_CONFIG.profileStrongScoreThreshold) {
      return {
        status: DECISION_STATUS.AMBIGUOUS,
        matchedPid: null,
        confidence: best.evaluation.confidence ?? null,
        reason: 'profile_candidate_ambiguous',
        scoreGap: gap,
      };
    }
  }

  return {
    status: DECISION_STATUS.MATCHED,
    matchedPid: best.candidate.pid || null,
    confidence: best.evaluation.confidence ?? null,
    reason: best.evaluation.reason || 'profile_overlap',
    score: bestScore,
  };
}

function resolvePublicationMatchFixture(input) {
  const result = core.selectBestDblpMatchDetailed({
    scholarTitle: input?.scholarTitle || '',
    scholarYear: Number.isFinite(input?.scholarYear) ? input.scholarYear : null,
    dblpPublications: input?.dblpPublications || [],
  });

  return {
    status: result.status,
    matchedKey: result.match?.dblpKey || null,
    confidence: typeof result.confidence === 'number' ? result.confidence : null,
    reason: result.reason || null,
    exactTitleMatch: result.exactTitleMatch === true,
    scoreGap: typeof result.scoreGap === 'number' ? result.scoreGap : null,
  };
}

function resolveTrackClassificationFixture(input) {
  const trackInfo = core.classifyVenueTrack(input || {});
  let label = 'main';
  if (trackInfo.isWorkshop) label = 'workshop';
  else if (trackInfo.isDemoPoster) label = 'demoPoster';
  else if (trackInfo.isExtendedAbstract) label = 'extendedAbstract';
  else if (trackInfo.isShortPaper) label = 'shortPaper';

  return {
    label,
    reason: trackInfo.reason || null,
    resolvedVenue: trackInfo.resolvedVenue || null,
    parentVenue: trackInfo.parentVenue || null,
    signals: Array.isArray(trackInfo.signals) ? trackInfo.signals : [],
  };
}

function resolveConferenceResolutionFixture(input) {
  const venueQuery = input?.venueQuery ?? input?.query ?? '';
  const fullVenueTitle = input?.fullVenueTitle ?? venueQuery;
  const coreDataFile = input?.coreDataFile || getCoreDataFileForYear(input?.coreYear ?? input?.publicationYear ?? null);
  const customCoreData = Array.isArray(input?.customCoreData) ? input.customCoreData : null;
  const result = searchConferenceInCoreFileSync(venueQuery, coreDataFile, customCoreData);
  return {
    status: result.status,
    rank: VALID_RANKS.includes(result.rank) ? result.rank : 'N/A',
    matchedVenue: result.matchedVenue || null,
    rawRankLabel: result.rawRankLabel || null,
    matchType: result.matchType || null,
    sourceYear: result.sourceYear ?? getCoreDatasetYear(coreDataFile),
    confidence: typeof result.confidence === 'number' ? result.confidence : null,
    fullVenueTitle: fullVenueTitle || null,
  };
}

function resolveJournalResolutionFixture(input) {
  const publicationYear = Number.isFinite(input?.publicationYear) ? input.publicationYear : parseYearFromText(input?.publicationYear);
  const result = resolveJournalQuerySync(input?.journalName || input?.query || '', publicationYear, input?.journalMeta || {});
  return {
    status: result.status,
    quartile: SJR_QUARTILES.includes(result.quartile) ? result.quartile : 'N/A',
    matchedTitle: result.matchedTitle || null,
    sourceYear: result.sourceYear ?? null,
    sourceYearFallback: result.sourceYearFallback === true,
    matchedSourceId: result.matchedSourceId || null,
    matchType: result.matchType || null,
    reason: result.reason || null,
  };
}

function buildPipelineConferenceResult(input, matchedPublication, publicationYear, trackInfo) {
  const override = core.resolveCsrankingsVenueOverride({
    dblpKey: matchedPublication.dblpKey,
    venue: matchedPublication.venue || matchedPublication.venue_full || matchedPublication.acronym,
    year: publicationYear,
    volume: matchedPublication.volume || input?.volume,
    number: matchedPublication.number || input?.number,
    dblpType: matchedPublication.dblpType,
  });

  const venueQuery = override?.canonicalVenue
    || input?.conferenceQuery
    || trackInfo.resolvedVenue
    || matchedPublication.acronym
    || matchedPublication.venue
    || matchedPublication.venue_full
    || input?.venueQuery
    || '';
  const conferenceResult = resolveConferenceResolutionFixture({
    venueQuery,
    fullVenueTitle: input?.fullVenueTitle || matchedPublication.venue_full || matchedPublication.venue || venueQuery,
    coreYear: override?.year || publicationYear || null,
    customCoreData: input?.customCoreData,
  });

  return {
    system: 'CORE',
    matchedVenue: conferenceResult.matchedVenue,
    matchedKey: conferenceResult.matchedVenue,
    rank: conferenceResult.rank,
    decisionStatus: conferenceResult.status,
    sourceYear: conferenceResult.sourceYear,
    sourceYearFallback: false,
    reason: conferenceResult.rawRankLabel ? formatCoreStatusLabel(conferenceResult.rawRankLabel) : null,
    confidence: conferenceResult.confidence,
  };
}

function buildPipelineJournalResult(input, matchedPublication, publicationYear) {
  const result = resolveJournalResolutionFixture({
    journalName: input?.journalName
      || matchedPublication.venue
      || matchedPublication.venue_full
      || matchedPublication.shortTitle
      || input?.venueQuery
      || '',
    publicationYear,
    journalMeta: input?.journalMeta || { issns: matchedPublication.issns || [] },
  });

  return {
    system: 'SJR',
    matchedVenue: result.matchedTitle,
    matchedKey: result.matchedTitle,
    rank: result.quartile,
    decisionStatus: result.status,
    sourceYear: result.sourceYear,
    sourceYearFallback: result.sourceYearFallback === true,
    reason: result.reason || null,
    confidence: null,
    matchedSourceId: result.matchedSourceId || null,
  };
}

function resolvePipelineFixture(input) {
  const dblpPublications = Array.isArray(input?.dblpPublications) ? input.dblpPublications : [];
  const scholarYear = Number.isFinite(input?.scholarYear) ? input.scholarYear : parseYearFromText(input?.scholarYear);
  const publicationMatch = core.selectBestDblpMatchDetailed({
    scholarTitle: input?.scholarTitle || '',
    scholarYear,
    dblpPublications,
  });

  if (publicationMatch.status !== DECISION_STATUS.MATCHED || !publicationMatch.match) {
    return {
      system: 'DBLP',
      rank: 'DBLP Entry Missing',
      reason: null,
      decisionStatus: publicationMatch.status === DECISION_STATUS.AMBIGUOUS
        ? DECISION_STATUS.AMBIGUOUS
        : DECISION_STATUS.MISSING,
      matchedVenue: null,
      matchedKey: null,
      matchedSourceId: null,
      sourceYear: null,
      sourceYearFallback: false,
      confidence: publicationMatch.confidence ?? null,
    };
  }

  const matchedPublication = publicationMatch.match;
  const publicationYear = scholarYear || parseYearFromText(matchedPublication.year);
  const pageCount = Number.isFinite(input?.pageCount)
    ? input.pageCount
    : core.getPageCountFromPagesString(matchedPublication.pages || input?.pages || '');
  const trackInfo = core.classifyVenueTrack({
    title: matchedPublication.title || input?.scholarTitle || '',
    venue: matchedPublication.venue || input?.venueQuery || '',
    venue_full: matchedPublication.venue_full || input?.fullVenueTitle || null,
    acronym: matchedPublication.acronym || input?.acronym || null,
    dblpKey: matchedPublication.dblpKey || null,
    scholarVenue: input?.scholarVenue || null,
    pageCount,
    dblpType: matchedPublication.dblpType || input?.dblpType || null,
    crossref: matchedPublication.crossref || input?.crossref || null,
  });

  const forceVenueType = input?.venueType;
  const isJournalish = forceVenueType === 'journal'
    || String(matchedPublication.dblpKey || '').toLowerCase().startsWith('journals/')
    || String(matchedPublication.dblpType || '').toLowerCase() === 'article';

  const baseResult = isJournalish
    ? buildPipelineJournalResult(input, matchedPublication, publicationYear)
    : buildPipelineConferenceResult(input, matchedPublication, publicationYear, trackInfo);

  let reason = baseResult.reason;
  let decisionStatus = baseResult.decisionStatus;
  let rank = baseResult.rank;

  if (trackInfo.isExtendedAbstract) {
    rank = 'N/A';
    reason = 'Extended Abstract';
    decisionStatus = DECISION_STATUS.UNRANKED;
  } else if (trackInfo.isDemoPoster) {
    rank = 'N/A';
    reason = 'Demo/Poster';
    decisionStatus = DECISION_STATUS.UNRANKED;
  } else if (trackInfo.isWorkshop) {
    rank = 'N/A';
    reason = 'Workshop';
    decisionStatus = DECISION_STATUS.UNRANKED;
  } else if (typeof pageCount === 'number' && pageCount < 6) {
    rank = 'N/A';
    reason = 'Short-paper';
    decisionStatus = DECISION_STATUS.UNRANKED;
  } else if (decisionStatus === DECISION_STATUS.AMBIGUOUS) {
    rank = 'N/A';
    reason = 'Ambiguous';
  } else if ((baseResult.system === 'CORE' && !VALID_RANKS.includes(rank))
    || (baseResult.system === 'SJR' && !SJR_QUARTILES.includes(rank))) {
    rank = 'N/A';
    if (decisionStatus === DECISION_STATUS.UNRANKED && !reason) {
      reason = 'Unranked';
    }
  } else {
    decisionStatus = DECISION_STATUS.MATCHED;
    reason = null;
  }

  return {
    system: baseResult.system,
    rank,
    reason,
    decisionStatus,
    matchedVenue: baseResult.matchedVenue || null,
    matchedKey: baseResult.matchedKey || null,
    matchedSourceId: baseResult.matchedSourceId || null,
    sourceYear: baseResult.sourceYear ?? null,
    sourceYearFallback: baseResult.sourceYearFallback === true,
    confidence: baseResult.confidence ?? publicationMatch.confidence ?? null,
  };
}

function resolveSearchQueryFixture(input) {
  const type = String(input?.type || 'conference').toLowerCase();
  if (type === 'journal' || type === 'journal/transaction') {
    const result = resolveJournalResolutionFixture({
      journalName: input?.query || '',
      publicationYear: input?.publicationYear ?? input?.year ?? null,
      journalMeta: input?.journalMeta || {},
    });
    return {
      status: result.status,
      primaryLabel: result.status === DECISION_STATUS.MATCHED ? result.quartile : (result.status === DECISION_STATUS.AMBIGUOUS ? 'Ambiguous' : 'Not found'),
      matchedVenue: result.matchedTitle || null,
      currentStatusLabel: result.status === DECISION_STATUS.MATCHED ? result.quartile : null,
      latestRankedSnapshot: null,
      sourceYear: result.sourceYear ?? null,
      sourceYearFallback: result.sourceYearFallback === true,
    };
  }

  const resolved = resolveConferenceSearchQuerySync(input?.query || '', input?.publicationYear ?? input?.year ?? null, input?.customCoreData);
  const primary = resolved.primary;
  return {
    status: primary.status,
    primaryLabel: primary.status === DECISION_STATUS.MATCHED
      ? primary.rank
      : (primary.status === DECISION_STATUS.UNRANKED ? 'Unranked' : (primary.status === DECISION_STATUS.AMBIGUOUS ? 'Ambiguous' : 'Not found')),
    matchedVenue: primary.matchedVenue || null,
    currentStatusLabel: formatCoreStatusLabel(primary.rawRankLabel) || null,
    latestRankedSnapshot: resolved.latestRankedSnapshot
      ? {
          rank: resolved.latestRankedSnapshot.rank,
          sourceYear: resolved.latestRankedSnapshot.sourceYear,
          matchedVenue: resolved.latestRankedSnapshot.matchedVenue,
        }
      : null,
    sourceYear: primary.sourceYear ?? null,
  };
}

function evaluateFixture(fixture) {
  switch (fixture.family) {
    case 'profile_match':
      return resolveProfileMatchFixture(fixture.input);
    case 'publication_match':
      return resolvePublicationMatchFixture(fixture.input);
    case 'track_classification':
      return resolveTrackClassificationFixture(fixture.input);
    case 'conference_resolution':
      return resolveConferenceResolutionFixture(fixture.input);
    case 'journal_resolution':
      return resolveJournalResolutionFixture(fixture.input);
    case 'pipeline_e2e':
      return resolvePipelineFixture(fixture.input);
    case 'search_queries':
      return resolveSearchQueryFixture(fixture.input);
    default:
      throw new Error(`Unsupported fixture family: ${fixture.family}`);
  }
}

function getFixtureFilesForSuite(suite) {
  const suites = suite === 'all' ? ['gold', 'shadow'] : [suite];
  const filePaths = [];
  for (const suiteName of suites) {
    const suiteDir = suiteName === 'gold' ? GOLD_DIR : SHADOW_DIR;
    if (!fs.existsSync(suiteDir)) continue;
    for (const family of FIXTURE_FAMILIES) {
      const filePath = path.join(suiteDir, `${family}.jsonl`);
      if (fs.existsSync(filePath)) filePaths.push({ suite: suiteName, family, filePath });
    }
  }
  return filePaths;
}

function loadFixtures({ suite = 'all', family = null } = {}) {
  const out = [];
  for (const file of getFixtureFilesForSuite(suite)) {
    if (family && file.family !== family) continue;
    const entries = readJsonLinesFile(file.filePath).map((entry) => ({
      ...entry,
      suite: entry.suite || file.suite,
      family: entry.family || file.family,
      fixtureFile: file.filePath,
    }));
    out.push(...entries);
  }
  return out;
}

module.exports = {
  VALID_RANKS,
  SJR_QUARTILES,
  DECISION_STATUS,
  FIXTURE_ROOT,
  BASELINE_REPORT_PATH,
  REPORTS_DIR,
  GOLD_DIR,
  SHADOW_DIR,
  REAL_DIR,
  FIXTURE_FAMILIES,
  CORE_DATA_FILES,
  ensureDir,
  readJson,
  writeJson,
  readJsonLinesFile,
  writeJsonLinesFile,
  normalizeRankForConfusion,
  normalizeIssnList,
  normalizeJournalName,
  generateJournalNormalizationVariants,
  parseYearFromText,
  generateAcronymFromTitle,
  parseBundledCoreFile,
  getCoreDataFileForYear,
  getCoreDatasetYear,
  loadCoreReference,
  loadSjrDataset,
  selectQuartileForYear,
  resolveConferenceSearchQuerySync,
  resolveJournalQuerySync,
  resolveProfileMatchFixture,
  resolvePublicationMatchFixture,
  resolveTrackClassificationFixture,
  resolveConferenceResolutionFixture,
  resolveJournalResolutionFixture,
  resolvePipelineFixture,
  resolveSearchQueryFixture,
  evaluateFixture,
  loadFixtures,
};
