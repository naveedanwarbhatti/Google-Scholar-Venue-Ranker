/*
 * rank_core.js
 * Shared ranking utilities used by the content script and Node tests.
 */

(function (root, factory) {
  const isNode = (typeof module === 'object' && module.exports);
  const venueData = isNode
    ? require('./venue_data.js')
    : (root.GSVRVenueData || {});
  const textNormalize = isNode
    ? require('./core/text_normalize.js')
    : (root.GSVRTextNormalize || {});

  if (isNode) {
    module.exports = factory(venueData, textNormalize);
  } else {
    root.GSVRUtils = factory(venueData, textNormalize);
  }
})(typeof self !== 'undefined' ? self : this, function (venueData, textNormalize) {
  'use strict';

  const foldDiacritics = (textNormalize && typeof textNormalize.foldDiacritics === 'function')
    ? textNormalize.foldDiacritics
    : (value) => String(value ?? '');

  const DECISION_VERSION = 3;
  const DECISION_STATUS = Object.freeze({
    MATCHED: 'matched',
    UNRANKED: 'unranked',
    AMBIGUOUS: 'ambiguous',
    MISSING: 'missing',
  });
  const WORD_ORDINAL_ONES = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth'];
  const WORD_ORDINAL_TEENS = ['tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth'];
  const WORD_ORDINAL_TENS = ['twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth', 'seventieth', 'eightieth', 'ninetieth'];
  const WORD_ORDINAL_TENS_PREFIXES = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const WORD_ORDINAL_PATTERN = new RegExp(`\\b(?:${[
    ...WORD_ORDINAL_ONES,
    ...WORD_ORDINAL_TEENS,
    ...WORD_ORDINAL_TENS,
    ...WORD_ORDINAL_TENS_PREFIXES.flatMap(prefix => WORD_ORDINAL_ONES.map(one => `${prefix}${one}`))
  ].join('|')})\\b`, 'gi');

  const RANKING_CONFIG = Object.freeze({
    profileNameSimilarityThreshold: 0.72,
    profileMinOverlapCount: 2,
    profileMatchScoreThreshold: 3.6,
    profileStrongScoreThreshold: 5.4,
    profileAmbiguityGap: 0.45,
    publicationSimilarityThreshold: 0.88,
    publicationStrongSimilarityThreshold: 0.94,
    publicationMaxYearDiff: 2,
    publicationStrongYearDiff: 4,
    publicationAmbiguityGap: 0.018,
    coreFuzzyThreshold: 0.83,
    coreAmbiguityGap: 0.02,
    sjrFuzzyThreshold: 0.83,
    sjrAmbiguityGap: 0.015,
  });

  const TRACK_PREFIXES = [
    /^ph\.?d\.?\s+forum\s+abstract\s*:\s*/i,
    /^phd\s+forum\s+abstract\s*:\s*/i,
    /^ph\.?d\.?\s+forum\s*:\s*/i,
    /^doctoral\s+consortium\s*:\s*/i,
    /^doctoral\s+symposium\s*:\s*/i,
    /^poster\s*:\s*/i,
    /^demo\s*:\s*/i,
    /^demonstration\s*:\s*/i,
    /^short\s+paper\s*:\s*/i,
    /^work\s*-?\s*in\s*-?\s*progress\s*:\s*/i,
  ];

  // NOTE: deliberately no bare "@" alternative — "X@Y" workshop notation is
  // detected separately from VENUE fields only, so paper titles containing "@"
  // ("Energy@home: ...") cannot misclassify a main-track paper as a workshop.
  const WORKSHOP_RX = /(\bworkshop\b|\bws\b|\bworkshop\s+on\b|\bworkshop\s+proceedings\b|\bco\s*-?located\b|\bco\s*-?located\s+with\b|\bcolocated\b|\bsatellite\b|\bassociated\s+workshop\b|\baffiliated\s+workshop\b|\bworkshop\s+track\b|\bproceedings\s+of\s+the\s+[\s\S]*\bworkshop\b)/i;
  const EXTENDED_ABSTRACT_RX = /(\bextended\s+abstracts?\b)/i;
  const DEMO_POSTER_VENUE_RX = /(\bposter\b|\bposters\b|\bdemo\b|\bdemos\b|\bdemonstration\b|\bdemonstrations\b|\bcompanion\b|\badjunct\b|\bsupplement\b|\bdoctoral\s+(consortium|symposium)\b|\bph\.?d\.?\s+forum\b|\bforum\s+abstract\b|\bstudent\s+research\b|\bwork\s*-?\s*in\s*-?\s*progress\b|\bwip\b|\bindustry\s+track\b|\btool\s+demonstration\b)/i;
  const DEMO_POSTER_TITLE_RX = /(\bposter\b|\bdemo\b|\blate\s+breaking\b|\bwork\s*-?\s*in\s*-?\s*progress\b|\bwip\b|\bdoctoral\s+(consortium|symposium)\b|\bph\.?d\.?\s+forum\b|\bcompanion\b|\badjunct\b|\btool\s+demonstration\b)/i;

  function normalizeSpaces(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function stripTrackPrefixes(title) {
    if (!title) return '';
    let result = String(title);
    for (const rx of TRACK_PREFIXES) {
      result = result.replace(rx, '');
    }
    return result;
  }

  function normalizeForMatch(value) {
    const stripped = stripTrackPrefixes(value);
    return normalizeSpaces(
      foldDiacritics(stripped)
        .toLowerCase()
        .replace(/\p{Extended_Pictographic}/gu, ' ')
        .replace(/[\uFE0E\uFE0F]/g, ' ')
        .replace(/&/g, ' and ')
        .replace(/[\.,\/#!$%\^&\*;:{}=\_`~?"“”'’\(\)\[\]\+＋]/g, ' ')
        .replace(/[-\u2010-\u2015]/g, ' ')
    );
  }

  function normalizeVenueCandidate(venue) {
    let normalized = normalizeForMatch(venue);
    normalized = normalized.replace(WORD_ORDINAL_PATTERN, ' ');
    normalized = normalized.replace(/\b(part|volume|vol|issue|no|number)\s*\d+\b/g, ' ');
    normalized = normalized.replace(/\b\d{1,3}\b\s*$/g, '');
    return normalizeSpaces(normalized);
  }

  function normalizeProfileName(name) {
    return normalizeSpaces(
      foldDiacritics(String(name || ''))
        .toLowerCase()
        .replace(/[\.,'’"]/g, ' ')
        .replace(/\s+/g, ' ')
    );
  }

  function stripParenNumberSuffix(value) {
    return String(value || '').replace(/\s*\(\s*\d+\s*\)\s*$/g, '').trim();
  }

  function normalizeKey(value) {
    return normalizeSpaces(foldDiacritics(String(value || ''))).toLowerCase();
  }

  function buildJournalLookupCacheKey(normalizedQuery, queryIssns) {
    const base = normalizeSpaces(String(normalizedQuery || '')).toLowerCase();
    const issns = Array.isArray(queryIssns)
      ? Array.from(new Set(
          queryIssns
            .map((value) => String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase())
            .filter(Boolean)
        )).sort()
      : [];
    return issns.length ? `${base}::issn:${issns.join(',')}` : base;
  }

  function tokenizeNormalizedText(value, minLength) {
    const min = Number.isFinite(minLength) ? minLength : 2;
    return normalizeSpaces(String(value || ''))
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= min);
  }

  function tokenJaccard(a, b) {
    const ta = new Set(tokenizeNormalizedText(a, 2));
    const tb = new Set(tokenizeNormalizedText(b, 2));
    if (ta.size === 0 || tb.size === 0) return 0;
    let intersection = 0;
    for (const token of ta) {
      if (tb.has(token)) intersection++;
    }
    const union = ta.size + tb.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  function hybridSimilarity(a, b) {
    return 0.72 * jaroWinkler(a, b) + 0.28 * tokenJaccard(a, b);
  }

  function buildRareTokenIndex(items, getValue, minTokenLength) {
    const tokenToItems = new Map();
    const tokenFrequency = new Map();
    items.forEach((item, index) => {
      const value = typeof getValue === 'function' ? getValue(item) : item;
      const tokens = Array.from(new Set(tokenizeNormalizedText(value, minTokenLength || 3)));
      for (const token of tokens) {
        if (!tokenToItems.has(token)) tokenToItems.set(token, new Set());
        tokenToItems.get(token).add(index);
        tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
      }
    });
    return { tokenToItems, tokenFrequency };
  }

  function intersectSets(left, right) {
    const out = new Set();
    for (const value of left) {
      if (right.has(value)) out.add(value);
    }
    return out;
  }

  function getCandidateIndexesFromTokens(tokens, tokenIndex) {
    if (!Array.isArray(tokens) || !tokens.length || !tokenIndex) return null;
    const rankedTokens = tokens
      .map((token) => ({ token, count: tokenIndex.tokenFrequency.get(token) || Number.POSITIVE_INFINITY }))
      .filter((entry) => Number.isFinite(entry.count))
      .sort((a, b) => a.count - b.count || a.token.localeCompare(b.token));

    if (!rankedTokens.length) return null;

    let candidateSet = null;
    for (const entry of rankedTokens.slice(0, 3)) {
      const indexes = tokenIndex.tokenToItems.get(entry.token);
      if (!indexes || !indexes.size) continue;
      candidateSet = candidateSet ? intersectSets(candidateSet, indexes) : new Set(indexes);
      if (candidateSet.size > 0 && candidateSet.size <= 32) {
        break;
      }
    }

    if (candidateSet && candidateSet.size) return candidateSet;
    return new Set(tokenIndex.tokenToItems.get(rankedTokens[0].token) || []);
  }

  function expandVenueCandidates(rawVenue, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const includeAtParent = options.includeAtParent !== false;
    const out = new Set();
    const value = String(rawVenue || '').trim();
    if (!value) return [];

    out.add(value);
    const atMatch = value.match(/\b([A-Za-z][A-Za-z0-9\-]{1,20})\s*@\s*([A-Za-z][A-Za-z0-9\-]{1,20})\b/);
    if (atMatch) {
      out.add(atMatch[1]);
      if (includeAtParent) out.add(atMatch[2]);
    }

    if (!includeAtParent) {
      const coloc = value.match(/^(.*?)(?:\bco\s*-?located\s+with\b|\bcolocated\s+with\b|\bin\s+conjunction\s+with\b|\baffiliated\s+with\b|\bassociated\s+with\b)\s+.*$/i);
      if (coloc && coloc[1]) {
        const prefix = coloc[1].trim();
        if (prefix) out.add(prefix);
      }
    }

    const normalized = normalizeVenueCandidate(value);
    if (normalized && normalized !== normalizeForMatch(value)) {
      out.add(normalized);
    }

    const noParenNumber = value.replace(/\s*\(\s*\d{1,3}\s*\)\s*$/g, '').trim();
    if (noParenNumber && noParenNumber !== value) {
      out.add(noParenNumber);
    }

    return Array.from(out);
  }

  function jaroWinkler(s1, s2) {
    if (!s1 || !s2) return 0;
    const a = String(s1);
    const b = String(s2);
    const bound = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const matchA = new Array(a.length).fill(false);
    const matchB = new Array(b.length).fill(false);
    let matches = 0;

    for (let i = 0; i < a.length; i++) {
      const lo = Math.max(0, i - bound);
      const hi = Math.min(i + bound + 1, b.length);
      for (let j = lo; j < hi; j++) {
        if (!matchB[j] && a[i] === b[j]) {
          matchA[i] = true;
          matchB[j] = true;
          matches++;
          break;
        }
      }
    }

    if (!matches) return 0;

    let k = 0;
    let transpositions = 0;
    for (let i = 0; i < a.length; i++) {
      if (matchA[i]) {
        while (!matchB[k]) k++;
        if (a[i] !== b[k]) transpositions++;
        k++;
      }
    }
    transpositions /= 2;

    const jaro = (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
    let prefix = 0;
    for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
      if (a[i] === b[i]) prefix++;
      else break;
    }
    return jaro + prefix * 0.1 * (1 - jaro);
  }

  function getPageCountFromPagesString(pageStr) {
    if (!pageStr) return null;
    const value = String(pageStr).trim();
    if (!value) return null;

    if (/^(article\s+\d+|\d+$|[ivxlcdm]+$)/i.test(value) && !value.includes('-') && !value.includes(':')) {
      return null;
    }

    let match = value.match(/^([a-z]+)\s*(\d+)\s*[-‑–—]\s*([a-z]+)\s*(\d+)$/i);
    if (match) {
      const start = parseInt(match[2], 10);
      const end = parseInt(match[4], 10);
      if (!isNaN(start) && !isNaN(end) && end >= start) return end - start + 1;
    }

    match = value.match(/^(?:[a-z\d]+:)?(\d+)\s*[-‑–—]\s*(?:[a-z\d]+:)?(\d+)$/i);
    if (match) {
      const start = parseInt(match[1], 10);
      const end = parseInt(match[2], 10);
      if (!isNaN(start) && !isNaN(end) && end >= start) return end - start + 1;
    }

    match = value.match(/^(?:(\d+):)?(\d+)\s*[-‑–—]\s*(?:(\d+):)?(\d+)$/i);
    if (match) {
      const startPage = parseInt(match[2], 10);
      const endPage = parseInt(match[4], 10);
      if (!isNaN(startPage) && !isNaN(endPage) && endPage >= startPage) return endPage - startPage + 1;
    }
    return null;
  }

  function addSignal(signals, scores, key, score, detail) {
    scores[key] = (scores[key] || 0) + score;
    signals.push(detail ? `${key}:${detail}` : key);
  }

  function classifyVenueTrack({ title, venue, venue_full, acronym, dblpKey, scholarVenue, pageCount, dblpType, crossref }) {
    const signals = [];
    const scores = { workshop: 0, demoPoster: 0, extendedAbstract: 0, shortPaper: 0 };
    const rawTitle = String(title || '');
    const rawVenue = String(venue || '');
    const rawVenueFull = String(venue_full || '');
    const rawScholarVenue = String(scholarVenue || '');
    const rawDblpKey = String(dblpKey || '');
    const rawCrossref = String(crossref || '');
    const rawType = String(dblpType || '');

    const haystack = `${rawTitle}\n${rawVenue}\n${rawVenueFull}\n${rawScholarVenue}\n${rawDblpKey}\n${rawCrossref}\n${rawType}`;
    const venueHaystack = `${rawVenue}\n${rawVenueFull}\n${rawDblpKey}\n${rawCrossref}\n${rawType}`;
    // Workshop evidence must come from venue metadata, never the paper title:
    // titles like "Energy@home: ..." or "Lessons from the Dagstuhl Workshop"
    // do not make a main-track paper a workshop paper.
    const workshopHaystack = `${rawVenue}\n${rawVenueFull}\n${rawScholarVenue}\n${rawDblpKey}\n${rawCrossref}\n${rawType}`;

    let resolvedVenue = null;
    let parentVenue = null;

    const atMatch = workshopHaystack.match(/\b([A-Za-z][A-Za-z0-9\-]{1,20})\s*@\s*([A-Za-z][A-Za-z0-9\-]{1,20})\b/);
    if (atMatch) {
      resolvedVenue = atMatch[1];
      parentVenue = atMatch[2];
      addSignal(signals, scores, 'workshop', 2.4, 'at_notation');
    }

    const hasTrackPrefix = stripTrackPrefixes(rawTitle) !== rawTitle;
    if (hasTrackPrefix) {
      addSignal(signals, scores, 'demoPoster', 2.6, 'track_prefix');
    }

    if (EXTENDED_ABSTRACT_RX.test(haystack)) {
      addSignal(signals, scores, 'extendedAbstract', 4.0, 'extended_keyword');
    }

    if (WORKSHOP_RX.test(workshopHaystack)) {
      addSignal(signals, scores, 'workshop', 2.2, 'workshop_keyword');
    }

    const demoPosterInTitle = hasTrackPrefix || DEMO_POSTER_TITLE_RX.test(rawTitle);
    if (demoPosterInTitle) {
      addSignal(signals, scores, 'demoPoster', 2.1, 'title_track_keyword');
    }

    if (DEMO_POSTER_VENUE_RX.test(venueHaystack)) {
      addSignal(signals, scores, 'demoPoster', 2.6, 'venue_track_keyword');
    }

    const seriesMatch = rawDblpKey.match(/^(conf|journals)\/([^/]+)\//i);
    const seriesId = seriesMatch ? seriesMatch[2] : null;

    let crossrefDerivedVenue = null;
    if (rawCrossref) {
      const last = rawCrossref.split('/').pop();
      if (last) {
        let match = last.match(/^(\d{4})([A-Za-z][A-Za-z0-9\-]{1,25})$/);
        if (match) {
          crossrefDerivedVenue = match[2];
        } else {
          match = last.match(/^([A-Za-z][A-Za-z0-9\-]{1,25})(\d{4})$/);
          if (match) crossrefDerivedVenue = match[1];
        }
        if (crossrefDerivedVenue) {
          addSignal(signals, scores, 'workshop', 1.2, 'crossref_track');
        }
      }
    }

    if (!parentVenue && crossrefDerivedVenue && seriesId && seriesId.toLowerCase() !== crossrefDerivedVenue.toLowerCase()) {
      parentVenue = seriesId;
      signals.push('parent_from_series');
    }

    if (!resolvedVenue) {
      if (crossrefDerivedVenue) {
        resolvedVenue = crossrefDerivedVenue;
        signals.push('resolved_from_crossref');
      } else if (seriesId && seriesId.length >= 2) {
        resolvedVenue = seriesId;
        signals.push('resolved_from_series');
      } else if (acronym) {
        resolvedVenue = acronym;
        signals.push('resolved_from_acronym');
      }
    }

    if (typeof pageCount === 'number' && Number.isFinite(pageCount)) {
      if (pageCount < 6) {
        addSignal(signals, scores, 'shortPaper', 1.2, `pages_${pageCount}`);
        if (pageCount <= 3) {
          addSignal(signals, scores, 'demoPoster', 0.75, `very_short_${pageCount}`);
        }
      } else if (pageCount >= 6) {
        scores.demoPoster = Math.max(0, scores.demoPoster - 0.5);
        if (demoPosterInTitle && !DEMO_POSTER_VENUE_RX.test(venueHaystack)) {
          scores.demoPoster = Math.max(0, scores.demoPoster - 1.1);
          signals.push('demo_penalty_long_pages');
        }
      }
    }

    const isExtendedAbstract = scores.extendedAbstract >= 3.0;
    const isDemoPoster = !isExtendedAbstract && scores.demoPoster >= 2.5;
    const isWorkshop = !isExtendedAbstract && scores.workshop >= 2.0;
    const isShortPaper = !isExtendedAbstract && typeof pageCount === 'number' && Number.isFinite(pageCount) && pageCount < 6;

    let reason = null;
    if (isExtendedAbstract) reason = 'Extended Abstract';
    else if (isDemoPoster) reason = 'Demo/Poster';
    else if (isWorkshop) reason = 'Workshop';
    else if (isShortPaper) reason = 'Short-paper';

    return {
      isWorkshop,
      isDemoPoster,
      isExtendedAbstract,
      isShortPaper,
      reason,
      resolvedVenue: resolvedVenue ? String(resolvedVenue) : null,
      parentVenue: parentVenue ? String(parentVenue) : null,
      seriesId,
      signals,
      scores,
    };
  }

  function createPublicationTitleIndex(dblpPublications) {
    const items = Array.isArray(dblpPublications) ? dblpPublications : [];
    const exactTitleMap = new Map();
    const normalizedTitles = [];

    items.forEach((pub, index) => {
      const normalizedTitle = normalizeForMatch(pub?.title || '');
      normalizedTitles[index] = normalizedTitle;
      if (!normalizedTitle) return;
      if (!exactTitleMap.has(normalizedTitle)) exactTitleMap.set(normalizedTitle, []);
      exactTitleMap.get(normalizedTitle).push(index);
    });

    return {
      items,
      exactTitleMap,
      normalizedTitles,
      tokenIndex: buildRareTokenIndex(normalizedTitles, (value) => value, 3),
    };
  }

  // Scholar sometimes truncates long titles with a trailing ellipsis. Detect it
  // so matching can compare the prefix against equally-truncated candidate
  // titles instead of failing the full-string similarity threshold.
  const TRUNCATED_TITLE_RX = /(…|\.\.\.)\s*$/;
  // A short truncated prefix carries too little signal to match safely.
  const MIN_TRUNCATED_PREFIX_LENGTH = 30;

  function scorePublicationCandidate(normalizedScholarTitle, scholarYear, pub, normalizedTitle, config, options = {}) {
    const truncatedPrefix = options.truncatedPrefix === true;
    const comparableTitle = truncatedPrefix
      ? normalizedTitle.slice(0, normalizedScholarTitle.length)
      : normalizedTitle;
    const similarity = hybridSimilarity(normalizedScholarTitle, comparableTitle);
    const pubYear = pub?.year ? parseInt(pub.year, 10) : null;
    const scholarYearNumber = typeof scholarYear === 'number' ? scholarYear : null;
    const yearDiff = (scholarYearNumber !== null && Number.isFinite(pubYear))
      ? Math.abs(scholarYearNumber - pubYear)
      : 0;

    let score = similarity;
    if (truncatedPrefix) {
      // Identical prefixes of two DIFFERENT long papers must stay inside the
      // ambiguity gate (which is skipped at score >= 0.96), so a prefix match
      // can never claim full-title certainty.
      score = Math.min(score, 0.95);
    }
    if (scholarYearNumber !== null && Number.isFinite(pubYear) && yearDiff > config.publicationMaxYearDiff) {
      if (similarity < config.publicationStrongSimilarityThreshold || yearDiff > config.publicationStrongYearDiff) {
        return null;
      }
      score *= 0.92 ** Math.min(6, (yearDiff - config.publicationMaxYearDiff));
    }

    if (score < config.publicationSimilarityThreshold) {
      return null;
    }

    return {
      pub,
      normalizedTitle,
      score,
      rawSimilarity: similarity,
      yearDiff,
      hasPages: !!pub.pages,
      exactTitleMatch: !truncatedPrefix && normalizedTitle === normalizedScholarTitle,
      truncatedPrefixMatch: truncatedPrefix,
    };
  }

  function comparePublicationCandidates(left, right) {
    if (!left) return 1;
    if (!right) return -1;
    if (left.score !== right.score) return right.score - left.score;
    if (left.exactTitleMatch !== right.exactTitleMatch) return left.exactTitleMatch ? -1 : 1;
    if (left.yearDiff !== right.yearDiff) return left.yearDiff - right.yearDiff;
    if (left.hasPages !== right.hasPages) return left.hasPages ? -1 : 1;
    const leftKey = String(left.pub?.dblpKey || '');
    const rightKey = String(right.pub?.dblpKey || '');
    return leftKey.localeCompare(rightKey);
  }

  function summarizePublicationCandidate(candidate) {
    if (!candidate?.pub) return null;
    return {
      dblpKey: candidate.pub.dblpKey || null,
      title: candidate.pub.title || null,
      venue: candidate.pub.venue_full || candidate.pub.venue || null,
      year: candidate.pub.year || null,
      score: typeof candidate.score === 'number' ? candidate.score : null,
      exactTitleMatch: candidate.exactTitleMatch === true,
    };
  }

  function selectBestDblpMatchDetailed({
    scholarTitle,
    scholarYear,
    dblpPublications,
    similarityThreshold,
    maxYearDiff,
    strongSimilarityThreshold,
  }) {
    const config = {
      ...RANKING_CONFIG,
      publicationSimilarityThreshold: Number.isFinite(similarityThreshold) ? similarityThreshold : RANKING_CONFIG.publicationSimilarityThreshold,
      publicationMaxYearDiff: Number.isFinite(maxYearDiff) ? maxYearDiff : RANKING_CONFIG.publicationMaxYearDiff,
      publicationStrongSimilarityThreshold: Number.isFinite(strongSimilarityThreshold) ? strongSimilarityThreshold : RANKING_CONFIG.publicationStrongSimilarityThreshold,
    };

    const rawScholarTitle = String(scholarTitle || '').trim();
    const isTruncatedTitle = TRUNCATED_TITLE_RX.test(rawScholarTitle);
    const effectiveScholarTitle = isTruncatedTitle
      ? rawScholarTitle.replace(TRUNCATED_TITLE_RX, '')
      : scholarTitle;
    const normalizedScholarTitle = normalizeForMatch(effectiveScholarTitle);
    if (!normalizedScholarTitle || !Array.isArray(dblpPublications) || dblpPublications.length === 0) {
      return { status: DECISION_STATUS.MISSING, match: null, reason: 'no_candidates' };
    }
    if (isTruncatedTitle && normalizedScholarTitle.length < MIN_TRUNCATED_PREFIX_LENGTH) {
      return { status: DECISION_STATUS.MISSING, match: null, reason: 'truncated_title_too_short' };
    }

    const index = createPublicationTitleIndex(dblpPublications);
    const exactMatches = isTruncatedTitle ? [] : (index.exactTitleMap.get(normalizedScholarTitle) || []);
    let candidateIndexes = exactMatches.length
      ? new Set(exactMatches)
      : getCandidateIndexesFromTokens(tokenizeNormalizedText(normalizedScholarTitle, 3), index.tokenIndex);

    if (!candidateIndexes || !candidateIndexes.size) {
      candidateIndexes = new Set(index.items.map((_, itemIndex) => itemIndex));
    }

    let best = null;
    let second = null;
    for (const candidateIndex of candidateIndexes) {
      const pub = index.items[candidateIndex];
      const normalizedTitle = index.normalizedTitles[candidateIndex];
      const scored = scorePublicationCandidate(normalizedScholarTitle, scholarYear, pub, normalizedTitle, config, { truncatedPrefix: isTruncatedTitle });
      if (!scored) continue;

      if (!best || comparePublicationCandidates(best, scored) > 0) {
        second = best;
        best = scored;
      } else if (!second || comparePublicationCandidates(second, scored) > 0) {
        second = scored;
      }
    }

    if (!best) {
      return { status: DECISION_STATUS.MISSING, match: null, reason: 'no_match_above_threshold' };
    }

    const gap = second ? best.score - second.score : Number.POSITIVE_INFINITY;
    if (!best.exactTitleMatch && second && best.score < 0.96 && gap < config.publicationAmbiguityGap) {
      return {
        status: DECISION_STATUS.AMBIGUOUS,
        match: null,
        confidence: best.score,
        scoreGap: gap,
        runnerUpScore: second.score,
        reason: 'publication_ambiguous',
        topCandidates: [summarizePublicationCandidate(best), summarizePublicationCandidate(second)].filter(Boolean),
      };
    }

    return {
      status: DECISION_STATUS.MATCHED,
      confidence: best.score,
      rawSimilarity: best.rawSimilarity,
      runnerUpScore: second ? second.score : null,
      scoreGap: gap,
      exactTitleMatch: best.exactTitleMatch,
      truncatedTitleMatch: best.truncatedPrefixMatch === true,
      match: { ...best.pub, matchScore: best.score, matchRawSimilarity: best.rawSimilarity },
      topCandidates: [summarizePublicationCandidate(best), summarizePublicationCandidate(second)].filter(Boolean),
    };
  }

  function selectBestDblpMatch(args) {
    const result = selectBestDblpMatchDetailed(args);
    return result.status === DECISION_STATUS.MATCHED ? result.match : null;
  }

  function scoreDblpProfileCandidate({ scholarName, scholarSamplePubs, candidateName, dblpPublications }) {
    const normalizedScholarName = normalizeProfileName(scholarName);
    const normalizedCandidateName = normalizeProfileName(candidateName);
    const scholarNameScore = hybridSimilarity(normalizedScholarName, normalizedCandidateName);

    if (scholarNameScore < RANKING_CONFIG.profileNameSimilarityThreshold) {
      return {
        status: DECISION_STATUS.MISSING,
        confidence: scholarNameScore,
        score: scholarNameScore,
        overlapCount: 0,
        exactOverlapCount: 0,
        reason: 'profile_name_too_far',
      };
    }

    const publications = Array.isArray(scholarSamplePubs) ? scholarSamplePubs : [];
    let overlapCount = 0;
    let exactOverlapCount = 0;
    let yearAlignedCount = 0;
    let overlapScore = 0;

    for (const pub of publications) {
      const match = selectBestDblpMatchDetailed({
        scholarTitle: pub?.title || '',
        scholarYear: Number.isFinite(pub?.year) ? pub.year : null,
        dblpPublications,
      });
      if (match.status !== DECISION_STATUS.MATCHED || !match.match) continue;
      overlapCount++;
      overlapScore += match.confidence || 0;
      if (match.exactTitleMatch) exactOverlapCount++;
      if (Number.isFinite(pub?.year) && match.match.year && Math.abs(pub.year - parseInt(match.match.year, 10)) <= 1) {
        yearAlignedCount++;
      }
    }

    const score =
      scholarNameScore * 2.4 +
      overlapCount * 1.1 +
      exactOverlapCount * 0.55 +
      yearAlignedCount * 0.25 +
      overlapScore * 0.25;

    const matched = overlapCount >= RANKING_CONFIG.profileMinOverlapCount && score >= RANKING_CONFIG.profileMatchScoreThreshold;
    return {
      status: matched ? DECISION_STATUS.MATCHED : DECISION_STATUS.MISSING,
      confidence: Math.min(1, Math.max(scholarNameScore, overlapCount ? overlapScore / Math.max(1, overlapCount) : 0)),
      score,
      overlapCount,
      exactOverlapCount,
      yearAlignedCount,
      reason: matched ? 'profile_overlap' : 'profile_overlap_too_low',
    };
  }

  function createCoreAliasIndex(coreData) {
    const entries = Array.isArray(coreData) ? coreData : [];
    const exactAcronymMap = new Map();
    const exactAliasMap = new Map();
    const titleLookup = [];
    const canonicalTitles = [];

    const registerAlias = (map, key, index) => {
      const normalizedKey = normalizeVenueCandidate(key);
      if (!normalizedKey) return;
      if (!map.has(normalizedKey)) map.set(normalizedKey, []);
      map.get(normalizedKey).push(index);
    };

    entries.forEach((entry, index) => {
      const title = normalizeSpaces(entry?.title || '');
      const acronym = normalizeSpaces(entry?.acronym || '');
      const canonicalTitle = normalizeVenueCandidate(title);
      const aliases = new Set();

      if (title) aliases.add(title);
      if (acronym) aliases.add(acronym);

      const canonicalVenue = canonicalizeCsrankingsVenueName(title);
      if (canonicalVenue) aliases.add(canonicalVenue);

      for (const alias of expandVenueCandidates(title)) aliases.add(alias);
      if (acronym) aliases.add(acronym.toUpperCase());

      if (acronym) {
        const acronymKey = normalizeKey(acronym);
        if (!exactAcronymMap.has(acronymKey)) exactAcronymMap.set(acronymKey, []);
        exactAcronymMap.get(acronymKey).push(index);
      }

      for (const alias of aliases) {
        registerAlias(exactAliasMap, alias, index);
      }

      titleLookup[index] = title;
      canonicalTitles[index] = canonicalTitle;
    });

    return {
      entries,
      exactAcronymMap,
      exactAliasMap,
      titleLookup,
      canonicalTitles,
      tokenIndex: buildRareTokenIndex(canonicalTitles, (value) => value, 3),
    };
  }

  function disambiguateCoreCandidates(query, indexes, aliasIndex) {
    const normalizedQuery = normalizeVenueCandidate(query);
    let best = null;
    let second = null;
    for (const index of indexes) {
      const candidateTitle = aliasIndex.titleLookup[index] || aliasIndex.entries[index]?.title || '';
      const candidateNormalized = aliasIndex.canonicalTitles[index] || normalizeVenueCandidate(candidateTitle);
      const score = hybridSimilarity(normalizedQuery, candidateNormalized);
      const candidate = { index, score };
      if (!best || candidate.score > best.score) {
        second = best;
        best = candidate;
      } else if (!second || candidate.score > second.score) {
        second = candidate;
      }
    }

    if (!best) return null;
    const gap = second ? best.score - second.score : Number.POSITIVE_INFINITY;
    if (second && best.score < 0.96 && gap < RANKING_CONFIG.coreAmbiguityGap) {
      return { status: DECISION_STATUS.AMBIGUOUS, score: best.score, gap, bestIndex: best.index, secondIndex: second.index };
    }
    return { status: DECISION_STATUS.MATCHED, score: best.score, entry: aliasIndex.entries[best.index] };
  }

  function summarizeCoreEntries(indexes, aliasIndex) {
    const uniqueIndexes = Array.from(new Set(indexes || []));
    return uniqueIndexes.slice(0, 4).map((index) => {
      const entry = aliasIndex.entries[index];
      if (!entry) return null;
      return {
        acronym: entry.acronym || null,
        title: entry.title || null,
        rank: entry.rank || 'N/A',
        rawRankLabel: entry.rawRank || null,
      };
    }).filter(Boolean);
  }

  // Words too generic to count as evidence that a venue title and a CORE entry
  // describe the same conference.
  const GENERIC_VENUE_TOKENS = new Set([
    'conference', 'international', 'national', 'annual', 'symposium', 'proceedings',
    'workshop', 'acm', 'ieee', 'ifip', 'usenix', 'joint', 'european', 'world',
    'meeting', 'congress', 'forum', 'first', 'second', 'third',
  ]);

  // Cross-field acronym collisions (e.g. a marketing "PAM" vs CORE's Passive
  // and Active Measurement) must not resolve with confidence 1.0 just because
  // the acronym string is unique within one CORE snapshot. When the caller
  // supplies a substantial full venue title, require at least minimal title
  // agreement with the CORE entry; otherwise abstain.
  function acronymEntryAgreesWithTitle(entry, fullVenueTitle, acronymCandidate) {
    const normalizedFull = normalizeVenueCandidate(fullVenueTitle);
    if (!normalizedFull || normalizedFull.length < 18) return true;
    const acronymKeyNormalized = normalizeKey(acronymCandidate || entry?.acronym || '');
    if (normalizedFull === acronymKeyNormalized) return true;
    const fullTokens = tokenizeNormalizedText(normalizedFull, 4).filter((token) => !GENERIC_VENUE_TOKENS.has(token));
    if (fullTokens.length < 2) return true;

    const entryText = normalizeVenueCandidate(`${entry?.title || ''} ${entry?.acronym || ''}`);
    const entryTokens = new Set(tokenizeNormalizedText(entryText, 4).filter((token) => !GENERIC_VENUE_TOKENS.has(token)));
    // An entry whose title carries no descriptive tokens (e.g. title equals the
    // acronym) offers nothing to cross-check against — accept the acronym hit.
    if (entryTokens.size < 2) return true;
    const sharedToken = fullTokens.some((token) => entryTokens.has(token));
    if (sharedToken) return true;

    // No shared content token: only a strong whole-string similarity can save
    // the match (Jaro-Winkler's noise floor on long strings sits near ~0.5,
    // so anything lower than 0.62 is indistinguishable from chance).
    return hybridSimilarity(normalizedFull, normalizeVenueCandidate(entry?.title || '')) >= 0.62;
  }

  function resolveCoreVenue({ venueKey, fullVenueTitle, coreData, aliasIndex }) {
    const data = Array.isArray(coreData) ? coreData : [];
    const index = aliasIndex && aliasIndex.entries === data ? aliasIndex : createCoreAliasIndex(data);
    const buildEntryResolution = (entry, fallbackCandidate, confidence, matchType, matchedKeyOverride = null) => {
      const canonicalMatch = canonicalizeCsrankingsVenueName(
        entry.acronym || entry.title || fallbackCandidate || venueKey || fullVenueTitle || ''
      );
      const topVenueFallback = (!entry.rank || entry.rank === 'N/A') && !entry.rawRank && isCsrankingsTopVenue(canonicalMatch);
      const resolvedRank = topVenueFallback ? 'A*' : (entry.rank || 'N/A');
      return {
        status: resolvedRank !== 'N/A' ? DECISION_STATUS.MATCHED : DECISION_STATUS.UNRANKED,
        rank: resolvedRank,
        matchedVenue: entry.title || fallbackCandidate || canonicalMatch || venueKey || fullVenueTitle || null,
        confidence: typeof confidence === 'number' ? confidence : null,
        matchedKey: matchedKeyOverride || entry.acronym || entry.title || canonicalMatch || fallbackCandidate || null,
        rawRankLabel: entry.rawRank || null,
        matchType: topVenueFallback ? 'top_venue_fallback' : matchType,
        reason: topVenueFallback ? 'top_venue_fallback' : (entry.rawRank && entry.rank === 'N/A' ? String(entry.rawRank) : null),
      };
    };
    const rawCandidates = Array.from(new Set([venueKey, fullVenueTitle].filter((value) => !!value && String(value).trim().length > 0)));
    const expandedCandidates = Array.from(new Set(
      rawCandidates.flatMap((candidate) => {
        const variants = [candidate];
        const canonical = canonicalizeCsrankingsVenueName(candidate);
        if (canonical) variants.push(canonical);
        return variants;
      }).filter(Boolean)
    ));
    if (!rawCandidates.length) {
      return { status: DECISION_STATUS.MISSING, rank: 'N/A', reason: 'no_venue_candidate' };
    }

    for (const candidate of expandedCandidates) {
      const acronymKey = normalizeKey(candidate);
      const acronymMatches = index.exactAcronymMap.get(acronymKey) || [];
      if (acronymMatches.length === 1) {
        const entry = index.entries[acronymMatches[0]];
        if (!acronymEntryAgreesWithTitle(entry, fullVenueTitle, candidate)) {
          return {
            status: DECISION_STATUS.AMBIGUOUS,
            rank: 'N/A',
            reason: 'acronym_title_mismatch',
            confidence: null,
            topCandidates: summarizeCoreEntries(acronymMatches, index),
          };
        }
        return buildEntryResolution(entry, candidate, 1, 'acronym_exact', entry.acronym || entry.title || candidate);
      }
      if (acronymMatches.length > 1) {
        const disambiguated = disambiguateCoreCandidates(fullVenueTitle || candidate, acronymMatches, index);
        if (disambiguated?.status === DECISION_STATUS.MATCHED && disambiguated.entry) {
          const entry = disambiguated.entry;
          return buildEntryResolution(entry, candidate, disambiguated.score, 'acronym_disambiguated', entry.acronym || entry.title || candidate);
        }
        return {
          status: DECISION_STATUS.AMBIGUOUS,
          rank: 'N/A',
          reason: 'ambiguous_acronym',
          confidence: disambiguated?.score || null,
          topCandidates: summarizeCoreEntries(acronymMatches, index),
        };
      }
    }

    for (const candidate of expandedCandidates) {
      const normalizedCandidate = normalizeVenueCandidate(candidate);
      const aliasMatches = index.exactAliasMap.get(normalizedCandidate) || [];
      if (aliasMatches.length === 1) {
        const entry = index.entries[aliasMatches[0]];
        return buildEntryResolution(entry, candidate, 1, 'alias_exact', entry.title || candidate);
      }
      if (aliasMatches.length > 1) {
        const disambiguated = disambiguateCoreCandidates(fullVenueTitle || candidate, aliasMatches, index);
        if (disambiguated?.status === DECISION_STATUS.MATCHED && disambiguated.entry) {
          const entry = disambiguated.entry;
          return buildEntryResolution(entry, candidate, disambiguated.score, 'alias_disambiguated', entry.title || candidate);
        }
        return {
          status: DECISION_STATUS.AMBIGUOUS,
          rank: 'N/A',
          reason: 'ambiguous_title_alias',
          confidence: disambiguated?.score || null,
          topCandidates: summarizeCoreEntries(aliasMatches, index),
        };
      }
    }

    const fuzzyQueries = expandedCandidates.map((candidate) => normalizeVenueCandidate(candidate)).filter(Boolean);
    let best = null;
    let second = null;
    for (const normalizedQuery of fuzzyQueries) {
      const candidateIndexes = getCandidateIndexesFromTokens(tokenizeNormalizedText(normalizedQuery, 3), index.tokenIndex) || new Set(index.entries.map((_, itemIndex) => itemIndex));
      for (const candidateIndex of candidateIndexes) {
        const candidateTitle = index.canonicalTitles[candidateIndex];
        if (!candidateTitle || candidateTitle.length < 6 || normalizedQuery.length < 6) continue;
        const score = hybridSimilarity(normalizedQuery, candidateTitle);
        if (score < RANKING_CONFIG.coreFuzzyThreshold) continue;
        const candidate = { index: candidateIndex, score };
        if (!best || candidate.score > best.score) {
          second = best;
          best = candidate;
        } else if (!second || candidate.score > second.score) {
          second = candidate;
        }
      }
    }

    if (!best) {
      return { status: DECISION_STATUS.MISSING, rank: 'N/A', reason: 'no_core_match' };
    }

    const gap = second ? best.score - second.score : Number.POSITIVE_INFINITY;
    if (second && best.score < 0.97 && gap < RANKING_CONFIG.coreAmbiguityGap) {
      return {
        status: DECISION_STATUS.AMBIGUOUS,
        rank: 'N/A',
        reason: 'ambiguous_fuzzy_core',
        confidence: best.score,
        gap,
        topCandidates: summarizeCoreEntries([best.index, second.index], index),
      };
    }

    const entry = index.entries[best.index];
    return buildEntryResolution(entry, venueKey || fullVenueTitle || null, best.score, 'fuzzy', entry.acronym || entry.title || null);
  }

  const CSRANKINGS_TOP_VENUE_BASES = new Set(
    (venueData.topVenueBases || []).map((value) => normalizeKey(stripParenNumberSuffix(value)))
  );
  const CSRANKINGS_VENUE_ALIASES = new Map(Object.entries(venueData.venueAliases || {}));
  const PROCEEDINGS_BY_JOURNAL = venueData.proceedingsByJournal || {};

  function isCsrankingsTopVenue(venue) {
    const base = normalizeKey(stripParenNumberSuffix(venue));
    return !!base && CSRANKINGS_TOP_VENUE_BASES.has(base);
  }

  function canonicalizeCsrankingsVenueName(venue) {
    const raw = normalizeSpaces(String(venue || '')).trim();
    if (!raw) return null;
    const stripped = stripParenNumberSuffix(raw);
    const key = normalizeKey(stripped);
    return CSRANKINGS_VENUE_ALIASES.get(key) || stripped;
  }

  function volumeIssueMatch(expected, volume, number) {
    if (!expected || !volume || !number) return false;
    return String(volume).trim() === String(expected.volume).trim() && String(number).trim() === String(expected.number).trim();
  }

  function resolveCsrankingsVenueOverride({ dblpKey, venue, year, volume, number, dblpType }) {
    const rawVenue = normalizeSpaces(String(venue || '')).trim();
    if (!rawVenue) return null;

    const keyLower = String(dblpKey || '').toLowerCase();
    const isJournalish = keyLower.startsWith('journals/') || String(dblpType || '').toLowerCase() === 'article';
    const canonicalVenue = canonicalizeCsrankingsVenueName(rawVenue) || rawVenue;
    const canonicalKey = normalizeKey(canonicalVenue);
    const publicationYear = typeof year === 'number' && Number.isFinite(year) ? year : (year ? parseInt(String(year), 10) : null);
    const vol = volume ? String(volume).trim() : null;
    const num = number ? String(number).trim() : null;

    if (isJournalish) {
      if (canonicalKey === 'proc. acm program. lang.' || canonicalKey === 'pacmpl') {
        if (num && /^[A-Za-z][A-Za-z0-9\-]{1,12}$/.test(num)) {
          const conference = canonicalizeCsrankingsVenueName(num) || num;
          return { system: 'CORE', canonicalVenue: conference, year: publicationYear ?? null, reason: 'PACMPL_number' };
        }
      }

      if (canonicalKey === 'proc. acm manag. data' && publicationYear && num) {
        const issueNumber = parseInt(num, 10);
        if (!isNaN(issueNumber)) {
          if (publicationYear === 2023 && (issueNumber === 3 || issueNumber === 4)) {
            return { system: 'CORE', canonicalVenue: 'SIGMOD', year: 2024, reason: 'PACMMOD_2023_issue34' };
          }
          if (publicationYear === 2023 && (issueNumber === 1 || issueNumber === 2)) {
            return { system: 'CORE', canonicalVenue: 'SIGMOD', year: 2023, reason: 'PACMMOD_2023_issue12' };
          }
          if (issueNumber === 2) {
            return { system: 'CORE', canonicalVenue: 'PODS', year: publicationYear, reason: 'PACMMOD_issue2' };
          }
          return { system: 'CORE', canonicalVenue: 'SIGMOD', year: publicationYear, reason: 'PACMMOD_default' };
        }
      }

      if (canonicalKey === 'proc. vldb endow.' || canonicalKey === 'pvldb') {
        return { system: 'CORE', canonicalVenue: 'VLDB', year: publicationYear ?? null, reason: 'PVLDB' };
      }

      if (canonicalKey === 'proc. acm softw. eng.') {
        return { system: 'CORE', canonicalVenue: 'FSE', year: publicationYear ?? null, reason: 'PSE' };
      }

      if (canonicalKey === 'proc. acm meas. anal. comput. syst.' || canonicalKey === 'pomacs') {
        return { system: 'CORE', canonicalVenue: 'SIGMETRICS', year: publicationYear ?? null, reason: 'POMACS' };
      }

      if (canonicalKey === 'proc. acm interact. mob. wearable ubiquitous technol.') {
        return { system: 'CORE', canonicalVenue: 'UbiComp', year: publicationYear ?? null, reason: 'IMWUT' };
      }

      if (canonicalKey === 'acm trans. graph.' && publicationYear && vol && num) {
        if (volumeIssueMatch(PROCEEDINGS_BY_JOURNAL.togSiggraph?.[publicationYear], vol, num)) {
          return { system: 'CORE', canonicalVenue: 'SIGGRAPH', year: publicationYear, reason: 'TOG_SIGGRAPH' };
        }
        if (volumeIssueMatch(PROCEEDINGS_BY_JOURNAL.togSiggraphAsia?.[publicationYear], vol, num)) {
          return { system: 'CORE', canonicalVenue: 'SIGGRAPH Asia', year: publicationYear, reason: 'TOG_SIGGRAPH_ASIA' };
        }
      }

      if (canonicalKey === 'comput. graph. forum' && publicationYear && vol && num) {
        if (volumeIssueMatch(PROCEEDINGS_BY_JOURNAL.cgfEurographics?.[publicationYear], vol, num)) {
          return { system: 'CORE', canonicalVenue: 'EUROGRAPHICS', year: publicationYear, reason: 'CGF_EG' };
        }
      }

      if (canonicalKey === 'ieee trans. vis. comput. graph.' && publicationYear && vol && num) {
        if (volumeIssueMatch(PROCEEDINGS_BY_JOURNAL.tvcgVis?.[publicationYear], vol, num)) {
          return { system: 'CORE', canonicalVenue: 'VIS', year: publicationYear, reason: 'TVCG_VIS' };
        }
        if (volumeIssueMatch(PROCEEDINGS_BY_JOURNAL.tvcgVr?.[publicationYear], vol, num)) {
          return { system: 'CORE', canonicalVenue: 'VR', year: publicationYear, reason: 'TVCG_VR' };
        }
      }

      if ((canonicalKey === 'bioinformatics' || canonicalKey === 'bioinform.') && publicationYear && vol && num) {
        if (volumeIssueMatch(PROCEEDINGS_BY_JOURNAL.ismbBioinformatics?.[publicationYear], vol, num)) {
          return { system: 'CORE', canonicalVenue: 'ISMB', year: publicationYear, reason: 'ISMB_BIOINFORMATICS' };
        }
      }
    }

    if (isCsrankingsTopVenue(canonicalVenue)) {
      return { system: null, canonicalVenue, year: publicationYear ?? null, reason: 'TOP_VENUE' };
    }

    return null;
  }

  return {
    DECISION_VERSION,
    DECISION_STATUS,
    RANKING_CONFIG,
    normalizeForMatch,
    normalizeVenueCandidate,
    normalizeProfileName,
    buildJournalLookupCacheKey,
    expandVenueCandidates,
    tokenizeNormalizedText,
    jaroWinkler,
    hybridSimilarity,
    getPageCountFromPagesString,
    classifyVenueTrack,
    createPublicationTitleIndex,
    selectBestDblpMatchDetailed,
    selectBestDblpMatch,
    scoreDblpProfileCandidate,
    createCoreAliasIndex,
    resolveCoreVenue,
    isCsrankingsTopVenue,
    canonicalizeCsrankingsVenueName,
    resolveCsrankingsVenueOverride,
  };
});
