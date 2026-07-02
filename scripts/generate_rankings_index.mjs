/*
 * generate_rankings_index.mjs
 * Pre-build a compact JSON index from data/rankings.csv so the extension loads
 * instantly instead of normalizing ~568k journal rows at runtime.
 *
 * Output: GSVR/data/rankings-index.json
 *   { version, startYear, endYear,
 *     core: { "<year>": [ [title, acronym, rank], ... ] },
 *     sjr:  [ [normalized, title, quartileString, tokens], ... ],
 *     venues: { entries, rankIndex, byNormalized, tokenIndex } }
 *
 * normalizeJournalName / createTokenSet mirror content.js (and read its
 * COMMON_ABBREVIATIONS via VM) so the index keys match what the matcher computes
 * for queries at runtime.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { generateDblpVenueCatalog, normalizeVenueAlias } from './generate_dblp_venue_catalog.mjs';

const require = createRequire(import.meta.url);
const rankCore = require('../GSVR/rank_core.js');

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createHelpers(commonAbbreviations) {
  function cleanTextForComparison(text) {
    if (!text) return '';
    let cleaned = String(text).toLowerCase();
    cleaned = cleaned.replace(/&/g, ' and ');
    cleaned = cleaned.replace(/[\.,\/#!$%\^;\*:{}=\_`~?"“”()\[\]]/g, ' ');
    cleaned = cleaned.replace(/\s-\s/g, ' ');
    cleaned = cleaned.replace(/^(\d{4}\s+|\d{1,2}(st|nd|rd|th)\s+)/, '');
    cleaned = cleaned.replace(/,\s*\d{4}$/, '');
    cleaned = cleaned.replace(/\(\d{4}\)$/, '');
    cleaned = cleaned.replace(/\b(part|volume|vol|issue|no|number)\s*\d+\b/g, ' ');
    cleaned = cleaned.replace(/\b\d{1,3}\b\s*$/g, ' ');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    for (const [abbr, expansion] of Object.entries(commonAbbreviations)) {
      cleaned = cleaned.replace(new RegExp(`\\b${escapeRegExp(abbr)}\\b`, 'gi'), expansion);
    }
    return cleaned.replace(/\s+/g, ' ').trim();
  }

  function normalizeJournalName(name) {
    if (!name) return '';
    let cleaned = cleanTextForComparison(name);
    if (!cleaned) return '';
    cleaned = cleaned
      .replace(/\b\d{1,6}[a-z]\b/g, ' ')
      .replace(/\b\d{1,6}\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return '';
    const stop = new Set(['a', 'an', 'the', 'of', 'and', 'for', 'in', 'on', 'to', 'at', 'journal', 'international', 'transactions', 'letters']);
    const stem = (token) => {
      if (token.length <= 4) return token;
      if (token.endsWith('ies') && token.length > 5) return token.slice(0, -3) + 'y';
      if (token.endsWith('sses')) return token;
      if (token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
      return token;
    };
    return cleaned.split(' ').map((t) => t.trim()).filter(Boolean).map(stem).filter((t) => t.length > 0 && !stop.has(t)).join(' ').trim();
  }

  function createTokenSet(normalizedTitle) {
    const stopWords = new Set(['and', 'the', 'of', 'for', 'in', 'on', 'journal', 'international', 'transactions', 'letters']);
    return Array.from(new Set(normalizedTitle.split(' ').map((t) => t.trim()).filter((t) => t.length >= 3 && !stopWords.has(t))));
  }

  function generateJournalNormalizationVariants(name) {
    const base = normalizeJournalName(name);
    if (!base) return [];
    const variants = new Set([base]);
    if (/\bcomputer\b/.test(base)) variants.add(base.replace(/\bcomputer\b/g, 'computing'));
    if (/\bcomputing\b/.test(base)) variants.add(base.replace(/\bcomputing\b/g, 'computer'));
    if (/\bacm\s+computer\b/.test(base)) variants.add(base.replace(/\bacm\s+computer\b/g, 'acm computing'));
    if (/\bcomputer\s+survey\b/.test(base)) variants.add(base.replace(/\bcomputer\b/g, 'computing'));
    if (/\bcomputing\s+survey\b/.test(base)) variants.add(base.replace(/\bcomputing\b/g, 'computer'));
    return Array.from(variants);
  }

  return { normalizeJournalName, createTokenSet, generateJournalNormalizationVariants };
}

async function readCommonAbbreviations(contentJsPath) {
  const source = await fs.readFile(contentJsPath, 'utf8');
  const match = source.match(/const\s+COMMON_ABBREVIATIONS\s*=\s*({[\s\S]*?^});/m);
  if (!match) throw new Error('Failed to extract COMMON_ABBREVIATIONS from content.js');
  return vm.runInNewContext(`(${match[1]})`);
}

function* rankingsRows(text) {
  let field = '', row = [], inQuotes = false;
  const t = text.replace(/﻿/g, '');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '"') { if (inQuotes && t[i + 1] === '"') { field += '"'; i++; } else inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { row.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !inQuotes) { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(field); if (row.some((v) => v.length)) yield row; field = ''; row = []; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); if (row.some((v) => v.length)) yield row; }
}

function chooseBetterQuartile(existing, next) {
  if (!next) return existing;
  if (!existing) return next;
  return next < existing ? next : existing; // "Q1" < "Q2" lexicographically
}

function normalizeCoreVenueCandidate(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[\.,\/#!$%\^;\*:{}=\_`~?"“”'’()\[\]+]/g, ' ')
    .replace(/[-\u2010-\u2015]/g, ' ')
    .replace(/\b(part|volume|vol|issue|no|number)\s*\d+\b/g, ' ')
    .replace(/\b\d{1,3}\b\s*$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function setUniqueLookup(map, key, value) {
  if (!key) return;
  if (!map.has(key)) {
    map.set(key, value);
  } else {
    map.set(key, null);
  }
}

function buildCoreExactLookups(core) {
  const out = new Map();
  for (const [yearStr, rows] of Object.entries(core || {})) {
    const year = parseInt(yearStr, 10);
    if (!Number.isFinite(year)) continue;
    const acronym = new Map();
    const alias = new Map();
    for (const row of rows || []) {
      const [title, acronymValue, rank] = row;
      const payload = [year, rank || 'N/A', title || '', acronymValue || ''];
      setUniqueLookup(alias, normalizeCoreVenueCandidate(title), payload);
      if (acronymValue) setUniqueLookup(acronym, String(acronymValue).trim().toLowerCase(), payload);
    }
    out.set(year, { acronym, alias });
  }
  return out;
}

function createRankTokenIndex(items, getTokens) {
  const tokenToIndexes = new Map();
  const tokenFrequency = new Map();
  items.forEach((item, index) => {
    const tokens = Array.from(new Set((getTokens(item, index) || []).map(String).filter(Boolean)));
    for (const token of tokens) {
      if (!tokenToIndexes.has(token)) tokenToIndexes.set(token, new Set());
      tokenToIndexes.get(token).add(index);
      tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
    }
  });
  return { tokenToIndexes, tokenFrequency };
}

function packRankTokenIndex(tokenIndex) {
  return {
    tokenToIndexes: Array.from(tokenIndex?.tokenToIndexes?.entries?.() || [])
      .map(([token, indexes]) => [token, Array.from(indexes || []).sort((a, b) => a - b)])
      .sort((a, b) => a[0].localeCompare(b[0])),
    tokenFrequency: Array.from(tokenIndex?.tokenFrequency?.entries?.() || [])
      .sort((a, b) => a[0].localeCompare(b[0])),
  };
}

function createVenueTokenSet(normalizedTitle) {
  const stopWords = new Set(['and', 'the', 'of', 'for', 'in', 'on', 'journal', 'conference', 'international', 'workshop', 'symposium', 'proceedings']);
  return Array.from(new Set(String(normalizedTitle || '')
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopWords.has(token))));
}

function stemVenueAlias(value) {
  return normalizeVenueAlias(value)
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

function cleanOfficialVenueName(value) {
  let text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const colonParts = text.split(/\s*:\s*/);
  if (colonParts.length > 1) {
    const afterColon = colonParts.slice(1).join(': ').trim();
    if (/\b(conference|workshop|symposium|journal|transactions|proceedings)\b/i.test(afterColon)) {
      text = afterColon;
    } else {
      text = colonParts[0].trim();
    }
  }
  text = text
    .replace(/^\s*(?:(?:companion|adjunct)\s+)?(proceedings\s+of\s+the|proceedings\s+of|proc\.?\s+of\s+the|proc\.?\s+of|proceedings|proc\.?)\s+/i, '')
    .replace(/^\s*(?:the\s+)?(?:(?:\d{4}|\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty[\s-]+first|twenty[\s-]+second|twenty[\s-]+third|twenty[\s-]+fourth|twenty[\s-]+fifth|twenty[\s-]+sixth|twenty[\s-]+seventh|twenty[\s-]+eighth|twenty[\s-]+ninth|thirtieth|thirty[\s-]+first|thirty[\s-]+second|thirty[\s-]+third|thirty[\s-]+fourth|thirty[\s-]+fifth|fortieth)\s+)+/i, '')
    .replace(/^\s*(?:the\s+)?annual\s+/i, '')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\b\d{1,4}\s*[,;:]\s*\d{1,6}\s*[-\u2010-\u2015]\s*\d{1,6}\s*$/g, ' ')
    .replace(/\b(pp\.?|pages?)\s*\d{1,6}\s*[-\u2010-\u2015]\s*\d{1,6}\s*$/gi, ' ')
    .replace(/\b(volume|vol|issue|no|number)\s*\d+\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.replace(/^\s*the\s+/i, '').trim();
}

function acronymFromOfficialName(value) {
  const paren = String(value || '').match(/\(([A-Za-z][A-Za-z0-9&+\-]{1,14})\)/);
  if (paren) return paren[1];
  const raw = String(value || '').trim();
  return /^[A-Za-z0-9&+\-]{2,14}$/.test(raw) ? raw : '';
}

function isOfficialVenueAlias(value, type = '') {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const normalized = normalizeVenueAlias(raw);
  if (!normalized || normalized.length < 2) return false;
  if (/^(conference|journal|workshop|symposium|proceedings|international conference|international journal)$/.test(normalized)) return false;
  if (/\b(proceedings|proc|volume|vol|issue|pages?|pp)\b/i.test(raw)) return false;
  if (/^(papers?\s+from|future\s+of|the\s+future\s+of)\b/i.test(raw)) return false;
  if (type !== 'workshop' && /\b(workshops?|demo|demos|poster|posters|doctoral|doct|tutorial|tutorials|track|tracks|session|sessions|companion|adjunct|extended abstract|extended abstracts)\b/i.test(raw)) return false;
  const tokenCount = normalized.split(/\s+/).filter(Boolean).length;
  if (/^[a-z0-9&+\-]{2,14}$/.test(normalized) && !normalized.includes(' ')) return true;
  if (tokenCount < 3) return false;
  if (tokenCount > 14) return false;
  return /\b(conference|workshop|symposium|journal|transactions|systems?|security|cryptography|computing|measurement|analysis|data|web|middleware|distributed|machine|learning|social|media)\b/i.test(raw)
    || tokenCount >= 4;
}

function addOfficialVenueName(set, value, type) {
  const cleaned = cleanOfficialVenueName(value);
  if (!cleaned || !isOfficialVenueAlias(cleaned, type)) return;
  set.add(cleaned);
  const withoutParenthetical = cleaned
    .replace(/\s*\(([A-Za-z][A-Za-z0-9'’&+\-]{1,14})\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (withoutParenthetical && withoutParenthetical !== cleaned && isOfficialVenueAlias(withoutParenthetical, type)) {
    set.add(withoutParenthetical);
  }
}

function getPrecomputedRankTitles(rankInfo) {
  if (!Array.isArray(rankInfo)) return [];
  if (rankInfo[0] === 'SJR') return [rankInfo[1]].filter(Boolean);
  if (rankInfo[0] === 'CORE') {
    return Array.from(new Set((Array.isArray(rankInfo[1]) ? rankInfo[1] : [])
      .map((row) => row?.[2])
      .filter(Boolean)));
  }
  return [];
}

function createCompactVenueAliases(tuple) {
  const [id, type, title, shortName, aliases, flags, yearStart, yearEnd, count, normalizedAliasesPacked, rankInfo] = tuple;
  const series = String(id || '').split('/')[1]?.split('#')[0] || '';
  const rankAcronyms = new Set([normalizeVenueAlias(series)]);
  if (rankInfo?.[0] === 'CORE') {
    for (const row of Array.isArray(rankInfo[1]) ? rankInfo[1] : []) {
      if (row?.[3]) rankAcronyms.add(normalizeVenueAlias(row[3]));
    }
  }
  const officialNames = new Set();
  const rankedOfficialNames = [];
  for (const rankedTitle of getPrecomputedRankTitles(rankInfo)) {
    const before = officialNames.size;
    addOfficialVenueName(officialNames, rankedTitle, type);
    if (officialNames.size > before) {
      const cleaned = cleanOfficialVenueName(rankedTitle);
      if (cleaned && isOfficialVenueAlias(cleaned, type)) rankedOfficialNames.push(cleaned);
    }
  }
  addOfficialVenueName(officialNames, title, type);
  if (normalizeVenueAlias(shortName) === normalizeVenueAlias(series)) {
    addOfficialVenueName(officialNames, shortName, type);
  }
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const cleaned = cleanOfficialVenueName(alias);
    const normalized = normalizeVenueAlias(cleaned);
    const standaloneAcronym = /^[a-z0-9&+\-]{2,14}$/.test(normalized) && !normalized.includes(' ');
    if (standaloneAcronym && !rankAcronyms.has(normalized)) continue;
    if (/\([0-9]+\)/.test(String(alias || ''))) continue;
    addOfficialVenueName(officialNames, alias, type);
  }

  if (!officialNames.size) {
    for (const alias of Array.isArray(normalizedAliasesPacked) ? normalizedAliasesPacked : []) addOfficialVenueName(officialNames, alias, type);
  }

  const officialList = Array.from(officialNames)
    .sort((left, right) => {
      const leftNorm = normalizeVenueAlias(left);
      const rightNorm = normalizeVenueAlias(right);
      const leftAcronym = /^[a-z0-9&+\-]{2,14}$/.test(leftNorm) && !leftNorm.includes(' ');
      const rightAcronym = /^[a-z0-9&+\-]{2,14}$/.test(rightNorm) && !rightNorm.includes(' ');
      if (leftAcronym !== rightAcronym) return leftAcronym ? 1 : -1;
      return left.length - right.length || left.localeCompare(right);
    })
    .slice(0, 12);

  const shortNames = new Set([series].filter(Boolean));
  if (normalizeVenueAlias(shortName) === normalizeVenueAlias(series)) shortNames.add(shortName);
  for (const name of officialList) {
    const acronym = acronymFromOfficialName(name);
    if (acronym) shortNames.add(acronym);
  }
  for (const acronym of rankAcronyms) {
    if (acronym) shortNames.add(acronym);
  }

  const normalizedAliases = new Set();
  const addNormalized = (value) => {
    const normalized = normalizeVenueAlias(value);
    const stemmed = stemVenueAlias(value);
    if (normalized) normalizedAliases.add(normalized);
    if (stemmed) normalizedAliases.add(stemmed);
    const withoutParenthetical = String(value || '')
      .replace(/\s*\(([A-Za-z][A-Za-z0-9'’&+\-]{1,14})\)\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (withoutParenthetical && withoutParenthetical !== String(value || '').trim()) {
      const n = normalizeVenueAlias(withoutParenthetical);
      const s = stemVenueAlias(withoutParenthetical);
      if (n) normalizedAliases.add(n);
      if (s) normalizedAliases.add(s);
    }
  };
  for (const name of officialList) addNormalized(name);
  if (!officialList.length || isOfficialVenueAlias(title, type)) addNormalized(title);
  for (const short of shortNames) {
    const normalized = normalizeVenueAlias(short);
    if (normalized && normalized.length >= 2) normalizedAliases.add(normalized);
  }
  const displayTitle = rankedOfficialNames.find((name) => normalizeVenueAlias(name).split(/\s+/).length >= 3)
    || officialList.find((name) => normalizeVenueAlias(name).split(/\s+/).length >= 3)
    || title;
  const compactShortName = Array.from(shortNames)
    .find((value) => /^[A-Za-z0-9&+\-]{2,14}$/.test(String(value || '').trim())) || '';

  return {
    tuple: [
      id,
      type,
      displayTitle || title,
      compactShortName,
      officialList.filter((name) => name !== displayTitle),
      flags,
      yearStart,
      yearEnd,
      count,
      Array.from(normalizedAliases).filter(Boolean).sort((a, b) => a.localeCompare(b)),
      rankInfo,
    ],
    rawAliasCount: Array.isArray(aliases) ? aliases.length : 0,
  };
}

function compactVenueCatalog(venues) {
  if (!venues?.entries?.length) return venues;
  let rawAliases = 0;
  let compactAliases = 0;
  venues.entries = venues.entries.map((tuple) => {
    const compact = createCompactVenueAliases(tuple);
    rawAliases += compact.rawAliasCount;
    compactAliases += Array.isArray(compact.tuple[4]) ? compact.tuple[4].length : 0;
    return compact.tuple;
  });
  delete venues.aliases;
  venues.aliasPolicy = {
    version: 1,
    kind: 'canonical-and-official-aliases',
    rawAliases,
    shippedAliases: compactAliases,
  };
  return venues;
}

function selectCandidateIndexesFromTokens(tokens, tokenIndex, limit = 48) {
  if (!tokens?.length || !tokenIndex) return null;
  const ranked = tokens
    .map((token) => ({ token, count: tokenIndex.tokenFrequency.get(token) || Number.POSITIVE_INFINITY }))
    .filter((entry) => Number.isFinite(entry.count))
    .sort((left, right) => left.count - right.count || left.token.localeCompare(right.token));
  if (!ranked.length) return null;
  let candidateSet = null;
  for (const entry of ranked.slice(0, 3)) {
    const indexes = tokenIndex.tokenToIndexes.get(entry.token);
    if (!indexes?.size) continue;
    candidateSet = candidateSet
      ? new Set([...candidateSet].filter((index) => indexes.has(index)))
      : new Set(indexes);
    if (candidateSet.size > 0 && candidateSet.size <= limit) break;
  }
  if (candidateSet?.size) return candidateSet;
  return tokenIndex.tokenToIndexes.get(ranked[0].token) || null;
}

function buildSjrQuartileString(entry, startYear, span) {
  const chars = new Array(span).fill('0');
  for (const [yr, q] of Object.entries(entry.q || {})) {
    const idx = Number(yr) - startYear;
    if (idx >= 0 && idx < span && /^Q[1-4]$/.test(q)) chars[idx] = q[1];
  }
  return chars.join('');
}

function addLookup(map, key, index) {
  const normalized = String(key || '').trim().toLowerCase();
  if (!normalized) return;
  if (!map.has(normalized)) map.set(normalized, []);
  map.get(normalized).push(index);
}

function buildCoreDirectLookups(core) {
  const out = new Map();
  for (const [yearStr, rows] of Object.entries(core || {})) {
    const year = parseInt(yearStr, 10);
    if (!Number.isFinite(year)) continue;
    const entries = (Array.isArray(rows) ? rows : []).map(([title, acronym, rank]) => ({
      title,
      acronym,
      rank,
      rawRank: rank,
      normalizedTitle: rankCore.normalizeVenueCandidate(title),
    }));
    const exactAcronym = new Map();
    const exactAlias = new Map();
    entries.forEach((entry, index) => {
      if (entry.acronym) addLookup(exactAcronym, entry.acronym, index);
      for (const alias of [
        entry.title,
        rankCore.canonicalizeCsrankingsVenueName(entry.title),
        ...(rankCore.expandVenueCandidates(entry.title) || []),
      ]) {
        const normalized = rankCore.normalizeVenueCandidate(alias);
        if (normalized) addLookup(exactAlias, normalized, index);
      }
    });
    out.set(year, {
      entries,
      exactAcronym,
      exactAlias,
      tokenIndex: createRankTokenIndex(entries, (entry) => rankCore.tokenizeNormalizedText(entry.normalizedTitle, 3)),
    });
  }
  return out;
}

function findSjrMatchForCandidates(candidates, sjrValues, sjrIndexByNormalized, sjrTokenIndex, helpers) {
  let sawAmbiguous = false;
  const variants = [];
  const seenVariants = new Set();
  for (const candidate of candidates) {
    for (const variant of helpers.generateJournalNormalizationVariants(candidate)) {
      if (!variant || seenVariants.has(variant)) continue;
      seenVariants.add(variant);
      variants.push(variant);
    }
  }
  for (const variant of variants) {
    const sjrIndex = sjrIndexByNormalized.get(variant);
    if (sjrIndex == null) continue;
    const sjrEntry = sjrValues[sjrIndex];
    return { entry: sjrEntry, score: 1, matchedBy: 'title_exact' };
  }

  let best = null;
  let second = null;
  for (const variant of variants) {
    const queryTokens = helpers.createTokenSet(variant);
    const candidateIndexes = selectCandidateIndexesFromTokens(queryTokens, sjrTokenIndex, 48) || new Set();
    for (const index of candidateIndexes) {
      const entry = sjrValues[index];
      if (!entry?.n) continue;
      const score = rankCore.hybridSimilarity(variant, entry.n);
      if (score < 0.92) continue;
      const candidate = { entry, score, matchedBy: 'title_fuzzy' };
      if (!best || score > best.score) {
        second = best;
        best = candidate;
      } else if (!second || score > second.score) {
        second = candidate;
      }
    }
  }
  if (!best) return null;
  const gap = second ? best.score - second.score : Number.POSITIVE_INFINITY;
  if (second && best.score < 0.97 && gap < 0.02) {
    sawAmbiguous = true;
  }
  return sawAmbiguous ? null : best;
}

function disambiguateCoreDirectCandidates(query, indexes, lookup) {
  let best = null;
  let second = null;
  const normalizedQuery = rankCore.normalizeVenueCandidate(query);
  for (const index of indexes || []) {
    const entry = lookup.entries[index];
    if (!entry) continue;
    const score = rankCore.hybridSimilarity(normalizedQuery, entry.normalizedTitle || rankCore.normalizeVenueCandidate(entry.title));
    const candidate = { index, score };
    if (!best || score > best.score) {
      second = best;
      best = candidate;
    } else if (!second || score > second.score) {
      second = candidate;
    }
  }
  if (!best) return null;
  const gap = second ? best.score - second.score : Number.POSITIVE_INFINITY;
  if (second && best.score < 0.97 && gap < 0.025) return null;
  return { entry: lookup.entries[best.index], score: best.score };
}

function createCoreCandidateVariants(candidates) {
  const variants = [];
  const seen = new Set();
  const push = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(trimmed);
  };
  for (const candidate of candidates) {
    push(candidate);
    push(rankCore.canonicalizeCsrankingsVenueName(candidate));
    for (const expanded of rankCore.expandVenueCandidates(candidate) || []) push(expanded);
    const parens = String(candidate || '').match(/\(([^)]+)\)/g) || [];
    for (const match of parens) {
      const value = match.slice(1, -1).trim();
      if (/^[A-Za-z][A-Za-z0-9+\-]{1,14}$/.test(value)) push(value);
    }
  }
  return variants;
}

function isSecondaryCoreAlias(value) {
  const normalized = rankCore.normalizeVenueCandidate(value);
  return /\b(workshop|doctoral|demo|demos|poster|posters|industrial|tutorial|tutorials|track|extended abstract|extended abstracts|session|held at)\b/.test(normalized);
}

function isShortForeignAcronym(value, series) {
  const raw = String(value || '').trim();
  const normalized = rankCore.normalizeVenueCandidate(raw);
  if (!normalized || normalized === series) return false;
  if (/^[A-Z0-9&+\-]{2,12}$/.test(raw)) return true;
  return /^[a-z0-9]{2,12}$/.test(normalized) && normalized !== series;
}

function createCoreRankCandidates({ id, title, shortName, aliases, normalizedAliases }) {
  const series = String(id || '').split('/')[1]?.split('#')[0]?.toLowerCase() || '';
  const out = [];
  const seen = new Set();
  const push = (value, source = 'alias') => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    const normalized = rankCore.normalizeVenueCandidate(trimmed);
    if (!normalized) return;
    if (isSecondaryCoreAlias(trimmed)) return;
    if ((source === 'shortName' || source === 'alias' || source === 'normalized') && isShortForeignAcronym(trimmed, series)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(trimmed);
  };
  push(title, 'title');
  push(shortName, 'shortName');
  for (const alias of Array.isArray(aliases) ? aliases : []) push(alias, 'alias');
  for (const alias of Array.isArray(normalizedAliases) ? normalizedAliases : []) push(alias, 'normalized');
  if (series) push(series, 'series');
  return out;
}

function makeCorePayload(year, entry, confidence, matchType) {
  return [
    year,
    String(entry.rank || '').toUpperCase(),
    entry.title || '',
    entry.acronym || '',
    typeof confidence === 'number' ? Number(confidence.toFixed(4)) : null,
    matchType || null,
  ];
}

function isAcronymLikeCoreCandidate(value) {
  const raw = String(value || '').trim();
  const normalized = rankCore.normalizeVenueCandidate(raw);
  return /^[a-z0-9&+\-]{2,12}$/.test(normalized) && !normalized.includes(' ');
}

function scoreCoreEntryAgainstQueries(entry, queries) {
  const title = entry?.normalizedTitle || rankCore.normalizeVenueCandidate(entry?.title || '');
  if (!title) return 0;
  let best = 0;
  for (const query of queries || []) {
    const normalized = rankCore.normalizeVenueCandidate(query);
    if (!normalized || isAcronymLikeCoreCandidate(normalized)) continue;
    best = Math.max(best, rankCore.hybridSimilarity(normalized, title));
  }
  return best;
}

function resolveCoreAcronymMatch(candidate, indexes, lookup, descriptiveVariants) {
  if (!indexes?.length) return null;
  const hasDescriptiveContext = Array.isArray(descriptiveVariants) && descriptiveVariants.length > 0;
  if (!hasDescriptiveContext) {
    const exact = indexes.length === 1
      ? { entry: lookup.entries[indexes[0]], score: 1 }
      : disambiguateCoreDirectCandidates(candidate, indexes, lookup);
    return exact?.entry ? exact : null;
  }

  let best = null;
  let second = null;
  for (const index of indexes) {
    const entry = lookup.entries[index];
    if (!entry) continue;
    const score = scoreCoreEntryAgainstQueries(entry, descriptiveVariants);
    const next = { entry, score };
    if (!best || score > best.score) {
      second = best;
      best = next;
    } else if (!second || score > second.score) {
      second = next;
    }
  }
  if (!best || best.score < 0.58) return null;
  const gap = second ? best.score - second.score : Number.POSITIVE_INFINITY;
  if (second && best.score < 0.97 && gap < 0.025) return null;
  return best;
}

function findCoreMatchForCandidates(candidates, coreLookups) {
  const validRank = (rank) => ['A*', 'A', 'B', 'C'].includes(String(rank || '').toUpperCase());
  const byYear = [];
  const variants = createCoreCandidateVariants(candidates);
  const descriptiveVariants = variants.filter((variant) => !isAcronymLikeCoreCandidate(variant));
  for (const [year, lookup] of coreLookups.entries()) {
    let matched = null;
    for (const candidate of variants) {
      if (isAcronymLikeCoreCandidate(candidate)) continue;
      const normalized = rankCore.normalizeVenueCandidate(candidate);
      const aliasIndexes = lookup.exactAlias.get(normalized) || [];
      const exact = aliasIndexes.length === 1
        ? { entry: lookup.entries[aliasIndexes[0]], score: 1 }
        : disambiguateCoreDirectCandidates(candidate, aliasIndexes, lookup);
      if (exact?.entry && validRank(exact.entry.rank)) {
        matched = makeCorePayload(year, exact.entry, exact.score, 'alias_exact');
        break;
      }
    }
    if (!matched) {
      let best = null;
      let second = null;
      for (const candidate of variants) {
        const normalized = rankCore.normalizeVenueCandidate(candidate);
        if (normalized.length < 6 || isAcronymLikeCoreCandidate(normalized)) continue;
        const queryTokens = rankCore.tokenizeNormalizedText(normalized, 3);
        const candidateIndexes = selectCandidateIndexesFromTokens(queryTokens, lookup.tokenIndex, 32) || new Set();
        for (const index of candidateIndexes) {
          const entry = lookup.entries[index];
          if (!entry?.normalizedTitle || !validRank(entry.rank)) continue;
          const score = rankCore.hybridSimilarity(normalized, entry.normalizedTitle);
          if (score < 0.9) continue;
          const next = { entry, score };
          if (!best || score > best.score) {
            second = best;
            best = next;
          } else if (!second || score > second.score) {
            second = next;
          }
        }
      }
      const gap = second ? best.score - second.score : Number.POSITIVE_INFINITY;
      if (best && (!second || best.score >= 0.97 || gap >= 0.025)) {
        matched = makeCorePayload(year, best.entry, best.score, 'title_fuzzy');
      }
    }
    if (!matched) {
      for (const candidate of variants) {
        const acronymIndexes = lookup.exactAcronym.get(String(candidate || '').trim().toLowerCase()) || [];
        const exact = resolveCoreAcronymMatch(candidate, acronymIndexes, lookup, descriptiveVariants);
        if (exact?.entry && validRank(exact.entry.rank)) {
          matched = makeCorePayload(year, exact.entry, exact.score, 'acronym_exact');
          break;
        }
      }
    }
    if (matched) byYear.push(matched);
  }
  return byYear;
}

function attachVenueLookupIndexes(venues) {
  if (!venues?.entries?.length) return venues;
  const byNormalized = new Map();
  const addNormalized = (normalized, index) => {
    const key = String(normalized || '').trim();
    if (!key) return;
    if (!byNormalized.has(key)) byNormalized.set(key, new Set());
    byNormalized.get(key).add(index);
  };

  const catalogAliases = venues.aliases && typeof venues.aliases === 'object' ? venues.aliases : {};
  for (const [key, indexes] of Object.entries(catalogAliases)) {
    for (const index of Array.isArray(indexes) ? indexes : [indexes]) {
      const numericIndex = Number(index);
      if (Number.isFinite(numericIndex) && venues.entries[numericIndex]) {
        addNormalized(key, numericIndex);
      }
    }
  }

  const tokenIndex = createRankTokenIndex(venues.entries, (tuple, index) => {
    const normalizedAliases = Array.isArray(tuple?.[9]) ? tuple[9] : [];
    const tokens = new Set();
    for (const alias of normalizedAliases) {
      addNormalized(alias, index);
      for (const token of createVenueTokenSet(alias)) tokens.add(token);
    }
    return Array.from(tokens);
  });

  venues.byNormalized = Array.from(byNormalized.entries())
    .map(([key, indexes]) => [key, Array.from(indexes).sort((a, b) => a - b)])
    .sort((a, b) => a[0].localeCompare(b[0]));
  venues.tokenIndex = packRankTokenIndex(tokenIndex);
  return venues;
}

function attachUnifiedVenueRanks({ venues, core, sjrValues, sjrIndexByNormalized, helpers, startYear, span }) {
  if (!venues?.entries?.length) return venues;
  const coreLookups = buildCoreDirectLookups(core);
  const sjrTokenIndex = createRankTokenIndex(sjrValues, (entry) => helpers.createTokenSet(entry.n));
  let coreAttached = 0;
  let sjrAttached = 0;
  let coreFuzzyAttached = 0;
  let sjrFuzzyAttached = 0;

  for (const tuple of venues.entries) {
    if (!Array.isArray(tuple)) continue;
    const [id, type, title, shortName, aliases, flags, yearStart, yearEnd, count, normalizedAliasesPacked] = tuple;
    tuple[10] = null;
    const candidates = Array.from(new Set([title, shortName, ...(Array.isArray(aliases) ? aliases : []), ...(Array.isArray(normalizedAliasesPacked) ? normalizedAliasesPacked : [])]
      .map((value) => String(value || '').trim())
      .filter(Boolean)));

    if (type === 'journal') {
      const match = findSjrMatchForCandidates(candidates, sjrValues, sjrIndexByNormalized, sjrTokenIndex, helpers);
      if (match?.entry) {
        tuple[10] = ['SJR', match.entry.t, match.entry.n, buildSjrQuartileString(match.entry, startYear, span), match.matchedBy, Number(match.score.toFixed(4))];
        sjrAttached++;
        if (match.matchedBy !== 'title_exact') sjrFuzzyAttached++;
      }
      continue;
    }

    if (type !== 'conference') continue;
    const byYear = findCoreMatchForCandidates(createCoreRankCandidates({
      id,
      title,
      shortName,
      aliases,
      normalizedAliases: normalizedAliasesPacked,
    }), coreLookups);
    if (byYear.length) {
      tuple[10] = ['CORE', byYear.sort((left, right) => right[0] - left[0])];
      coreAttached++;
      if (byYear.some((row) => row[5] && !String(row[5]).includes('exact'))) coreFuzzyAttached++;
    }
  }
  venues.rankIndex = {
    version: 2,
    attached: {
      core: coreAttached,
      sjr: sjrAttached,
      coreFuzzy: coreFuzzyAttached,
      sjrFuzzy: sjrFuzzyAttached,
    },
  };
  return venues;
}

async function readExistingVenueCatalog(outPath) {
  try {
    const existing = JSON.parse(await fs.readFile(outPath, 'utf8'));
    return existing?.venues || null;
  } catch {
    return null;
  }
}

async function buildVenueCatalog({ outPath, dblpXmlPath, dblpDtdPath }) {
  const xmlPath = dblpXmlPath || process.env.DBLP_XML_PATH || null;
  const dtdPath = dblpDtdPath || process.env.DBLP_DTD_PATH || null;
  if (!xmlPath) {
    return await readExistingVenueCatalog(outPath);
  }
  return await generateDblpVenueCatalog({
    xmlPath,
    dtdPath,
    source: {
      requestedXmlPath: path.basename(xmlPath),
      requestedDtdPath: dtdPath ? path.basename(dtdPath) : null,
    },
  });
}

export async function generateRankingsIndex({ root = process.cwd(), dblpXmlPath = null, dblpDtdPath = null } = {}) {
  const srcDir = path.join(root, 'GSVR');
  const csvPath = path.join(srcDir, 'data', 'rankings.csv');
  const outPath = path.join(srcDir, 'data', 'rankings-index.json');
  const commonAbbreviations = await readCommonAbbreviations(path.join(srcDir, 'content.js'));
  const helpers = createHelpers(commonAbbreviations);
  const { normalizeJournalName, createTokenSet } = helpers;

  const text = await fs.readFile(csvPath, 'utf8');
  const core = {};
  const byNormalized = new Map();
  let startYear = Number.POSITIVE_INFINITY, endYear = Number.NEGATIVE_INFINITY;
  let isHeader = true;

  for (const row of rankingsRows(text)) {
    if (isHeader) { isHeader = false; continue; }
    const [source, yearStr, title, acronym, rank] = row;
    const year = parseInt(yearStr, 10);
    if (!title || !Number.isFinite(year)) continue;
    if (source === 'CORE') {
      (core[year] ||= []).push([title, acronym || '', rank]);
    } else if (source === 'SCImago') {
      const quartile = String(rank || '').toUpperCase();
      if (!/^Q[1-4]$/.test(quartile)) continue;
      startYear = Math.min(startYear, year);
      endYear = Math.max(endYear, year);
      const n = normalizeJournalName(title);
      if (!n) continue;
      let entry = byNormalized.get(n);
      if (!entry) { entry = { n, t: title, q: {} }; byNormalized.set(n, entry); }
      else if (title.length > entry.t.length) entry.t = title;
      entry.q[year] = chooseBetterQuartile(entry.q[year], quartile);
    }
  }

  // Compact each SJR entry to a tuple [n, t, qstr], where qstr has one char per
  // year from startYear..endYear: '0' = unranked, '1'-'4' = Q1-Q4. Tokens (k)
  // are dropped and recomputed from n at load. This shrinks the index ~3x.
  const span = Number.isFinite(startYear) && Number.isFinite(endYear) ? endYear - startYear + 1 : 0;
  const sjrValues = Array.from(byNormalized.values());
  const sjrIndexByNormalized = new Map(sjrValues.map((entry, index) => [entry.n, index]));
  const sjr = sjrValues.map((e) => [e.n, e.t, buildSjrQuartileString(e, startYear, span), createTokenSet(e.n)]);
  const sjrTokenIndex = packRankTokenIndex(createRankTokenIndex(sjrValues, (entry) => createTokenSet(entry.n)));

  const venues = await buildVenueCatalog({ outPath, dblpXmlPath, dblpDtdPath });
  attachUnifiedVenueRanks({ venues, core, sjrValues, sjrIndexByNormalized, helpers, startYear, span });
  compactVenueCatalog(venues);
  attachVenueLookupIndexes(venues);
  const index = {
    version: 3,
    startYear: Number.isFinite(startYear) ? startYear : null,
    endYear: Number.isFinite(endYear) ? endYear : null,
    core,
    sjr,
    sjrTokenIndex,
    venues: venues || {
      version: 1,
      generatedAt: null,
      source: { kind: 'not-generated' },
      entries: [],
      byNormalized: [],
      tokenIndex: { tokenToIndexes: [], tokenFrequency: [] },
    }
  };
  await fs.writeFile(outPath, JSON.stringify(index));
  return { outPath, sjrCount: sjr.length, coreYears: Object.keys(core).length, venueCount: index.venues.entries.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateRankingsIndex({ root: process.cwd() }).then((r) => {
    console.log(`Wrote ${r.outPath}  (SJR entries: ${r.sjrCount}, CORE years: ${r.coreYears}, DBLP venues: ${r.venueCount})`);
  });
}
