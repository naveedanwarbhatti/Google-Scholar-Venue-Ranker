import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

const RECORD_TAGS = new Set(['article', 'inproceedings', 'proceedings']);
const GENERIC_ALIAS_KEYS = new Set([
  'conference',
  'journal',
  'workshop',
  'symposium',
  'proceedings',
  'international conference',
  'international journal',
]);
const VENUE_ABBREVIATIONS = {
  'gener.': 'generation',
  gener: 'generation',
  'meas.': 'measurement',
  meas: 'measurement',
  'anal.': 'analysis',
  anal: 'analysis',
  'comput.': 'computer',
  comput: 'computer',
  'comp.': 'computer',
  comp: 'computer',
  'surv.': 'surveys',
  surv: 'surveys',
  'syst.': 'systems',
  syst: 'systems',
  'adv.': 'advances',
  adv: 'advances',
  'appl.': 'applications',
  appl: 'applications',
  'commun.': 'communications',
  commun: 'communications',
  'inf.': 'information',
  inf: 'information',
  'int.': 'international',
  int: 'international',
  'j.': 'journal',
  j: 'journal',
  'sci.': 'science',
  sci: 'science',
  'softw.': 'software',
  softw: 'software',
  'technol.': 'technology',
  technol: 'technology',
  'trans.': 'transactions',
  trans: 'transactions',
};
const EDITION_ORDINAL_WORDS = [
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
  'eighteenth', 'nineteenth', 'twentieth', 'twenty first', 'twenty second', 'twenty third',
  'twenty fourth', 'twenty fifth', 'twenty sixth', 'twenty seventh', 'twenty eighth',
  'twenty ninth', 'thirtieth', 'thirty first', 'thirty second', 'thirty third', 'thirty fourth',
  'thirty fifth', 'thirty sixth', 'thirty seventh', 'thirty eighth', 'thirty ninth', 'fortieth',
];

function decodeXmlText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAttr(block, name) {
  const match = String(block || '').match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
  return match ? decodeXmlText(match[1]) : '';
}

function extractTagValues(block, tagName) {
  const values = [];
  const rx = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'gi');
  let match;
  while ((match = rx.exec(block))) {
    const value = decodeXmlText(match[1]);
    if (value) values.push(value);
  }
  return values;
}

function normalizeSpaces(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripProceedingsPrefix(value) {
  return normalizeSpaces(String(value || '')
    .replace(/^\s*(?:(?:companion|adjunct)\s+)?(proceedings\s+of\s+the|proceedings\s+of|proc\.?\s+of\s+the|proc\.?\s+of|proceedings|proc\.?)\s+/i, ''));
}

function stripCitationSuffixes(value) {
  let text = String(value || '');
  text = text.replace(/\s*(?:\.\.\.|…)\s*$/g, ' ');
  text = text.replace(/\b(19|20)\d{2}\b/g, ' ');
  text = text.replace(/\b(19|20)\d{2}\b\s*[,;:]?\s*$/g, ' ');
  text = text.replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ');
  text = text.replace(/\b\d{1,4}\s*\(\s*\d{1,4}\b[^)]*$/g, ' ');
  text = text.replace(/\b\d{1,4}\s*\(\s*\d{1,4}\s*\)\s*[,;:]?\s*\d{1,6}\s*[-\u2010-\u2015]\s*\d{1,6}\s*$/g, ' ');
  text = text.replace(/\b\d{1,4}\s*[,;:]\s*\d{1,6}\s*[-\u2010-\u2015]\s*\d{1,6}\s*$/g, ' ');
  text = text.replace(/\b\d{1,4}\s+\d{1,6}\s*[-\u2010-\u2015]\s*\d{1,6}\s*$/g, ' ');
  text = text.replace(/\b(pp\.?|pages?)\s*\d{1,6}\s*[-\u2010-\u2015]\s*\d{1,6}\s*$/g, ' ');
  text = text.replace(/\b(volume|vol|issue|no|number)\s*\d+\b/g, ' ');
  text = text.replace(/\b\d{1,4}\s+\d{1,6}\s+\d{1,6}\s*$/g, ' ');
  text = text.replace(/\b\d{1,4}\s+\d{1,6}\s*$/g, ' ');
  text = text.replace(/\b\d{1,4}\b\s*$/g, ' ');
  return normalizeSpaces(text);
}

function acronymVariantsFromCompactAlias(value) {
  const compact = normalizeVenueAlias(value).replace(/\s+/g, '');
  if (!/^[a-z0-9]{4,24}$/.test(compact)) return [];
  const variants = new Set([compact]);
  for (const prefix of ['euro', 'asia', 'acm', 'ieee', 'ifip', 'usenix']) {
    if (compact.startsWith(prefix) && compact.length - prefix.length >= 3) {
      variants.add(compact.slice(prefix.length));
    }
  }
  return Array.from(variants);
}

function expandVenueAbbreviations(value) {
  let text = String(value || '');
  for (const [abbr, expansion] of Object.entries(VENUE_ABBREVIATIONS)) {
    const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), expansion);
  }
  return text;
}

export function normalizeVenueAlias(value) {
  let normalized = String(value || '').toLowerCase();
  normalized = normalized.replace(/&/g, ' and ');
  normalized = normalized.replace(/@/g, ' ');
  normalized = stripCitationSuffixes(normalized);
  normalized = expandVenueAbbreviations(normalized);
  normalized = normalized.replace(/[\.,\/#!$%\^;\*:{}=\_`~?"“”'’()\[\]+]/g, ' ');
  normalized = normalized.replace(/[-\u2010-\u2015]/g, ' ');
  normalized = stripCitationSuffixes(normalized);
  normalized = normalizeSpaces(normalized);
  normalized = stripProceedingsPrefix(normalized);
  return normalizeSpaces(normalized);
}

function normalizeVenueAliasStemmed(value) {
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

function slugify(value) {
  const normalized = normalizeVenueAlias(value);
  return normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56) || 'venue';
}

function addAlias(set, value) {
  const trimmed = normalizeSpaces(value);
  if (!trimmed) return;
  set.add(trimmed);
  const stripped = stripProceedingsPrefix(trimmed);
  if (stripped && stripped !== trimmed) set.add(stripped);
  const citationStripped = stripCitationSuffixes(stripped);
  if (citationStripped && citationStripped !== stripped) set.add(citationStripped);
  const withoutInternalArticle = citationStripped.replace(/\b(on|of|for|in|at)\s+the\s+/gi, '$1 ').trim();
  if (withoutInternalArticle && withoutInternalArticle !== citationStripped) set.add(withoutInternalArticle);
  const withoutLeadingArticle = stripped.replace(/^\s*the\s+/i, '').trim();
  if (withoutLeadingArticle && withoutLeadingArticle !== stripped) set.add(withoutLeadingArticle);
  const atMatch = trimmed.match(/\b([A-Za-z][A-Za-z0-9\-]{1,24})\s*@\s*([A-Za-z][A-Za-z0-9\-]{1,24})\b/);
  if (atMatch) {
    set.add(atMatch[1]);
    set.add(`${atMatch[1]} ${atMatch[2]}`);
  }
}

function extractVenueAliasesFromProceedingsTitle(value) {
  const text = normalizeSpaces(value);
  if (!text) return [];

  const aliases = new Set();
  const firstSegment = normalizeSpaces(text
    .replace(/\s+[-–—]\s+.*$/u, ' ')
    .split(/\s*,\s*/)[0]);
  const proceedingsMatch = firstSegment.match(/\b(?:proceedings|proc\.?)\b/i);
  if (proceedingsMatch) {
    const proceedingsSegment = firstSegment.slice(proceedingsMatch.index);
    const stripped = stripProceedingsPrefix(proceedingsSegment);
    aliases.add(stripped);
    aliases.add(stripped.replace(/^\s*the\s+/i, '').trim());

    const withoutOrdinal = stripped
      .replace(new RegExp(`^\\s*(?:the\\s+)?(?:(?:\\d+(?:st|nd|rd|th)|${EDITION_ORDINAL_WORDS.join('|')})\\s+)?`, 'i'), '')
      .trim();
    if (withoutOrdinal && withoutOrdinal !== stripped) {
      aliases.add(withoutOrdinal);
    }
  }

  for (const segment of text.split(/\s*,\s*/).map(normalizeSpaces)) {
    if (!segment || /\b(proceedings|proc\.)\b/i.test(segment)) continue;
    if (!/\b(conference|workshop|symposium|journal)\b/i.test(segment)) continue;
    const cleanedSegment = stripCitationSuffixes(segment)
      .replace(/^\s*(?:the\s+)?(?:(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+)\s+/i, '')
      .trim();
    if (cleanedSegment) aliases.add(cleanedSegment);
  }

  return Array.from(aliases).filter((alias) => {
    if (!alias) return false;
    const normalized = normalizeVenueAlias(alias);
    if (!normalized || GENERIC_ALIAS_KEYS.has(normalized)) return false;
    return /\b(conference|workshop|symposium|journal|web)\b/i.test(alias)
      || normalized.split(/\s+/).filter(Boolean).length >= 4;
  });
}

function isWorkshopVenue(value) {
  const text = String(value || '');
  return /(\bworkshops?\b|\bworkshop\s+on\b|\bco\s*-?located\b|\bcolocated\b|\bsatellite\b|\bcompanion\b|\badjunct\b|@)/i.test(text);
}

function scoreCanonicalTitle(value) {
  const text = String(value || '');
  let score = Math.min(text.length, 120);
  if (/\b(proceedings|proc\.)\b/i.test(text)) score -= 30;
  if (/^[A-Z0-9][A-Z0-9&+\- ]{1,14}$/.test(text)) score -= 15;
  if (/\b(conference|journal|symposium|workshop|transactions|proceedings)\b/i.test(text)) score += 12;
  return score;
}

function createEntry(id, type, series) {
  return {
    id,
    type,
    series,
    title: '',
    titleScore: Number.NEGATIVE_INFINITY,
    shortName: '',
    aliases: new Set(),
    flags: new Set(),
    yearStart: null,
    yearEnd: null,
    count: 0,
  };
}

function updateEntry(entry, { title, year, aliases, flags }) {
  const titleScore = scoreCanonicalTitle(title);
  if (title && titleScore > entry.titleScore) {
    entry.title = title;
    entry.titleScore = titleScore;
  }
  if (!entry.shortName && title && /^[A-Za-z0-9&+\-]{2,20}$/.test(title)) {
    entry.shortName = title;
  }
  for (const alias of aliases || []) addAlias(entry.aliases, alias);
  for (const flag of flags || []) entry.flags.add(flag);
  if (Number.isFinite(year)) {
    entry.yearStart = entry.yearStart == null ? year : Math.min(entry.yearStart, year);
    entry.yearEnd = entry.yearEnd == null ? year : Math.max(entry.yearEnd, year);
  }
  entry.count += 1;
}

function recordToVenueUpdates(block) {
  const key = extractAttr(block, 'key');
  const tag = String(block || '').match(/^<\s*(article|inproceedings|proceedings)\b/i)?.[1]?.toLowerCase() || '';
  const keyMatch = key.match(/^(journals|conf)\/([^/]+)/i);
  if (!keyMatch) return [];

  const prefix = keyMatch[1].toLowerCase();
  const series = keyMatch[2].toLowerCase();
  const year = parseInt(extractTagValues(block, 'year')[0] || '', 10);
  const updates = [];
  const isJournal = prefix === 'journals';
  const venueValues = isJournal
    ? extractTagValues(block, 'journal')
    : [...extractTagValues(block, 'booktitle'), ...extractTagValues(block, 'journal')];

  if (!venueValues.length && !isJournal) {
    venueValues.push(...extractTagValues(block, 'title'));
  }

  const proceedingsTitleAliases = tag === 'proceedings'
    ? extractTagValues(block, 'title').flatMap(extractVenueAliasesFromProceedingsTitle)
    : [];

  for (const venue of venueValues) {
    const cleaned = normalizeSpaces(venue);
    if (!cleaned) continue;
    const flags = [];
    let type = isJournal ? 'journal' : 'conference';
    let id = `${prefix}/${series}`;
    if (!isJournal && isWorkshopVenue(cleaned)) {
      type = 'workshop';
      flags.push('workshop');
      id = `${prefix}/${series}#${slugify(cleaned)}`;
    }
    updates.push({
      id,
      type,
      series,
      title: cleaned,
      year,
      aliases: [cleaned, ...proceedingsTitleAliases],
      flags,
    });
  }

  return updates;
}

async function streamDblpRecords(xmlPath, onRecord) {
  const input = fs.createReadStream(xmlPath);
  const stream = /\.gz$/i.test(xmlPath) ? input.pipe(zlib.createGunzip()) : input;
  let buffer = '';

  for await (const chunk of stream) {
    buffer += chunk.toString('utf8');
    while (true) {
      const startMatch = buffer.match(/<(article|inproceedings|proceedings)\b[^>]*>/i);
      if (!startMatch) {
        if (buffer.length > 1024) buffer = buffer.slice(-1024);
        break;
      }
      const tag = startMatch[1].toLowerCase();
      if (!RECORD_TAGS.has(tag)) {
        buffer = buffer.slice(startMatch.index + startMatch[0].length);
        continue;
      }
      if (startMatch.index > 0) {
        buffer = buffer.slice(startMatch.index);
      }
      const endTag = `</${tag}>`;
      const endIndex = buffer.toLowerCase().indexOf(endTag, startMatch[0].length);
      if (endIndex < 0) break;
      const block = buffer.slice(0, endIndex + endTag.length);
      await onRecord(block);
      buffer = buffer.slice(endIndex + endTag.length);
    }
  }
}

function finalizeCatalog(entriesById, source) {
  const entries = Array.from(entriesById.values())
    .filter((entry) => entry.title && entry.aliases.size)
    .sort((a, b) => a.id.localeCompare(b.id));
  const aliases = {};
  const tuples = entries.map((entry, index) => {
    const aliasList = Array.from(entry.aliases)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    const normalizedAliases = Array.from(new Set([
      normalizeVenueAlias(entry.title),
      normalizeVenueAliasStemmed(entry.title),
      normalizeVenueAlias(entry.shortName),
      normalizeVenueAliasStemmed(entry.shortName),
      ...aliasList.map(normalizeVenueAlias),
      ...aliasList.map(normalizeVenueAliasStemmed),
      ...[entry.title, entry.shortName, ...aliasList].flatMap(acronymVariantsFromCompactAlias),
    ].filter(Boolean))).sort((a, b) => a.localeCompare(b));
    for (const alias of aliasList) {
      for (const key of new Set([normalizeVenueAlias(alias), normalizeVenueAliasStemmed(alias), ...acronymVariantsFromCompactAlias(alias)])) {
        if (!key || key.length < 2 || GENERIC_ALIAS_KEYS.has(key)) continue;
        (aliases[key] ||= []).push(index);
      }
    }
    return [
      entry.id,
      entry.type,
      entry.title,
      entry.shortName || '',
      aliasList,
      Array.from(entry.flags).sort(),
      entry.yearStart,
      entry.yearEnd,
      entry.count,
      normalizedAliases,
    ];
  });

  for (const [key, indexes] of Object.entries(aliases)) {
    aliases[key] = Array.from(new Set(indexes)).sort((a, b) => a - b);
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    source,
    entries: tuples,
    aliases,
  };
}

export async function generateDblpVenueCatalog({ xmlPath, dtdPath = null, source = {} } = {}) {
  if (!xmlPath) {
    throw new Error('generateDblpVenueCatalog requires xmlPath');
  }
  await fsp.access(xmlPath);
  if (dtdPath) await fsp.access(dtdPath);

  const entriesById = new Map();
  await streamDblpRecords(xmlPath, async (block) => {
    for (const update of recordToVenueUpdates(block)) {
      let entry = entriesById.get(update.id);
      if (!entry) {
        entry = createEntry(update.id, update.type, update.series);
        entriesById.set(update.id, entry);
      }
      updateEntry(entry, update);
    }
  });

  return finalizeCatalog(entriesById, {
    kind: 'dblp-xml',
    xmlPath: path.basename(xmlPath),
    dtdPath: dtdPath ? path.basename(dtdPath) : null,
    ...source,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const xmlArgIndex = process.argv.indexOf('--xml');
  const dtdArgIndex = process.argv.indexOf('--dtd');
  const outArgIndex = process.argv.indexOf('--out');
  const xmlPath = xmlArgIndex >= 0 ? process.argv[xmlArgIndex + 1] : process.env.DBLP_XML_PATH;
  const dtdPath = dtdArgIndex >= 0 ? process.argv[dtdArgIndex + 1] : process.env.DBLP_DTD_PATH;
  const outPath = outArgIndex >= 0 ? process.argv[outArgIndex + 1] : null;
  generateDblpVenueCatalog({ xmlPath, dtdPath }).then(async (catalog) => {
    const json = JSON.stringify(catalog);
    if (outPath) {
      await fsp.writeFile(outPath, json);
      console.log(`Wrote ${outPath} (${catalog.entries.length} venues)`);
    } else {
      process.stdout.write(json);
    }
  });
}
