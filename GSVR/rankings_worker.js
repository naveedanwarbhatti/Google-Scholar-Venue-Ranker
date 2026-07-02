"use strict";

const SJR_DATASET_START_YEAR = 1999;
const SJR_DATASET_END_YEAR = 2025;

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function createTokenSet(normalizedTitle) {
  const stopWords = new Set(['and', 'the', 'of', 'for', 'in', 'on', 'journal', 'international', 'transactions', 'letters']);
  return Array.from(new Set(String(normalizedTitle || '')
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopWords.has(token))));
}

function createVenueTokenSet(normalizedTitle) {
  const stopWords = new Set(['and', 'the', 'of', 'for', 'in', 'on', 'journal', 'conference', 'international', 'workshop', 'symposium', 'proceedings']);
  return Array.from(new Set(String(normalizedTitle || '')
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopWords.has(token))));
}

function packTokenIndex(entries, tokenReader) {
  const tokenToIndexes = new Map();
  const tokenFrequency = new Map();
  for (let index = 0; index < entries.length; index++) {
    for (const token of tokenReader(entries[index]) || []) {
      if (!tokenToIndexes.has(token)) tokenToIndexes.set(token, []);
      tokenToIndexes.get(token).push(index);
      tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
    }
  }
  return {
    tokenToIndexes: Array.from(tokenToIndexes.entries()),
    tokenFrequency: Array.from(tokenFrequency.entries()),
  };
}

function normalizeDblpVenueAlias(value) {
  return normalizeSpaces(String(value || '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/@/g, ' ')
    .replace(/\s*(?:\.\.\.|…)\s*$/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ')
    .replace(/[\.,\/#!$%\^;\*:{}=\_`~?"“”'’()\[\]+]/g, ' ')
    .replace(/[-\u2010-\u2015]/g, ' ')
    .replace(/^\s*(proceedings\s+of\s+the|proceedings\s+of|proc\.?\s+of\s+the|proc\.?\s+of|proceedings|proc\.?)\s+/i, ''));
}

function normalizeDblpVenueAliasStemmed(value) {
  return normalizeDblpVenueAlias(value)
    .split(' ')
    .map((token) => {
      if (token.length <= 4) return token;
      if (token.endsWith('ies') && token.length > 5) return token.slice(0, -3) + 'y';
      if (token.endsWith('sses')) return token;
      if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
      return token;
    })
    .join(' ')
    .trim();
}

function acronymVariantsFromCompactAlias(value) {
  const compact = normalizeDblpVenueAlias(value).replace(/\s+/g, '');
  if (!/^[a-z0-9]{4,24}$/.test(compact)) return [];
  const variants = new Set([compact]);
  for (const prefix of ['euro', 'asia', 'acm', 'ieee', 'ifip', 'usenix']) {
    if (compact.startsWith(prefix) && compact.length - prefix.length >= 3) {
      variants.add(compact.slice(prefix.length));
    }
  }
  return Array.from(variants);
}

function buildCoreByYear(core) {
  const rows = [];
  for (const [yearStr, yearRows] of Object.entries(core || {})) {
    const year = parseInt(yearStr, 10);
    if (!Number.isFinite(year)) continue;
    rows.push([year, (Array.isArray(yearRows) ? yearRows : []).map(([title, acronym, rank]) => ({
      title,
      acronym,
      rank,
      rawRank: rank,
    }))]);
  }
  return rows;
}

function buildSjrDataset(index) {
  const startYear = index.startYear ?? SJR_DATASET_START_YEAR;
  const entries = [];
  const byNormalized = [];
  for (const row of Array.isArray(index.sjr) ? index.sjr : []) {
    const [n, t, qstr, packedTokens] = row;
    if (!n || !t || !qstr) continue;
    // Keep the packed per-year quartile string ('0' = unranked, '1'-'4' = Q1-Q4)
    // instead of exploding it into one object per entry; decoded on lookup.
    const entry = {
      normalizedTitle: n,
      resolvedTitle: t,
      quartileString: qstr,
      quartileStartYear: startYear,
      tokenSet: Array.isArray(packedTokens) && packedTokens.length ? packedTokens : createTokenSet(n),
      issns: [],
      sourceId: null,
      coverage: null,
    };
    byNormalized.push([n, entries.length]);
    entries.push(entry);
  }
  return {
    version: index.version ?? 1,
    startYear: index.startYear ?? SJR_DATASET_START_YEAR,
    endYear: index.endYear ?? SJR_DATASET_END_YEAR,
    entries,
    byNormalized,
    tokenIndex: index.sjrTokenIndex && Array.isArray(index.sjrTokenIndex.tokenToIndexes)
      ? index.sjrTokenIndex
      : packTokenIndex(entries, (entry) => entry.tokenSet),
  };
}

function buildVenueDataset(catalog) {
  const rawEntries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  const entries = [];
  const rawIndexToEntryIndex = [];
  for (let rawIndex = 0; rawIndex < rawEntries.length; rawIndex++) {
    const tuple = rawEntries[rawIndex];
    const [id, type, title, shortName, aliases, flags, yearStart, yearEnd, count, packedNormalizedAliases, rankInfo] = Array.isArray(tuple) ? tuple : [];
    const aliasList = Array.isArray(aliases) ? aliases : [];
    const normalizedAliases = Array.isArray(packedNormalizedAliases) && packedNormalizedAliases.length
      ? Array.from(new Set(packedNormalizedAliases.map(String).filter(Boolean)))
      : Array.from(new Set([
        normalizeDblpVenueAlias(title),
        normalizeDblpVenueAliasStemmed(title),
        normalizeDblpVenueAlias(shortName),
        normalizeDblpVenueAliasStemmed(shortName),
        ...aliasList.map(normalizeDblpVenueAlias),
        ...aliasList.map(normalizeDblpVenueAliasStemmed),
        ...[title, shortName, ...aliasList].flatMap(acronymVariantsFromCompactAlias),
      ].filter(Boolean)));
    if (!id || !title || !normalizedAliases.length) continue;
    rawIndexToEntryIndex[rawIndex] = entries.length;
    entries.push({
      id: String(id),
      type: String(type || 'unknown'),
      title: String(title || ''),
      shortName: String(shortName || ''),
      aliases: aliasList,
      normalizedAliases,
      flags: Array.isArray(flags) ? flags.map(String) : [],
      yearStart: Number.isFinite(yearStart) ? yearStart : null,
      yearEnd: Number.isFinite(yearEnd) ? yearEnd : null,
      count: Number.isFinite(count) ? count : 0,
      rankInfo: Array.isArray(rankInfo) ? rankInfo : null,
    });
  }

  let byNormalized = null;
  if (Array.isArray(catalog?.byNormalized) && catalog.byNormalized.length) {
    byNormalized = catalog.byNormalized
      .map(([key, indexes]) => [
        String(key || '').trim(),
        (Array.isArray(indexes) ? indexes : [indexes])
          .map((index) => rawIndexToEntryIndex[Number(index)])
          .filter((index) => Number.isFinite(index)),
      ])
      .filter(([key, indexes]) => key && indexes.length);
  }
  if (!byNormalized) {
    const byNormalizedMap = new Map();
    const aliases = catalog?.aliases && typeof catalog.aliases === 'object' ? catalog.aliases : {};
    for (const [key, indexes] of Object.entries(aliases)) {
      const normalized = normalizeDblpVenueAlias(key);
      const mapped = (Array.isArray(indexes) ? indexes : [indexes])
        .map((index) => rawIndexToEntryIndex[Number(index)])
        .filter((index) => Number.isFinite(index));
      if (normalized && mapped.length) byNormalizedMap.set(normalized, Array.from(new Set(mapped)));
    }
    for (let index = 0; index < entries.length; index++) {
      for (const alias of entries[index].normalizedAliases || []) {
        if (!byNormalizedMap.has(alias)) byNormalizedMap.set(alias, []);
        const list = byNormalizedMap.get(alias);
        if (!list.includes(index)) list.push(index);
      }
    }
    byNormalized = Array.from(byNormalizedMap.entries());
  }

  return {
    version: catalog?.version ?? 1,
    source: catalog?.source || null,
    entries,
    byNormalized,
    tokenIndex: catalog?.tokenIndex && Array.isArray(catalog.tokenIndex.tokenToIndexes)
      ? catalog.tokenIndex
      : packTokenIndex(entries, (entry) => {
      const tokens = new Set();
      for (const alias of entry.normalizedAliases || []) {
        for (const token of createVenueTokenSet(alias)) tokens.add(token);
      }
      return Array.from(tokens);
    }),
    available: entries.length > 0,
  };
}

self.onmessage = async (event) => {
  const message = event.data || {};
  if (message.type !== 'load') return;
  const timings = {};
  const totalStartedAt = nowMs();
  try {
    const fetchStartedAt = nowMs();
    const response = await fetch(message.indexUrl);
    if (!response.ok) throw new Error(`Failed to fetch rankings index: ${response.status} ${response.statusText}`);
    timings.fetchMs = Math.round(nowMs() - fetchStartedAt);

    const parseStartedAt = nowMs();
    const index = await response.json();
    timings.parseMs = Math.round(nowMs() - parseStartedAt);

    const coreStartedAt = nowMs();
    const coreByYear = buildCoreByYear(index.core || {});
    timings.coreMs = Math.round(nowMs() - coreStartedAt);

    const sjrStartedAt = nowMs();
    const sjrDataset = buildSjrDataset(index);
    timings.sjrMs = Math.round(nowMs() - sjrStartedAt);

    const venueStartedAt = nowMs();
    const venueDataset = buildVenueDataset(index.venues || null);
    timings.venueMs = Math.round(nowMs() - venueStartedAt);
    timings.totalMs = Math.round(nowMs() - totalStartedAt);

    self.postMessage({
      type: 'ready',
      timings,
      payload: {
        coreByYear,
        sjrDataset,
        venueDataset,
        timings,
      },
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      error: error?.message || String(error),
      timings: {
        ...timings,
        totalMs: Math.round(nowMs() - totalStartedAt),
      },
    });
  }
};
