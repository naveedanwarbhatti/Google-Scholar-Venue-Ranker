"use strict";
// scholar-ranker/content.ts
class ScanSessionCancelledError extends Error {
    constructor(message = 'Scan session was superseded by a newer run.') {
        super(message);
        this.name = 'ScanSessionCancelledError';
    }
}

async function gsvrFetch(input, init) {
    // All remaining fetches target bundled extension resources (CORE JSON,
    // SJR CSV); behave like a plain fetch, dropping our custom init keys.
    const fetchInit = init ? { ...init } : undefined;
    if (fetchInit) {
        delete fetchInit.timeoutMs;
        delete fetchInit.requestClass;
        delete fetchInit.waitBudgetMs;
        delete fetchInit.allowDefer;
        delete fetchInit.dedupeKey;
    }
    return globalThis.fetch(input, fetchInit);
}
function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
function createEmptyCoreRankCounts() {
    return { 'A*': 0, 'A': 0, 'B': 0, 'C': 0, 'N/A': 0 };
}
function createEmptySjrRankCounts() {
    return { 'Q1': 0, 'Q2': 0, 'Q3': 0, 'Q4': 0, 'N/A': 0 };
}
/** array → map */
function packRanks(arr) {
    const obj = {};
    for (const { url, paperTitle, publicationYear, authorCount, authors, authorship, rank, system, reason, matchConfidence, matchedVenue, venueMatchConfidence, dblpVenue, sourceYear, sourceYearFallback, decisionVersion, decisionStatus, confidence, matchedKey, matchedSourceId, dblpKey, decisionEvidence, topCandidates } of arr) {
        obj[url] = {
            paperTitle: paperTitle ?? null,
            publicationYear: (typeof publicationYear === 'number' ? publicationYear : null),
            authorCount: (typeof authorCount === 'number' ? authorCount : null),
            authors: normalizeDblpAuthorsForPublication(authors),
            authorship: normalizePublicationAuthorship(authorship, authorCount),
            rank,
            system,
            reason: reason ?? null,
            matchConfidence: (typeof matchConfidence === 'number' ? matchConfidence : null),
            matchedVenue: matchedVenue ?? null,
            venueMatchConfidence: (typeof venueMatchConfidence === 'number' ? venueMatchConfidence : null),
            dblpVenue: dblpVenue ?? null,
            sourceYear: (typeof sourceYear === 'number' ? sourceYear : null),
            sourceYearFallback: sourceYearFallback === true,
            decisionVersion: (typeof decisionVersion === 'number' ? decisionVersion : null),
            decisionStatus: decisionStatus ?? null,
            confidence: (typeof confidence === 'number' ? confidence : null),
            matchedKey: matchedKey ?? null,
            matchedSourceId: matchedSourceId ?? null,
            dblpKey: dblpKey ?? null,
            decisionEvidence: Array.isArray(decisionEvidence) ? decisionEvidence.slice(0, 12) : null,
            topCandidates: Array.isArray(topCandidates) ? topCandidates.slice(0, 6) : null
        };
    }
    return obj;
}
/** map → array */
function unpackRanks(map) {
    return Object.entries(map).map(([url, entry]) => ({
        url,
        paperTitle: entry.paperTitle ?? "",
        publicationYear: (typeof entry.publicationYear === 'number' ? entry.publicationYear : null),
        authorCount: (typeof entry.authorCount === 'number' ? entry.authorCount : null),
        authors: normalizeDblpAuthorsForPublication(entry.authors),
        authorship: normalizePublicationAuthorship(entry.authorship, entry.authorCount),
        rank: entry.rank,
        system: entry.system ?? 'UNKNOWN',
        reason: entry.reason ?? null,
        matchConfidence: (typeof entry.matchConfidence === 'number' ? entry.matchConfidence : null),
        matchedVenue: entry.matchedVenue ?? null,
        venueMatchConfidence: (typeof entry.venueMatchConfidence === 'number' ? entry.venueMatchConfidence : null),
        dblpVenue: entry.dblpVenue ?? null,
        sourceYear: (typeof entry.sourceYear === 'number' ? entry.sourceYear : null),
        sourceYearFallback: entry.sourceYearFallback === true,
        decisionVersion: (typeof entry.decisionVersion === 'number' ? entry.decisionVersion : null),
        decisionStatus: entry.decisionStatus ?? null,
        confidence: (typeof entry.confidence === 'number' ? entry.confidence : null),
        matchedKey: entry.matchedKey ?? null,
        matchedSourceId: entry.matchedSourceId ?? null,
        dblpKey: entry.dblpKey ?? null,
        decisionEvidence: Array.isArray(entry.decisionEvidence) ? entry.decisionEvidence : null,
        topCandidates: Array.isArray(entry.topCandidates) ? entry.topCandidates : null,
        titleText: String(entry.paperTitle || '').trim().toLowerCase()
    }));
}
const SCORE_CONFIG_API = (typeof window !== 'undefined' && window.GSVRScoreConfig) ? window.GSVRScoreConfig : null;
const SCORE_MODEL_API = (typeof window !== 'undefined' && window.GSVRScoreModel) ? window.GSVRScoreModel : null;
const SCORE_SENSITIVITY_API = (typeof window !== 'undefined' && window.GSVRScoreSensitivity) ? window.GSVRScoreSensitivity : null;
const REPORT_SCHEMA_API = (typeof window !== 'undefined' && window.GSVRReportSchema) ? window.GSVRReportSchema : null;
const TIMELINE_STATS_API = (typeof window !== 'undefined' && window.GSVRTimelineStats) ? window.GSVRTimelineStats : null;
const AUTHORSHIP_API = (typeof window !== 'undefined' && window.GSVRAuthorship) ? window.GSVRAuthorship : null;
const SCORE_MODEL_VERSION = SCORE_CONFIG_API?.SCORE_MODEL_VERSION || 'gsvr-fractional-venue-v1';
const DEFAULT_SCORE_CONFIG = SCORE_CONFIG_API?.DEFAULT_SCORE_CONFIG || null;
const VALID_RANKS = ["A*", "A", "B", "C"];
const VENUE_PROFILE_INDEX_WEIGHTS = Object.freeze({
    "A*": DEFAULT_SCORE_CONFIG?.venueValues?.CORE?.["A*"] ?? 1,
    "A": DEFAULT_SCORE_CONFIG?.venueValues?.CORE?.A ?? 0.75,
    "B": DEFAULT_SCORE_CONFIG?.venueValues?.CORE?.B ?? 0.5,
    "C": DEFAULT_SCORE_CONFIG?.venueValues?.CORE?.C ?? 0.25,
    "Q1": DEFAULT_SCORE_CONFIG?.venueValues?.SJR?.Q1 ?? 0.75,
    "Q2": DEFAULT_SCORE_CONFIG?.venueValues?.SJR?.Q2 ?? 0.5,
    "Q3": DEFAULT_SCORE_CONFIG?.venueValues?.SJR?.Q3 ?? 0.25,
    "Q4": DEFAULT_SCORE_CONFIG?.venueValues?.SJR?.Q4 ?? 0.1
});
const SJR_QUARTILES = ["Q1", "Q2", "Q3", "Q4"];
const IGNORE_KEYWORDS = [
    "workshop", "transactions", "poster", "demo", "abstract",
    "extended abstract", "doctoral consortium", "doctoral symposium", "adjunct", "technical report",
    "tech report", "industry track", "tutorial notes", "working notes"
];
const ARXIV_PLAIN_KEYWORDS = [
    " arxiv ",
    " corr ",
    " computing research repository ",
    " arxiv preprint ",
    " arxiv e print ",
    " arxiv e prints "
];
const ARXIV_NORMALIZED_VALUES = new Set([
    "arxiv",
    "arxiv preprint",
    "arxiv e print",
    "arxiv e prints",
    "computing research repository",
    "corr"
]);

// Workshops should not inherit the parent conference rank unless explicitly enabled.
const INHERIT_PARENT_CONFERENCE_RANK_FOR_WORKSHOPS = false;
const STATUS_ELEMENT_ID = 'scholar-ranker-status-progress';
const SUMMARY_PANEL_ID = 'scholar-ranker-summary';
const FACULTY_SCORE_PANEL_ID = 'gsr-faculty-score-panel';
const SCORE_DETAILS_OVERLAY_ID = 'gsr-score-details-overlay';
const COMPLETENESS_OVERLAY_ID = 'gsr-completeness-overlay';
const BADGE_POPOVER_ID = 'gsr-badge-popover';
const DETAIL_DRAWER_ID = 'gsr-detail-drawer';
const REVIEW_INBOX_OVERLAY_ID = 'gsr-review-inbox-overlay';
const REPORT_PACKET_OVERLAY_ID = 'gsr-report-packet-overlay';
const EXPORT_OVERLAY_ID = 'gsr-export-overlay';
const COMPARE_OVERLAY_ID = 'gsr-compare-overlay';
const MANUAL_DBLP_OVERLAY_ID = 'gsr-manual-dblp-overlay';
const CHANGELOG_NOTES = Object.freeze([
    'Precision-first DBLP matching and cached decision metadata.',
    'Explain drawer, review inbox, export menu, snapshots, and compare mode.',
    'Venue Explorer, insights view, and in-product data freshness reporting.'
]);
const REPORT_FORM_URL = 'https://forms.office.com/r/PbSzWaQmpJ';
// "Null" state for Scholar entries that cannot be verified against the matched DBLP profile.
const DBLP_ENTRY_MISSING_LABEL = 'DBLP Entry Missing';
const DBLP_ENTRY_MISSING_TOOLTIP = 'This paper is not indexed in the matched DBLP profile.';
const RANKING_UTILS = (typeof window !== 'undefined' && window.GSVRUtils) ? window.GSVRUtils : null;
const RANKING_CONFIG = RANKING_UTILS?.RANKING_CONFIG ?? {
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
    coreFuzzyThreshold: 0.92,
    coreAmbiguityGap: 0.02,
    sjrFuzzyThreshold: 0.92,
    sjrAmbiguityGap: 0.015
};
const DECISION_VERSION = RANKING_UTILS?.DECISION_VERSION ?? 2;
const DECISION_STATUS = RANKING_UTILS?.DECISION_STATUS ?? {
    MATCHED: 'matched',
    UNRANKED: 'unranked',
    AMBIGUOUS: 'ambiguous',
    MISSING: 'missing'
};
const GSVR_TIMING_ENABLED = false;
function gsvrNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}
// End-to-end measures relative to navigation start, each logged at most once
// per page load: first ranks on screen, and (scan loads only) the moment the
// entire profile is ranked. Pure cache restores log just the first.
const gsvrE2eMilestonesLogged = new Set();
function logE2eMilestoneOnce(milestone) {
    if (gsvrE2eMilestonesLogged.has(milestone))
        return;
    gsvrE2eMilestonesLogged.add(milestone);
    console.info(`GSVR: ${milestone} ${Math.round(gsvrNow())}ms after navigation`);
}
function gsvrTimingStart(label) {
    return { label, startedAt: gsvrNow() };
}
function gsvrTimingEnd(timer, extra = '') {
    if (!GSVR_TIMING_ENABLED || !timer)
        return 0;
    const elapsedMs = Math.round(gsvrNow() - timer.startedAt);
    const suffix = extra ? ` ${extra}` : '';
    console.info(`GSR timing: ${timer.label} ${elapsedMs}ms${suffix}`);
    return elapsedMs;
}
// Cache schema retained for v2.0.3 (ranking decision pipeline metadata).
const CACHE_VERSION = 26;
const CACHE_PREFIX = `scholarRanker_profile_v${CACHE_VERSION}_`;
const DBLP_PID_CACHE_KEY_PREFIX = 'scholarRanker_dblpPid_v1_';
const MANUAL_DBLP_PID_KEY_PREFIX = 'scholarRanker_manualDblpPid_v1_';
const BUNDLED_SJR_DATA_VERSION = 3;
const CACHE_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
// Automatic profile matches are re-verified after this TTL so a wrong homonym
// match cannot persist forever. Manual overrides never expire.
const DBLP_CACHE_DURATION_MS = 1000 * 60 * 60 * 24 * 45; // 45 days

// --- Strict DBLP-only UI labels ---
const DBLP_MISSING_BADGE_LABEL = 'DBLP Entry Missing';
const DBLP_MISSING_BADGE_TOOLTIP = 'This paper is not indexed in the matched DBLP profile.';
const SETTINGS_API = (typeof window !== 'undefined' && window.GSVRSettings) ? window.GSVRSettings : null;
const FEATURE_STORAGE_KEYS = SETTINGS_API?.FEATURE_STORAGE_KEYS ?? {
    reportDraft: 'gsvr_report_draft_v1',
    enabledRankingPacks: 'gsvr_enabled_ranking_packs_v1',
    dataFreshnessState: 'gsvr_data_freshness_state_v1',
    profileSnapshots: 'gsvr_profile_snapshots_v1',
    savedCompareSet: 'gsvr_saved_compare_set_v1'
};
const DEFAULT_RANKING_PACKS = SETTINGS_API?.DEFAULT_RANKING_PACKS ?? ['core', 'sjr'];
const DEFAULT_SETTINGS = SETTINGS_API?.DEFAULT_SETTINGS ?? {
    autoRun: true,
    compactMode: false,
    showUnranked: true,
    defaultHighlightMode: 'none',
    showDebugDetails: true,
    showAuthorshipHighlights: false
};
const coreDataCache = {};
let isMainProcessing = false;
let activeCachedPublicationRanks = null;
let publicationTableObserver = null;
let rankMapForObserver = null; // Maps URL to rank & system
let currentSettings = { ...DEFAULT_SETTINGS };
let activeScanSessionId = 0;
let activeForegroundScanSessionId = 0;
let activeSummaryFilter = null;
let previewSummaryFilter = null;
let gsrBadgePopoverEl = null;
let gsrBadgePopoverHideTimeout = null;
let gsrSearchOverlayEl = null;
let gsrAboutOverlayEl = null;
let gsrScoreDetailsOverlayEl = null;
let gsrCompletenessOverlayEl = null;
let gsrDetailDrawerEl = null;
let gsrReviewInboxOverlayEl = null;
let gsrReportPacketOverlayEl = null;
let gsrExportOverlayEl = null;
let gsrCompareOverlayEl = null;
let gsrManualDblpOverlayEl = null;
let gsrVenueDatalistPopulated = false;
let gsrDialogLastFocusedEl = null;
let currentRankingPacks = [...DEFAULT_RANKING_PACKS];
let currentSummaryState = null;
let activeDateRangeMode = TIMELINE_STATS_API?.RANGE_FULL || 'full';
let dateRangeToggleInstanceCounter = 0;
let currentProfileContext = {
    userId: null,
    authorName: null,
    dblpAuthorPid: null,
    dblpPidSource: null,
    surfaceMode: 'profile',
    scholarProfileUrl: null
};
const coreAliasIndexCache = {};
function parseYearFromText(value) {
    if (!value)
        return null;
    const match = value.match(/\b(19|20)\d{2}\b/);
    return match ? parseInt(match[0], 10) : null;
}
function normalizeIssnValue(value) {
    return String(value || '').replace(/[^0-9Xx]/g, '').toUpperCase() || null;
}
function normalizeIssnList(values) {
    const list = Array.isArray(values) ? values : String(values || '').split(/[;,]/);
    const out = [];
    const seen = new Set();
    for (const value of list) {
        const normalized = normalizeIssnValue(value);
        if (!normalized || seen.has(normalized))
            continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}
function createDecisionMeta(base = {}) {
    return {
        decisionVersion: DECISION_VERSION,
        decisionStatus: base.decisionStatus ?? DECISION_STATUS.MISSING,
        confidence: (typeof base.confidence === 'number' ? base.confidence : null),
        matchedKey: base.matchedKey ?? null,
        matchedSourceId: base.matchedSourceId ?? null,
        sourceYearFallback: base.sourceYearFallback === true,
        decisionEvidence: Array.isArray(base.decisionEvidence) ? base.decisionEvidence : null
    };
}
function mergeDecisionMeta(target, patch) {
    const next = createDecisionMeta({ ...target, ...patch });
    return next;
}
function getScholarUserId() {
    const params = new URLSearchParams(window.location.search);
    const userId = params.get('user');
    return userId;
}
function normalizeUrlForCache(url) {
    try {
        // Ensure the URL is absolute before parsing.
        // window.location.href provides the base if the input 'url' might be relative.
        const urlObj = new URL(url, window.location.href);
        const essentialParams = new URLSearchParams();
        // Essential parameters for identifying a specific publication view
        if (urlObj.searchParams.has('user')) {
            essentialParams.set('user', urlObj.searchParams.get('user'));
        }
        if (urlObj.searchParams.has('citation_for_view')) {
            essentialParams.set('citation_for_view', urlObj.searchParams.get('citation_for_view'));
        }
        // 'view_op=view_citation' is consistently part of these links
        if (urlObj.searchParams.has('view_op') && urlObj.searchParams.get('view_op') === 'view_citation') {
            essentialParams.set('view_op', 'view_citation');
        }
        // We might also want to keep 'mauthors' if present, as it can be part of the core link
        // to a specific version of a citation when multiple authors share a profile.
        // However, for simplicity and based on provided examples, we'll omit it for now.
        // If issues arise with co-authored papers from combined profiles, this could be a param to add.
        // Sort params for extremely consistent keys.
        essentialParams.sort();
        let normalized = `${urlObj.origin}${urlObj.pathname}`;
        if (essentialParams.toString()) {
            normalized += `?${essentialParams.toString()}`;
        }
        return normalized;
    }
    catch (e) {
        console.warn("GSR: Could not normalize URL:", url, e);
        // Fallback: remove hash and trim (less robust but better than nothing)
        return url.split('#')[0].trim();
    }
}
function getCacheKey(userId) {
    return `${CACHE_PREFIX}${userId}`;
}
function extractScholarUserIdFromUrl(rawValue) {
    const extracted = SETTINGS_API?.extractScholarUserId ? SETTINGS_API.extractScholarUserId(rawValue) : null;
    if (typeof extracted === 'string' && extracted.trim()) {
        return extracted.trim();
    }
    return null;
}
function normalizeScholarProfileUrlValue(rawValue) {
    const normalized = SETTINGS_API?.normalizeScholarProfileUrl ? SETTINGS_API.normalizeScholarProfileUrl(rawValue) : null;
    if (typeof normalized === 'string' && normalized.trim()) {
        return normalized.trim();
    }
    return null;
}
function buildLocalVenueCandidateNamesFromEntry(entry) {
    if (SETTINGS_API?.buildLocalVenueCandidateNames) {
        const values = SETTINGS_API.buildLocalVenueCandidateNames(entry);
        return Array.isArray(values) ? values.filter((value) => typeof value === 'string' && value.trim()) : [];
    }
    const out = [];
    const seen = new Set();
    const push = (value) => {
        const trimmed = String(value || '').trim();
        if (!trimmed) {
            return;
        }
        const key = trimmed.toLowerCase();
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        out.push(trimmed);
    };
    push(entry?.rawVenue);
    push(entry?.booktitle);
    push(entry?.journal);
    push(entry?.series);
    return out;
}
function shouldReuseProfileCacheEntry(cacheEntry) {
    if (SETTINGS_API?.shouldReuseProfileCacheEntry) {
        return SETTINGS_API.shouldReuseProfileCacheEntry(cacheEntry);
    }
    const publicationRanks = cacheEntry?.publicationRanks;
    const hasPublicationRanks = !!publicationRanks
        && typeof publicationRanks === 'object'
        && Object.keys(publicationRanks).length > 0;
    if (!hasPublicationRanks) {
        return true;
    }
    return typeof cacheEntry?.dblpAuthorPid === 'string' && cacheEntry.dblpAuthorPid.trim().length > 0;
}
function getCurrentCoreDataYear() {
    const years = ORDERED_CORE_DATA_FILES
        .map((value) => getCoreDatasetYear(value))
        .filter((value) => Number.isFinite(value));
    return years.length ? Math.max(...years) : null;
}
function getCurrentSjrDataYear() {
    return Number.isFinite(SJR_DATASET_END_YEAR) ? SJR_DATASET_END_YEAR : null;
}
function getCurrentSjrDataVersion() {
    return BUNDLED_SJR_DATA_VERSION;
}
function buildRankingDataVersion() {
    return `core-${getCurrentCoreDataYear() || 'unknown'}__sjr-v${getCurrentSjrDataVersion()}-${getCurrentSjrDataYear() || 'unknown'}`;
}
function buildExpectedCacheMetadata() {
    return {
        scoreModelVersion: SCORE_MODEL_VERSION,
        rankingDataVersion: buildRankingDataVersion(),
        coreDataYear: getCurrentCoreDataYear(),
        sjrDataVersion: getCurrentSjrDataVersion(),
        decisionVersion: DECISION_VERSION
    };
}
function hasMatchingCacheMetadata(data) {
    if (!data || typeof data !== 'object') {
        return false;
    }
    const expected = buildExpectedCacheMetadata();
    return data.scoreModelVersion === expected.scoreModelVersion
        && data.rankingDataVersion === expected.rankingDataVersion
        && data.coreDataYear === expected.coreDataYear
        && data.sjrDataVersion === expected.sjrDataVersion
        && data.decisionVersion === expected.decisionVersion;
}
async function loadCachedData(userId) {
    const cacheKey = getCacheKey(userId);
    try {
        const result = await chrome.storage.local.get(cacheKey);
        if (chrome.runtime.lastError) {
            //console.error("DEBUG: loadCachedData - chrome.runtime.lastError:", chrome.runtime.lastError.message);
        }
        if (result && result[cacheKey]) {
            const data = result[cacheKey];
            if (data.version === CACHE_VERSION) {
                if (!hasMatchingCacheMetadata(data)) {
                    await chrome.storage.local.remove(cacheKey);
                    console.log("GSR INFO: Cached data invalidated by model/data/decision version change for", cacheKey);
                    return null;
                }
                if (!shouldReuseProfileCacheEntry(data)) {
                    await chrome.storage.local.remove(cacheKey);
                    console.log("GSR INFO: Discarded incomplete cached profile data for", cacheKey);
                    return null;
                }
                const isExpired = Number.isFinite(CACHE_DURATION_MS)
                    ? (Date.now() - (data.timestamp ?? 0)) > CACHE_DURATION_MS
                    : false;
                if (!isExpired) {
                    return {
                        ...data,
                        scanStage: data.scanStage || 'depth',
                        fastCompletedAt: Number.isFinite(data.fastCompletedAt) ? data.fastCompletedAt : null,
                        depthCompletedAt: Number.isFinite(data.depthCompletedAt) ? data.depthCompletedAt : null,
                        depthAttemptedAt: Number.isFinite(data.depthAttemptedAt) ? data.depthAttemptedAt : null,
                        depthCompletionDismissed: data.depthCompletionDismissed === true
                    };
                }
                await chrome.storage.local.remove(cacheKey);
                console.log("GSR INFO: Cached data expired for", cacheKey);
            }
        }
    }
    catch (error) {
        //console.error("DEBUG: loadCachedData - Error:", error, "Key:", cacheKey);
    }
    return null;
}
async function saveCachedData(userId, coreRankCounts, sjrRankCounts, publicationRanks, scanMetadata = {}) {
    const cacheKey = getCacheKey(userId);
    const dataToStore = {
        version: CACHE_VERSION,
        ...buildExpectedCacheMetadata(),
        coreRankCounts,
        sjrRankCounts,
        publicationRanks: packRanks(publicationRanks),
        timestamp: Date.now(),
        scanStage: scanMetadata.scanStage || 'complete',
        fastCompletedAt: Number.isFinite(scanMetadata.fastCompletedAt) ? scanMetadata.fastCompletedAt : null,
        depthCompletedAt: Number.isFinite(scanMetadata.depthCompletedAt) ? scanMetadata.depthCompletedAt : null,
        depthAttemptedAt: Number.isFinite(scanMetadata.depthAttemptedAt) ? scanMetadata.depthAttemptedAt : null,
        depthCompletionDismissed: scanMetadata.depthCompletionDismissed === true
    };
    try {
        await chrome.storage.local.set({ [cacheKey]: dataToStore });
    }
    catch (error) {
        //console.error("DEBUG: saveCachedData - Error:", error, "Key:", cacheKey);
    }
}
async function setCachedDepthCompletionDismissed(userId, dismissed) {
    if (!userId || !chrome?.storage?.local?.get || !chrome?.storage?.local?.set) {
        return;
    }
    const cacheKey = getCacheKey(userId);
    try {
        const result = await chrome.storage.local.get(cacheKey);
        const cached = result?.[cacheKey];
        if (!cached || cached.version !== CACHE_VERSION) {
            return;
        }
        await chrome.storage.local.set({
            [cacheKey]: {
                ...cached,
                depthCompletionDismissed: dismissed === true
            }
        });
    }
    catch {
        // Ignore cache write failures; the in-page dismissal should still work.
    }
}
async function clearCachedData(userId) {
    const cacheKey = getCacheKey(userId);
    try {
        await chrome.storage.local.remove(cacheKey);
        activeCachedPublicationRanks = null;
        rankMapForObserver = null;
        disconnectPublicationTableObserver();
        console.log("GSR INFO: Cleared cached ranking data for", userId);
    }
    catch (error) {
        //console.error("DEBUG: clearCachedData - Error:", error);
    }
}
function getSettingsRootElement() {
    return document.body || document.documentElement;
}
// --- Theme detection -------------------------------------------------------
// The injected UI follows the PAGE's effective theme, not the OS theme:
// Scholar renders light even on dark-mode systems, while auto-dark extensions
// invert the page regardless of the OS setting. We sample the page's actual
// background and flip the design tokens via [data-gsvr-theme="dark"].
function parseCssRgbColor(value) {
    const match = String(value || '').match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/i);
    if (!match) {
        return null;
    }
    return {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
        a: match[4] === undefined ? 1 : Number(match[4])
    };
}
function detectEffectivePageTheme() {
    try {
        let element = document.body;
        let background = null;
        while (element) {
            const parsed = parseCssRgbColor(getComputedStyle(element).backgroundColor);
            if (parsed && parsed.a > 0.1) {
                background = parsed;
                break;
            }
            element = element.parentElement;
        }
        if (!background) {
            return 'light';
        }
        const luma = (0.2126 * background.r + 0.7152 * background.g + 0.0722 * background.b) / 255;
        return luma < 0.45 ? 'dark' : 'light';
    }
    catch {
        return 'light';
    }
}
function applyGsvrTheme() {
    if (document.documentElement) {
        document.documentElement.dataset.gsvrTheme = detectEffectivePageTheme();
    }
}
function syncSettingsClasses() {
    const root = getSettingsRootElement();
    if (!root?.classList)
        return;
    root.classList.toggle('gsr-compact-mode', currentSettings.compactMode);
    root.classList.toggle('gsr-hide-unranked', currentSettings.showUnranked === false);
    root.classList.toggle('gsr-debug-off', currentSettings.showDebugDetails === false);
    root.classList.toggle('gsr-authorship-off', currentSettings.showAuthorshipHighlights !== true);
    root.classList.toggle('gsr-authorship-on', currentSettings.showAuthorshipHighlights === true);
    applyGsvrTheme();
    syncAuthorshipSettingControls();
}
function syncAuthorshipSettingControls() {
    const enabled = currentSettings.showAuthorshipHighlights === true;
    document.querySelectorAll('[data-gsr-authorship-toggle-input]').forEach((input) => {
        if (input instanceof HTMLInputElement) {
            input.checked = enabled;
        }
    });
    document.querySelectorAll('[data-gsr-authorship-toggle-state]').forEach((stateEl) => {
        stateEl.textContent = enabled ? 'On' : 'Off';
    });
}
async function setAuthorshipHighlightsEnabled(enabled) {
    currentSettings = { ...currentSettings, showAuthorshipHighlights: enabled === true };
    syncSettingsClasses();
    if (currentSettings.showAuthorshipHighlights !== true && activeSummaryFilter?.type === 'authorship') {
        activeSummaryFilter = null;
    }
    if (currentSettings.showAuthorshipHighlights !== true && previewSummaryFilter?.type === 'authorship') {
        previewSummaryFilter = null;
    }
    applyActiveSummaryFilter();
    if (SETTINGS_API?.saveSettings) {
        await SETTINGS_API.saveSettings({ showAuthorshipHighlights: currentSettings.showAuthorshipHighlights });
    }
    else if (chrome?.storage?.local && SETTINGS_API?.SETTINGS_KEY) {
        await chrome.storage.local.set({ [SETTINGS_API.SETTINGS_KEY]: currentSettings });
    }
}
async function loadSettingsIntoState() {
    if (SETTINGS_API?.loadSettings) {
        currentSettings = await SETTINGS_API.loadSettings();
    }
    else {
        currentSettings = { ...DEFAULT_SETTINGS };
    }
    if (SETTINGS_API?.loadRankingPacks) {
        currentRankingPacks = await SETTINGS_API.loadRankingPacks();
    }
    else {
        currentRankingPacks = [...DEFAULT_RANKING_PACKS];
    }
    syncSettingsClasses();
    return currentSettings;
}
function getScholarSampleTargetCount() {
    return 15;
}
function looksLikeVenueAcronym(value) {
    const text = String(value || '').trim();
    return /^[A-Za-z][A-Za-z0-9-]{1,15}$/.test(text);
}
function pushUniqueCaseInsensitive(target, value, seen = null) {
    const list = Array.isArray(target) ? target : [];
    const seenSet = seen instanceof Set ? seen : new Set(list.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean));
    const trimmed = String(value || '').trim();
    if (!trimmed) {
        return;
    }
    const key = trimmed.toLowerCase();
    if (seenSet.has(key)) {
        return;
    }
    seenSet.add(key);
    list.push(trimmed);
}
function getOrCreateCoreAliasIndexForData(coreDataFile, coreData) {
    if (!Array.isArray(coreData) || !coreData.length) {
        return null;
    }
    if (!coreAliasIndexCache[coreDataFile]) {
        coreAliasIndexCache[coreDataFile] = RANKING_UTILS?.createCoreAliasIndex
            ? RANKING_UTILS.createCoreAliasIndex(coreData)
            : null;
    }
    return coreAliasIndexCache[coreDataFile] || null;
}
function buildExpandedLocalVenueCandidates(entry, trackInfo = null) {
    const utils = RANKING_UTILS;
    const baseCandidates = buildLocalVenueCandidateNamesFromEntry(entry);
    const candidates = [];
    const seen = new Set();
    const addCandidate = (value, expandOptions) => {
        const trimmed = String(value || '').trim();
        if (!trimmed) {
            return;
        }
        const expanded = utils?.expandVenueCandidates ? utils.expandVenueCandidates(trimmed, expandOptions) : [trimmed];
        for (const variant of expanded) {
            pushUniqueCaseInsensitive(candidates, variant, seen);
            const canonical = utils?.canonicalizeCsrankingsVenueName ? utils.canonicalizeCsrankingsVenueName(variant) : null;
            if (canonical) {
                pushUniqueCaseInsensitive(candidates, canonical, seen);
            }
        }
    };
    for (const candidate of baseCandidates) {
        addCandidate(candidate);
    }
    if (trackInfo?.resolvedVenue) {
        addCandidate(trackInfo.resolvedVenue, trackInfo.isWorkshop ? { includeAtParent: false } : undefined);
    }
    if (trackInfo?.parentVenue) {
        addCandidate(trackInfo.parentVenue);
    }
    if (trackInfo?.seriesId) {
        addCandidate(trackInfo.seriesId, trackInfo.isWorkshop ? { includeAtParent: false } : undefined);
    }
    return candidates;
}
function getFacultyScoreWeight(rank) {
    const normalizedRank = String(rank || '').trim().toUpperCase();
    return VENUE_PROFILE_INDEX_WEIGHTS[normalizedRank] ?? 0;
}
function isResearchQualityRankedInfo(info) {
    return (info?.system === 'CORE' && VALID_RANKS.includes(info.rank))
        || (info?.system === 'SJR' && SJR_QUARTILES.includes(info.rank));
}
function getResearchQualityMetrics(info) {
    const rawAuthorCount = Number(info?.authorCount);
    const authorCount = Number.isFinite(rawAuthorCount) && rawAuthorCount > 0 ? Math.round(rawAuthorCount) : null;
    if (!isResearchQualityRankedInfo(info)) {
        return {
            rank: String(info?.rank || '').trim().toUpperCase(),
            weight: 0,
            authorCount,
            credit: 0
        };
    }
    const rank = String(info?.rank || '').trim().toUpperCase();
    const weight = getFacultyScoreWeight(rank);
    return {
        rank,
        weight,
        authorCount,
        credit: weight > 0 && authorCount ? weight / authorCount : 0
    };
}
function nextScanSessionId() {
    activeScanSessionId += 1;
    return activeScanSessionId;
}
function isCurrentScanSession(sessionId) {
    return typeof sessionId === 'number' && sessionId === activeScanSessionId;
}
function throwIfStaleScanSession(sessionId) {
    if (typeof sessionId === 'number' && !isCurrentScanSession(sessionId)) {
        throw new ScanSessionCancelledError();
    }
}
function buildScanLifecycleState(status, message, improvementCount = null) {
    return {
        phase: 'depth',
        status,
        message,
        improvementCount: typeof improvementCount === 'number' ? improvementCount : null
    };
}
function countAdditionalRanksFound(previousRanks, nextRanks) {
    const previousByUrl = new Map((previousRanks || []).map((info) => [normalizeUrlForCache(info?.url || ''), info]));
    let improvementCount = 0;
    for (const nextInfo of nextRanks || []) {
        const normalizedUrl = normalizeUrlForCache(nextInfo?.url || '');
        const previousInfo = previousByUrl.get(normalizedUrl) || null;
        const previousRanked = isRankedResultInfo(previousInfo);
        const nextRanked = isRankedResultInfo(nextInfo);
        if (nextRanked && (!previousRanked || previousInfo?.rank !== nextInfo?.rank || previousInfo?.system !== nextInfo?.system)) {
            improvementCount += 1;
        }
    }
    return improvementCount;
}
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
function extractVenueFromProfileLine(rawLine) {
    // Scholar's venue line looks like "Venue Name 30 (2), 100-110, 2017".
    // Strip the trailing bibliographic metadata (volume, issue, page range,
    // year) so only the venue name remains; the CORE/SJR matchers need the
    // name, not the numbers, and trailing digits otherwise break matching.
    let text = String(rawLine || '')
        .replace(/\p{Extended_Pictographic}/gu, ' ')
        .replace(/[\uFE0E\uFE0F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) {
        return null;
    }
    // Remove bibliographic noise wherever it appears — 4-digit years, page
    // ranges, ordinals, and numeric volume/issue parentheticals — none of
    // which appear in CORE/SJR titles and which otherwise derail matching.
    text = text
        .replace(/\b(?:19|20)\d{2}\b/g, ' ')            // years
        .replace(/\b\d+\s*[-‒-―]\s*\d+\b/g, ' ') // page ranges
        .replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ')       // ordinals
        .replace(WORD_ORDINAL_PATTERN, ' ')             // word ordinals
        .replace(/\(\s*\d[^)]*\)/g, ' ');               // (volume/issue/issn)
    let previous;
    do {
        previous = text;
        text = text
            .replace(/[,\s]+\d+\s*$/, '')               // trailing bare volume number
            .replace(/[\s,]*\(\s*\)\s*$/, '')           // empty parens left behind
            .replace(/[\s,]+$/, '')
            .trim();
    } while (text !== previous);
    return text.replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim() || null;
}
function estimateAuthorCountFromScholarLine(rawLine) {
    let text = String(rawLine || '').replace(/\s+/g, ' ').trim();
    if (!text) {
        return null;
    }
    // Scholar may truncate long author lists. A visible partial list would
    // overstate fractional credit, so keep those records out of the score.
    if (/(\.\.\.|…|\bet\s+al\.?\b)/i.test(text)) {
        return null;
    }
    text = text
        .replace(/\s+\band\b\s+/gi, ',')
        .replace(/\s*&\s*/g, ',')
        .replace(/\s*;\s*/g, ',');
    const authors = text
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    return authors.length > 0 ? authors.length : null;
}
function collectPublicationLinkElements() {
    const publicationLinkElements = [];
    document.querySelectorAll('tr.gsc_a_tr').forEach((row) => {
        const linkEl = row.querySelector('td.gsc_a_t a.gsc_a_at');
        const yearEl = row.querySelector('td.gsc_a_y span.gsc_a_h');
        let yearFromProfile = null;
        if (yearEl?.textContent && /^\d{4}$/.test(yearEl.textContent.trim())) {
            yearFromProfile = parseInt(yearEl.textContent.trim(), 10);
        }
        // The title cell holds two gray lines: authors, then the venue.
        const grayLines = row.querySelectorAll('td.gsc_a_t div.gs_gray');
        const authorText = grayLines.length > 1 ? grayLines[0]?.textContent : null;
        const authorCount = estimateAuthorCountFromScholarLine(authorText);
        const venueText = extractVenueFromProfileLine(grayLines[grayLines.length - 1]?.textContent);
        if (linkEl instanceof HTMLAnchorElement && linkEl.href && linkEl.textContent) {
            publicationLinkElements.push({
                url: normalizeUrlForCache(linkEl.href),
                rowElement: row,
                paperTitle: linkEl.textContent.trim(),
                titleText: linkEl.textContent.trim().toLowerCase(),
                authorCount,
                venueText,
                yearFromProfile
            });
        }
    });
    return publicationLinkElements;
}
function hasExpandableScholarPublications() {
    const showMoreButton = document.getElementById('gsc_bpf_more');
    return !!showMoreButton && !showMoreButton.disabled;
}
async function rescanCurrentProfile(options = {}) {
    if (isMainProcessing) {
        return;
    }
    const sessionId = nextScanSessionId();
    disconnectPublicationTableObserver();
    activeCachedPublicationRanks = null;
    rankMapForObserver = null;
    activeSummaryFilter = null;
    previewSummaryFilter = null;
    document.getElementById(FACULTY_SCORE_PANEL_ID)?.remove();
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    currentSummaryState = null;
    const currentUserId = getScholarUserId();
    if (currentUserId) {
        await clearCachedData(currentUserId);
    }
    main({ sessionId, forceFresh: true }).catch(error => {
        console.error('GSR: Error during rescan after cache clear:', error);
        const statusElemCheck = document.getElementById(STATUS_ELEMENT_ID);
        if (!statusElemCheck) {
            const statusElem = createStatusElement('Error during rescan. Check console.');
            const progress = statusElem.querySelector('.gsr-progress-bar-inner');
            if (progress) {
                progress.style.backgroundColor = 'red';
            }
            appendStatusRescanControls(statusElem);
        }
    });
}
function appendStatusRescanControls(statusElement, { includeReload = false, includeManualEntry = false, rescanLabel = 'Rescan' } = {}) {
    if (!statusElement) {
        return;
    }
    let actions = statusElement.querySelector('.gsr-status-actions');
    if (!actions) {
        actions = document.createElement('div');
        actions.className = 'gsr-card__actions gsr-status-actions';
        statusElement.appendChild(actions);
    }
    actions.replaceChildren();
    const rescanButton = document.createElement('button');
    rescanButton.type = 'button';
    rescanButton.className = 'gsr-button gsr-button--primary';
    rescanButton.textContent = rescanLabel;
    rescanButton.addEventListener('click', () => {
        rescanCurrentProfile().catch((error) => console.error('GSR: Failed to start rescan.', error));
    });
    actions.appendChild(rescanButton);
    if (includeReload) {
        const reloadButton = document.createElement('button');
        reloadButton.type = 'button';
        reloadButton.className = 'gsr-button gsr-button--ghost';
        reloadButton.textContent = 'Reload Page';
        reloadButton.addEventListener('click', () => {
            window.location.reload();
        });
        actions.appendChild(reloadButton);
    }
}
function isRankingPackEnabled(packName) {
    return currentRankingPacks.includes(String(packName || '').trim().toLowerCase());
}
async function loadFeatureState(name) {
    if (SETTINGS_API?.loadFeatureState) {
        return SETTINGS_API.loadFeatureState(name);
    }
    const key = FEATURE_STORAGE_KEYS[name];
    if (!key || !chrome?.storage?.local?.get) {
        return null;
    }
    try {
        const result = await chrome.storage.local.get(key);
        return result?.[key] ?? null;
    }
    catch {
        return null;
    }
}
async function saveFeatureState(name, value) {
    if (SETTINGS_API?.saveFeatureState) {
        return SETTINGS_API.saveFeatureState(name, value);
    }
    const key = FEATURE_STORAGE_KEYS[name];
    if (!key || !chrome?.storage?.local?.set) {
        return value;
    }
    await chrome.storage.local.set({ [key]: value });
    return value;
}
function isRankedResultInfo(info) {
    return (info?.system === 'CORE' && VALID_RANKS.includes(info.rank))
        || (info?.system === 'SJR' && SJR_QUARTILES.includes(info.rank));
}
function getRowStatusKind(info) {
    if (info?.system === 'DBLP' && info?.rank === DBLP_ENTRY_MISSING_LABEL) {
        return 'dblp-missing';
    }
    if (isRankedResultInfo(info)) {
        return 'ranked';
    }
    return 'unranked';
}
function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function normalizeRankKey(value) {
    return String(value ?? 'na')
        .toLowerCase()
        .replace(/\*/g, 'star')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
function humanizeIdentifier(value) {
    return String(value || '')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (match) => match.toUpperCase());
}
function getPaperTitle(info) {
    return String(info?.paperTitle || info?.titleText || '').trim();
}
function getPublicationYear(info) {
    return Number.isFinite(info?.publicationYear) ? info.publicationYear : null;
}
function getDecisionEvidenceTokens(info) {
    return Array.isArray(info?.decisionEvidence)
        ? info.decisionEvidence.filter((value) => !!value).map((value) => String(value))
        : [];
}
function humanizeEvidenceToken(token) {
    const value = String(token || '').trim();
    if (!value)
        return '';
    if (value.startsWith('source:')) {
        return `Source ID ${value.slice('source:'.length)}`;
    }
    const map = {
        dblp_entry_missing: 'DBLP entry missing from matched profile',
        publication_ambiguous: 'DBLP publication match is ambiguous',
        ambiguous_fuzzy_core: 'CORE venue match is ambiguous',
        ambiguous_acronym: 'Venue acronym is ambiguous',
        ambiguous_title_alias: 'Venue title alias is ambiguous',
        sjr_ambiguous: 'SJR journal match is ambiguous',
        sjr_historical_coverage_unavailable: 'SJR historical coverage unavailable',
        dblp_venue_match: 'Matched DBLP venue catalog',
        dblp_venue_missing: 'Venue not found in DBLP venue catalog',
        dblp_venue_ambiguous: 'DBLP venue catalog match is ambiguous',
        venue_unranked: 'DBLP venue has no CORE/SJR rank',
        workshop: 'Excluded as workshop',
        short_by_pages: 'Excluded by short-paper page rule',
        extended_abstract: 'Excluded as extended abstract',
        demo_poster: 'Excluded as demo/poster track',
        editorship: 'Excluded as editorship entry',
        no_core_match: 'No bundled CORE match',
        top_venue_fallback: 'CSRankings top-venue fallback applied',
    };
    return map[value] || humanizeIdentifier(value);
}
function getReviewReason(info) {
    if (info?.system === 'DBLP' && info?.rank === DBLP_ENTRY_MISSING_LABEL) {
        return 'DBLP Entry Missing';
    }
    if (info?.reason) {
        return String(info.reason);
    }
    const evidence = getDecisionEvidenceTokens(info);
    if (evidence.some((token) => token === 'dblp_entry_missing')) {
        return 'DBLP Entry Missing';
    }
    if (evidence.some((token) => token.includes('ambiguous'))) {
        return 'Ambiguous Match';
    }
    if (evidence.includes('sjr_historical_coverage_unavailable')) {
        return 'SJR Historical Coverage Unavailable';
    }
    if (evidence.includes('short_by_pages')) {
        return 'Short-paper';
    }
    if (evidence.includes('extended_abstract')) {
        return 'Extended Abstract';
    }
    if (evidence.includes('demo_poster')) {
        return 'Demo/Poster';
    }
    if (evidence.includes('editorship')) {
        return 'Editorship';
    }
    if (info?.decisionStatus === DECISION_STATUS.AMBIGUOUS) {
        return 'Ambiguous Match';
    }
    if (info?.decisionStatus === DECISION_STATUS.MISSING) {
        return 'Missing Evidence';
    }
    return 'Unranked';
}
function formatConfidencePercent(value) {
    return typeof value === 'number' ? `${Math.round(value * 100)}%` : 'N/A';
}
function formatTimestamp(value) {
    if (!value) {
        return 'Never';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return 'Unknown';
    }
    return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
function getTopCandidates(info) {
    return Array.isArray(info?.topCandidates) ? info.topCandidates : [];
}
function normalizeDblpAuthorsForPublication(authors) {
    if (AUTHORSHIP_API?.normalizeDblpAuthors) {
        return AUTHORSHIP_API.normalizeDblpAuthors(Array.isArray(authors) ? authors : []);
    }
    const list = Array.isArray(authors) ? authors : [];
    return list.map((author, index) => ({
        name: String(author?.name || '').replace(/\s+/g, ' ').trim() || null,
        pid: String(author?.pid || '').trim() || null,
        index,
        position: index + 1,
        authorCount: list.length || null,
    }));
}
function normalizePublicationAuthorship(authorship, authorCount = null) {
    if (AUTHORSHIP_API?.normalizeAuthorship) {
        return AUTHORSHIP_API.normalizeAuthorship({
            ...(authorship && typeof authorship === 'object' ? authorship : {}),
            authorCount: authorship?.authorCount ?? authorCount ?? null,
        });
    }
    const input = authorship && typeof authorship === 'object' ? authorship : {};
    const normalizedAuthorCount = Number.isFinite(Number(input.authorCount ?? authorCount)) ? Math.round(Number(input.authorCount ?? authorCount)) : null;
    const status = input.status === 'verified' ? 'verified' : 'unknown';
    const roles = status === 'verified' && normalizedAuthorCount !== 1 && Array.isArray(input.roles)
        ? Array.from(new Set(input.roles.filter((role) => role === 'first' || role === 'last')))
        : [];
    return {
        status,
        roles,
        position: Number.isFinite(Number(input.position)) ? Math.round(Number(input.position)) : null,
        authorCount: normalizedAuthorCount,
        profilePid: input.profilePid || null,
        source: 'dblp-author-order',
        reason: input.reason || (status === 'verified' && normalizedAuthorCount === 1 ? 'single_author' : null),
    };
}
function classifyDblpAuthorship(profilePid, authors, authorCount = null) {
    if (AUTHORSHIP_API?.classifyAuthorPosition) {
        return AUTHORSHIP_API.classifyAuthorPosition({ profilePid, authors, authorCount });
    }
    return normalizePublicationAuthorship(null, authorCount);
}
function getAuthorshipRoles(info) {
    const authorship = normalizePublicationAuthorship(info?.authorship, info?.authorCount ?? null);
    if (authorship.authorCount === 1) {
        return [];
    }
    return Array.isArray(authorship.roles) ? authorship.roles : [];
}
function hasAuthorshipRole(info, role) {
    return getAuthorshipRoles(info).includes(role);
}
function buildAuthorshipCounts(publicationRanks) {
    const counts = { first: 0, last: 0 };
    for (const info of publicationRanks || []) {
        if (hasAuthorshipRole(info, 'first')) {
            counts.first += 1;
        }
        if (hasAuthorshipRole(info, 'last')) {
            counts.last += 1;
        }
    }
    return counts;
}
function formatAuthorshipLabel(authorship) {
    const normalized = normalizePublicationAuthorship(authorship);
    if (normalized.status !== 'verified' || normalized.authorCount === 1) {
        return '';
    }
    const roles = normalized.roles || [];
    if (roles.includes('first')) {
        return '1st';
    }
    if (roles.includes('last')) {
        return 'Last';
    }
    return '';
}
function formatAuthorshipRailLabel(authorship) {
    const normalized = normalizePublicationAuthorship(authorship);
    if (normalized.status !== 'verified' || normalized.authorCount === 1) {
        return '';
    }
    const roles = normalized.roles || [];
    if (roles.includes('first')) {
        return 'First';
    }
    if (roles.includes('last')) {
        return 'Last';
    }
    return '';
}
function getAuthorshipRailRoleClass(authorship) {
    const normalized = normalizePublicationAuthorship(authorship);
    if (normalized.authorCount === 1) {
        return 'unknown';
    }
    const roles = normalized.roles || [];
    if (roles.includes('first')) {
        return 'first';
    }
    if (roles.includes('last')) {
        return 'last';
    }
    return 'unknown';
}
function formatAuthorshipSummary(authorship) {
    const normalized = normalizePublicationAuthorship(authorship);
    if (normalized.status !== 'verified' || !normalized.position || !normalized.authorCount) {
        return 'DBLP author position unavailable';
    }
    const label = formatAuthorshipRailLabel(normalized) || formatAuthorshipLabel(normalized);
    const roleSuffix = label ? ` · ${label}` : '';
    return `DBLP position ${normalized.position} of ${normalized.authorCount}${roleSuffix}`;
}
function buildEvidenceItems(info) {
    const items = [];
    for (const token of getDecisionEvidenceTokens(info)) {
        items.push({
            raw: token,
            label: humanizeEvidenceToken(token),
        });
    }
    return items;
}
function buildFacultyScoreState(publicationRanks) {
    const profileScore = SCORE_MODEL_API?.computeProfileScore
        ? SCORE_MODEL_API.computeProfileScore(publicationRanks || [], DEFAULT_SCORE_CONFIG || undefined)
        : null;
    const countedPublications = [];
    const tierCredits = {
        'A*': 0,
        'A': 0,
        'B': 0,
        'C': 0,
        'Q1': 0,
        'Q2': 0,
        'Q3': 0,
        'Q4': 0
    };
    let totalScore = 0;

    if (profileScore) {
        for (const scored of profileScore.publications || []) {
            const info = scored.raw || {};
            const contribution = Number(scored.score?.contribution) || 0;
            const rank = String(scored.score?.rank || scored.ranking?.rank || info.rank || '').trim().toUpperCase();
            if (contribution <= 0 || !rank) {
                continue;
            }
            totalScore += contribution;
            if (typeof tierCredits[rank] !== 'number') {
                tierCredits[rank] = 0;
            }
            tierCredits[rank] += contribution;
            countedPublications.push({
                title: getPaperTitle(info),
                venue: info?.matchedVenue || info?.dblpVenue || 'Unknown Venue',
                system: scored.score?.rankSource || scored.ranking?.source || info?.system || 'UNKNOWN',
                rank,
                weight: Number(scored.score?.venueValue ?? scored.ranking?.venueValue) || getFacultyScoreWeight(rank),
                credit: contribution,
                authorCount: Number(scored.score?.authorCount) || null,
                fractionalCredit: Number(scored.score?.fractionalCredit) || null,
                rankingSnapshotYear: scored.score?.rankingSnapshotYear ?? scored.ranking?.rankingSnapshotYear ?? info?.sourceYear ?? null,
                year: getPublicationYear(info),
                decisionEvidence: getDecisionEvidenceTokens(info),
                publicationType: scored.classification?.publicationType ?? null,
                scoreEligible: scored.score?.eligible === true,
                exclusionReason: scored.score?.exclusionReason ?? null
            });
        }
    }
    else {
        for (const info of publicationRanks || []) {
            if (!isResearchQualityRankedInfo(info)) {
                continue;
            }
            const { rank, weight, authorCount, credit } = getResearchQualityMetrics(info);
            if (weight <= 0) {
                continue;
            }
            totalScore += credit;
            if (typeof tierCredits[rank] !== 'number') {
                tierCredits[rank] = 0;
            }
            tierCredits[rank] += credit;
            countedPublications.push({
                title: getPaperTitle(info),
                venue: info?.matchedVenue || info?.dblpVenue || 'Unknown Venue',
                system: info?.system || 'UNKNOWN',
                rank,
                weight,
                credit,
                authorCount,
                year: getPublicationYear(info),
                decisionEvidence: getDecisionEvidenceTokens(info)
            });
        }
    }

    countedPublications.sort((left, right) => right.credit - left.credit
        || right.weight - left.weight
        || String(left.system).localeCompare(String(right.system))
        || String(left.title).localeCompare(String(right.title)));
    const scoreSummary = profileScore?.scores || {};
    const diagnostics = profileScore?.diagnostics || null;
    const completeness = profileScore?.completeness || normalizeScoringCompleteness(null, diagnostics, scoreSummary, publicationRanks);
    const fractionalPublicationWeight = Number(scoreSummary.fractionalPublicationWeight ?? countedPublications.reduce((total, item) => total + (Number(item.fractionalCredit) || 0), 0));
    const eligibleRankedPublications = Number(scoreSummary.eligibleRankedPublications ?? countedPublications.length);
    const gsvrScore = Number(scoreSummary.gsvrScore ?? totalScore);
    const averageVenueValue = Number(scoreSummary.averageVenueValue ?? (fractionalPublicationWeight > 0 ? gsvrScore / fractionalPublicationWeight : 0));
    return {
        totalScore: gsvrScore,
        gsvrScore,
        adjustedCount: gsvrScore,
        normalizedIndex: gsvrScore,
        denominator: fractionalPublicationWeight,
        fractionalPublicationWeight,
        eligibleRankedPublications,
        averageVenueValue,
        coreContribution: Number(scoreSummary.coreContribution ?? 0),
        sjrContribution: Number(scoreSummary.sjrContribution ?? 0),
        coreIndex: profileScore?.coreIndex ?? null,
        sjrIndex: profileScore?.sjrIndex ?? null,
        combinedIndex: profileScore?.scores ?? null,
        coverage: diagnostics,
        diagnostics,
        completeness,
        scoreModelVersion: profileScore?.scoreModelVersion || SCORE_MODEL_VERSION,
        calibrationStrategy: 'fractional_venue_score',
        authorshipModel: 'fractional_counting',
        rawProfileScore: profileScore,
        tierCredits,
        countedPapers: eligibleRankedPublications,
        averageCreditPerPaper: eligibleRankedPublications > 0 ? gsvrScore / eligibleRankedPublications : 0,
        countedPublications,
    };
}
function normalizeScoringCompleteness(rawCompleteness = null, diagnostics = null, scores = null, publicationRanks = null) {
    const raw = rawCompleteness && typeof rawCompleteness === 'object' ? rawCompleteness : {};
    const diag = diagnostics && typeof diagnostics === 'object' ? diagnostics : {};
    const score = scores && typeof scores === 'object' ? scores : {};
    const totalFallback = Array.isArray(publicationRanks) ? publicationRanks.length : 0;
    const counts = {
        total: Number(raw.total ?? diag.totalScholarItems ?? totalFallback) || 0,
        scored: Number(raw.scored ?? score.eligibleRankedPublications ?? diag.eligibleRankedPublications ?? 0) || 0,
        dblpMissing: Number(raw.dblpMissing ?? diag.dblpMissing ?? diag.missingDblp ?? 0) || 0,
        ambiguous: Number(raw.ambiguous ?? diag.ambiguousMatches ?? diag.ambiguous ?? 0) || 0,
        rankNotFound: Number(raw.rankNotFound ?? diag.unrankedVenues ?? diag.sourceMissing ?? 0) || 0,
        excludedType: Number(raw.excludedType ?? (
            Number(diag.excludedShortPapers || 0)
            + Number(diag.excludedWorkshops || 0)
            + Number(diag.excludedDemosPosters || 0)
            + Number(diag.excludedExtendedAbstracts || 0)
            + Number(diag.excludedPreprints || 0)
        )) || 0,
        missingAuthorCount: Number(raw.missingAuthorCount ?? diag.missingAuthorCount ?? 0) || 0,
        lookupUnavailable: Number(raw.lookupUnavailable ?? (
            Number(diag.sourceRateLimited || 0)
            + Number(diag.sourceUnavailable || 0)
        )) || 0,
    };
    const segmentDefinitions = [
        ['scored', 'Scored'],
        ['dblpMissing', 'DBLP missing'],
        ['ambiguous', 'Ambiguous match'],
        ['rankNotFound', 'Venue unranked'],
        ['excludedType', 'Excluded type'],
        ['missingAuthorCount', 'Missing author count'],
        ['lookupUnavailable', 'Lookup unavailable'],
    ];
    return {
        ...counts,
        completeness: counts.total > 0 ? counts.scored / counts.total : 0,
        formula: raw.formula || 'N_scored / N_total',
        segments: segmentDefinitions.map(([key, label]) => ({
            key,
            label,
            count: counts[key],
            ratio: counts.total > 0 ? counts[key] / counts.total : 0,
        })),
    };
}
function formatCompletenessPercent(completeness) {
    const value = Number(completeness?.completeness ?? completeness ?? 0);
    return `${Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100)}%`;
}
function getCompletenessBreakdownText(completeness) {
    const value = normalizeScoringCompleteness(completeness);
    const unavailable = value.lookupUnavailable + value.missingAuthorCount;
    return `${value.dblpMissing} DBLP missing · ${value.ambiguous} ambiguous · ${value.rankNotFound} unranked · ${value.excludedType} excluded · ${unavailable} unavailable/metadata`;
}
function createScoringCompletenessBar(completeness, className = '') {
    const value = normalizeScoringCompleteness(completeness);
    const bar = document.createElement('div');
    bar.className = `gsr-completeness-bar${className ? ` ${className}` : ''}`.trim();
    bar.setAttribute('aria-hidden', 'true');
    for (const segment of value.segments || []) {
        if (!segment.count) {
            continue;
        }
        const part = document.createElement('span');
        part.className = `gsr-completeness-bar__segment gsr-completeness-bar__segment--${segment.key}`;
        part.style.flexGrow = String(Math.max(0, Number(segment.count) || 0));
        part.title = `${segment.label}: ${segment.count}`;
        bar.appendChild(part);
    }
    if (!bar.children.length) {
        const empty = document.createElement('span');
        empty.className = 'gsr-completeness-bar__segment gsr-completeness-bar__segment--empty';
        empty.style.flexGrow = '1';
        bar.appendChild(empty);
    }
    return bar;
}
function getTimelineCurrentYear() {
    return new Date().getFullYear();
}
function normalizeDateRangeMode(mode) {
    return TIMELINE_STATS_API?.normalizeRangeMode
        ? TIMELINE_STATS_API.normalizeRangeMode(mode)
        : (mode === 'last10' ? 'last10' : 'full');
}
function buildTimelineViewState(publicationRanks, rangeMode = activeDateRangeMode) {
    const source = Array.isArray(publicationRanks) ? publicationRanks : [];
    const currentYear = getTimelineCurrentYear();
    if (TIMELINE_STATS_API?.buildTimelineStats) {
        return TIMELINE_STATS_API.buildTimelineStats(source, {
            rangeMode: normalizeDateRangeMode(rangeMode),
            currentYear,
            recentYears: 8,
        });
    }
    const mode = normalizeDateRangeMode(rangeMode);
    const range = mode === 'last10'
        ? { mode, label: 'Last 10 Years', startYear: currentYear - 9, endYear: currentYear }
        : { mode: 'full', label: 'Full Timeline', startYear: null, endYear: null };
    const getYear = (info) => getPublicationYear(info);
    const filtered = range.mode === 'last10'
        ? source.filter((info) => {
            const year = getYear(info);
            return year != null && year >= range.startYear && year <= range.endYear;
        })
        : source.slice();
    const coreRankCounts = createEmptyCoreRankCounts();
    const sjrRankCounts = createEmptySjrRankCounts();
    for (const info of filtered) {
        if (info?.system === 'CORE') {
            coreRankCounts[VALID_RANKS.includes(info.rank) ? info.rank : 'N/A'] += 1;
        }
        else if (info?.system === 'SJR') {
            sjrRankCounts[SJR_QUARTILES.includes(info.rank) ? info.rank : 'N/A'] += 1;
        }
    }
    const buildWindow = (items, startYear, endYear) => {
        const buckets = new Map();
        for (let year = startYear; year <= endYear; year++) {
            buckets.set(year, {
                year,
                ranks: { 'A*': 0, A: 0, B: 0, C: 0, Q1: 0, Q2: 0, Q3: 0, Q4: 0 },
                conference: 0,
                journal: 0,
                total: 0,
            });
        }
        for (const info of items) {
            const year = getYear(info);
            const bucket = buckets.get(year);
            if (!bucket)
                continue;
            if (info?.system === 'CORE' && VALID_RANKS.includes(info.rank)) {
                bucket.ranks[info.rank] += 1;
                bucket.conference += 1;
                bucket.total += 1;
            }
            else if (info?.system === 'SJR' && SJR_QUARTILES.includes(info.rank)) {
                bucket.ranks[info.rank] += 1;
                bucket.journal += 1;
                bucket.total += 1;
            }
        }
        return Array.from(buckets.values());
    };
    const knownYears = source.map(getYear).filter((year) => year != null);
    const recentHistogram = buildWindow(filtered, currentYear - 7, currentYear);
    const fullHistogram = knownYears.length ? buildWindow(source, Math.min(...knownYears), Math.max(...knownYears)) : [];
    return {
        rangeMode: range.mode,
        range,
        currentYear,
        publications: filtered,
        allPublications: source,
        coreRankCounts,
        sjrRankCounts,
        recentHistogram,
        fullHistogram,
        focusedHistograms: {
            recent: buildFocusedTimelineHistograms(recentHistogram),
            full: buildFocusedTimelineHistograms(fullHistogram),
        },
        unknownYearCount: filtered.filter((info) => getYear(info) == null).length,
        allUnknownYearCount: source.filter((info) => getYear(info) == null).length,
    };
}
function buildSummaryInsights(coreRankCounts, sjrRankCounts, publicationRanks) {
    const topRankedVenues = new Map();
    const reviewReasonCounts = new Map();
    const yearly = new Map();
    let rankedCount = 0;
    let conferenceCount = 0;
    let journalCount = 0;
    let reviewCount = 0;
    for (const info of publicationRanks || []) {
        const year = getPublicationYear(info);
        const yearKey = year != null ? String(year) : 'Unknown';
        if (!yearly.has(yearKey)) {
            yearly.set(yearKey, { year: yearKey, ranked: 0, review: 0, conference: 0, journal: 0 });
        }
        const bucket = yearly.get(yearKey);
        const ranked = isRankedResultInfo(info);
        if (ranked) {
            rankedCount++;
            bucket.ranked += 1;
            const venueKey = String(info.matchedVenue || info.dblpVenue || info.rank || 'Unknown Venue');
            topRankedVenues.set(venueKey, (topRankedVenues.get(venueKey) || 0) + 1);
        }
        else {
            reviewCount++;
            bucket.review += 1;
            const reviewReason = getReviewReason(info);
            reviewReasonCounts.set(reviewReason, (reviewReasonCounts.get(reviewReason) || 0) + 1);
        }
        if (info?.system === 'CORE') {
            conferenceCount += 1;
            bucket.conference += 1;
        }
        else if (info?.system === 'SJR') {
            journalCount += 1;
            bucket.journal += 1;
        }
    }
    const orderedYears = Array.from(yearly.values()).sort((left, right) => {
        if (left.year === 'Unknown')
            return 1;
        if (right.year === 'Unknown')
            return -1;
        return Number(left.year) - Number(right.year);
    });
    return {
        totalPapers: (publicationRanks || []).length,
        rankedCount,
        reviewCount,
        conferenceCount,
        journalCount,
        rankedShare: (publicationRanks || []).length > 0 ? rankedCount / publicationRanks.length : 0,
        topRankedVenues: Array.from(topRankedVenues.entries())
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .slice(0, 6)
            .map(([venue, count]) => ({ venue, count })),
        reviewReasons: Array.from(reviewReasonCounts.entries())
            .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
            .map(([reason, count]) => ({ reason, count })),
        yearlyTrend: orderedYears,
        highlightedMix: {
            'A*/A': (Number(coreRankCounts?.['A*']) || 0) + (Number(coreRankCounts?.A) || 0),
            'Q1': Number(sjrRankCounts?.Q1) || 0,
            'Needs Review': reviewCount,
        },
    };
}
function buildSummaryState(coreRankCounts, sjrRankCounts, publicationRanks, cacheTimestamp, scanLifecycle = null) {
    const allPublicationRanks = Array.isArray(publicationRanks) ? publicationRanks.slice() : [];
    const timeline = buildTimelineViewState(allPublicationRanks, activeDateRangeMode);
    const filteredPublicationRanks = Array.isArray(timeline.publications) ? timeline.publications : allPublicationRanks;
    const effectiveCoreRankCounts = timeline.coreRankCounts || coreRankCounts || createEmptyCoreRankCounts();
    const effectiveSjrRankCounts = timeline.sjrRankCounts || sjrRankCounts || createEmptySjrRankCounts();
    const reviewItems = filteredPublicationRanks.filter((info) => !isRankedResultInfo(info));
    const venueProfileIndex = buildFacultyScoreState(filteredPublicationRanks);
    const authorshipCounts = buildAuthorshipCounts(filteredPublicationRanks);
    return {
        coreRankCounts: effectiveCoreRankCounts,
        sjrRankCounts: effectiveSjrRankCounts,
        allCoreRankCounts: coreRankCounts || effectiveCoreRankCounts,
        allSjrRankCounts: sjrRankCounts || effectiveSjrRankCounts,
        publicationRanks: filteredPublicationRanks,
        allPublicationRanks,
        cacheTimestamp: cacheTimestamp ?? null,
        reviewItems,
        authorshipCounts,
        insights: buildSummaryInsights(effectiveCoreRankCounts, effectiveSjrRankCounts, filteredPublicationRanks),
        timeline,
        dateRangeMode: timeline.rangeMode || activeDateRangeMode,
        venueProfileIndex,
        facultyScore: venueProfileIndex,
        context: { ...currentProfileContext },
        scanLifecycle: scanLifecycle ?? null,
    };
}
function sumSummaryCountKeys(counts, keys) {
    return (keys || []).reduce((total, key) => total + (Number(counts?.[key]) || 0), 0);
}
function buildSummaryCountSnapshot(summaryState) {
    // Exclude N/A buckets so ranked totals stay aligned across the score,
    // sidebar summary, and exported report metrics.
    const conferenceCount = sumSummaryCountKeys(summaryState?.coreRankCounts, ['A*', 'A', 'B', 'C']);
    const journalCount = sumSummaryCountKeys(summaryState?.sjrRankCounts, ['Q1', 'Q2', 'Q3', 'Q4']);
    const rankedCount = conferenceCount + journalCount;
    const totalPapers = Array.isArray(summaryState?.publicationRanks)
        ? summaryState.publicationRanks.length
        : (Number(summaryState?.insights?.totalPapers) || rankedCount + (Number(summaryState?.insights?.reviewCount) || 0));
    return {
        totalPapers,
        conferenceCount,
        journalCount,
        rankedCount,
        reviewCount: Math.max(0, totalPapers - rankedCount)
    };
}
function buildExportRows(summaryState) {
    return (summaryState?.publicationRanks || []).map((info) => {
        const scored = SCORE_MODEL_API?.computePublicationScore
            ? SCORE_MODEL_API.computePublicationScore(info, DEFAULT_SCORE_CONFIG || undefined)
            : null;
        const score = scored?.score || {};
        const ranking = scored?.ranking || {};
        const authorship = normalizePublicationAuthorship(info?.authorship, score.authorCount ?? info?.authorCount ?? null);
        return {
            title: getPaperTitle(info),
            year: getPublicationYear(info),
            dblpKey: info?.dblpKey || '',
            publicationType: scored?.classification?.publicationType || '',
            rankSource: score.rankSource || ranking.source || info?.system || 'UNKNOWN',
            rank: score.rank || ranking.rank || info?.rank || 'N/A',
            rankingSnapshotYear: score.rankingSnapshotYear ?? ranking.rankingSnapshotYear ?? info?.sourceYear ?? '',
            authorCount: score.authorCount ?? '',
            authorshipStatus: authorship.status || 'unknown',
            authorPosition: authorship.position ?? '',
            authorRoles: (authorship.roles || []).join('+'),
            authorshipSource: authorship.source || '',
            venueValue: Number.isFinite(score.venueValue) ? Number(score.venueValue.toFixed(4)) : '',
            fractionalCredit: Number.isFinite(score.fractionalCredit) ? Number(score.fractionalCredit.toFixed(10)) : '',
            scoreContribution: Number.isFinite(score.contribution) ? Number(score.contribution.toFixed(10)) : 0,
            scoreEligible: score.eligible === true,
            exclusionReason: score.eligible === true ? '' : (score.exclusionReason || ''),
            scholarUrl: info?.url || '',
            decisionStatus: info?.decisionStatus || '',
            reason: info?.reason || getReviewReason(info),
            matchedVenue: info?.matchedVenue || '',
            dblpVenue: info?.dblpVenue || '',
            confidence: typeof info?.confidence === 'number' ? Number(info.confidence.toFixed(4)) : '',
            decisionEvidence: getDecisionEvidenceTokens(info).join('; '),
            statusReasonCode: scored?.status || '',
        };
    });
}
function csvEscape(value) {
    const raw = value == null ? '' : String(value);
    if (/[,"\n]/.test(raw)) {
        return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
}
function buildCsvExport(summaryState) {
    const rows = buildExportRows(summaryState);
    const headers = ['title', 'year', 'dblpKey', 'publicationType', 'rankSource', 'rank', 'rankingSnapshotYear', 'authorCount', 'authorshipStatus', 'authorPosition', 'authorRoles', 'authorshipSource', 'venueValue', 'fractionalCredit', 'scoreContribution', 'scoreEligible', 'exclusionReason'];
    const lines = [headers.join(',')];
    for (const row of rows) {
        lines.push(headers.map((header) => csvEscape(row[header])).join(','));
    }
    return lines.join('\n');
}
function buildCanonicalProfileReport(summaryState) {
    const scoreState = summaryState?.venueProfileIndex || summaryState?.facultyScore || buildFacultyScoreState(summaryState?.publicationRanks || []);
    const rawProfileScore = scoreState.rawProfileScore || (SCORE_MODEL_API?.computeProfileScore
        ? SCORE_MODEL_API.computeProfileScore(summaryState?.publicationRanks || [], DEFAULT_SCORE_CONFIG || undefined)
        : null);
    const sensitivityResult = SCORE_SENSITIVITY_API?.runSensitivity
        ? SCORE_SENSITIVITY_API.runSensitivity(summaryState?.publicationRanks || [], DEFAULT_SCORE_CONFIG || undefined)
        : null;
    const compactSensitivityScore = (score) => score ? ({
        scores: score.scores || null,
        diagnostics: score.diagnostics || null,
        completeness: score.completeness || null,
        gsvrScore: score.scores?.gsvrScore ?? score.gsvrScore ?? 0,
    }) : null;
    const sensitivity = sensitivityResult ? {
        primary: compactSensitivityScore(sensitivityResult.primary),
        variants: (sensitivityResult.variants || []).map((variant) => ({
            name: variant.name,
            score: compactSensitivityScore(variant.score),
            delta: variant.delta,
            changedItems: variant.changedItems,
            explanation: variant.explanation,
        })),
        stability: sensitivityResult.stability || null,
    } : null;
    const scoredPublications = rawProfileScore?.publications || [];
    const publications = (summaryState?.publicationRanks || []).map((info, index) => {
        const scored = scoredPublications[index] || (SCORE_MODEL_API?.computePublicationScore
            ? SCORE_MODEL_API.computePublicationScore(info, DEFAULT_SCORE_CONFIG || undefined)
            : null);
        const authorship = normalizePublicationAuthorship(info?.authorship, scored?.score?.authorCount ?? info?.authorCount ?? null);
        const payload = {
            scholar: {
                title: getPaperTitle(info),
                year: getPublicationYear(info),
                url: info?.url || null,
                venueText: info?.scholarVenue || null,
                authorsText: info?.authorsText || null,
            },
            dblp: {
                status: info?.system === 'DBLP' ? 'missing' : 'verified',
                pid: summaryState?.context?.dblpAuthorPid || null,
                key: info?.dblpKey || null,
                title: info?.dblpTitle || null,
                year: info?.dblpYear || null,
                venue: info?.dblpVenue || null,
                venueFull: info?.dblpVenueFull || null,
                type: info?.dblpType || null,
                pages: info?.pages || null,
                authorCount: info?.authorCount ?? null,
                authors: Array.isArray(info?.authors) ? info.authors : [],
            },
            authorship,
            match: {
                status: info?.decisionStatus || null,
                probability: scored?.match?.probability ?? info?.matchConfidence ?? info?.confidence ?? null,
                rawSimilarity: info?.rawSimilarity ?? null,
                candidateGap: info?.candidateGap ?? null,
                topCandidates: getTopCandidates(info),
                evidence: getDecisionEvidenceTokens(info),
            },
            classification: {
                publicationType: scored?.classification?.publicationType ?? null,
                scoreEligibleByType: scored?.classification?.scoreEligibleByType ?? null,
                typeExclusionReason: scored?.classification?.typeExclusionReason ?? null,
                signals: Array.isArray(scored?.classification?.signals) ? scored.classification.signals : [],
            },
            ranking: {
                source: scored?.ranking?.source || info?.system || null,
                rankingSnapshotYear: scored?.ranking?.rankingSnapshotYear ?? info?.sourceYear ?? null,
                rank: scored?.ranking?.rank || info?.rank || null,
                matchedVenue: info?.matchedVenue || info?.dblpVenue || null,
                confidence: info?.venueMatchConfidence ?? info?.confidence ?? null,
            },
            score: {
                eligible: scored?.score?.eligible === true,
                exclusionReason: scored?.score?.exclusionReason ?? null,
                venueValue: scored?.score?.venueValue ?? null,
                authorCount: scored?.score?.authorCount ?? null,
                fractionalCredit: scored?.score?.fractionalCredit ?? null,
                contribution: scored?.score?.contribution ?? 0,
                rankSource: scored?.score?.rankSource ?? null,
                rank: scored?.score?.rank ?? null,
                rankingSnapshotYear: scored?.score?.rankingSnapshotYear ?? info?.sourceYear ?? null,
            },
        };
        return REPORT_SCHEMA_API?.buildPublicationDecision ? REPORT_SCHEMA_API.buildPublicationDecision(payload) : payload;
    });
    const diagnostics = rawProfileScore?.diagnostics || scoreState.diagnostics || scoreState.coverage || {};
    const scores = rawProfileScore?.scores || {
        gsvrScore: scoreState.gsvrScore || scoreState.totalScore || 0,
        coreContribution: scoreState.coreContribution || 0,
        sjrContribution: scoreState.sjrContribution || 0,
        eligibleRankedPublications: scoreState.eligibleRankedPublications || scoreState.countedPapers || 0,
        fractionalPublicationWeight: scoreState.fractionalPublicationWeight || 0,
        averageVenueValue: scoreState.averageVenueValue || 0,
    };
    const completeness = normalizeScoringCompleteness(rawProfileScore?.completeness || scoreState.completeness, diagnostics, scores, summaryState?.publicationRanks || []);
    const fullTimelineState = buildTimelineViewState(summaryState?.allPublicationRanks || summaryState?.publicationRanks || [], 'full');
    const fullFocusedHistograms = getTimelineFocusedHistograms(fullTimelineState, 'full');
    const reportPayload = {
        scoreModelVersion: scoreState.scoreModelVersion || SCORE_MODEL_VERSION,
        decisionVersion: DECISION_VERSION,
        generatedAt: new Date().toISOString(),
        scholarProfile: {
            userId: summaryState?.context?.userId || null,
            name: summaryState?.context?.authorName || null,
            url: summaryState?.context?.scholarProfileUrl || window.location?.href || null,
        },
        dblpProfile: {
            pid: summaryState?.context?.dblpAuthorPid || null,
            name: summaryState?.context?.authorName || null,
            confidence: null,
        },
        settings: {
            scoringMode: 'fractional_venue_score',
            authorshipModel: 'fractional_counting',
            publicationTypePolicy: 'full_papers_only',
            rankingPacks: currentRankingPacks.slice(),
        },
        scoringPolicy: rawProfileScore?.scoringPolicy || SCORE_CONFIG_API?.getScoringPolicy?.(DEFAULT_SCORE_CONFIG || undefined) || {
            formula: 'sum(venueValue / authorCount)',
            authorship: 'fractional',
            eligiblePublicationTypes: ['full_conference', 'full_journal'],
            venueValues: DEFAULT_SCORE_CONFIG?.venueValues || {},
            fractionalCountingOnly: true,
        },
        diagnostics,
        completeness,
        scores: {
            ...scores,
            sensitivity,
        },
        metadata: {
            cache: buildExpectedCacheMetadata(),
            rateLimitEvents: [],
            timeline: {
                activeRange: summaryState?.timeline?.range || fullTimelineState.range,
                fullHistogram: fullTimelineState.fullHistogram || [],
                fullFocusedHistograms,
                allUnknownYearCount: fullTimelineState.allUnknownYearCount || 0,
            },
        },
        publications,
    };
    return REPORT_SCHEMA_API?.buildProfileReport ? REPORT_SCHEMA_API.buildProfileReport(reportPayload) : reportPayload;
}
function buildJsonExport(summaryState) {
    return JSON.stringify(buildCanonicalProfileReport(summaryState), null, 2);
}
function buildMarkdownExport(summaryState) {
    const rows = buildExportRows(summaryState);
    const report = buildCanonicalProfileReport(summaryState);
    const lines = [
        '# DBLP-Verified Venue Profile Report',
        '',
        `- Exported At: ${new Date().toISOString()}`,
        `- Surface: ${summaryState?.context?.surfaceMode || 'profile'}`,
        `- Author: ${summaryState?.context?.authorName || 'Unknown'}`,
        `- Score Model: ${report.scoreModelVersion || SCORE_MODEL_VERSION}`,
        `- GSVR Score: ${Number(report.scores?.gsvrScore || 0).toFixed(4)}`,
        `- Scoring Completeness: ${formatCompletenessPercent(report.completeness)} (${Number(report.completeness?.scored || 0)}/${Number(report.completeness?.total || 0)} scored)`,
        `- Fractional Publication Weight: ${Number(report.scores?.fractionalPublicationWeight || 0).toFixed(4)}`,
        `- Eligible Ranked Publications: ${Number(report.scores?.eligibleRankedPublications || 0)}`,
        '',
        '| Title | Year | Source | Rank | Authorship | Position | Score Eligible | Exclusion Reason | Contribution |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const row of rows) {
        lines.push(`| ${String(row.title || '').replace(/\|/g, '\\|')} | ${row.year || ''} | ${row.rankSource} | ${row.rank} | ${row.authorRoles || ''} | ${row.authorPosition || ''} | ${row.scoreEligible} | ${String(row.exclusionReason || '').replace(/\|/g, '\\|')} | ${row.scoreContribution} |`);
    }
    return lines.join('\n');
}
function buildDownloadReportData(summaryState) {
    const rows = buildExportRows(summaryState);
    const facultyScore = summaryState?.venueProfileIndex || summaryState?.facultyScore || buildFacultyScoreState(summaryState?.publicationRanks || []);
    const countSnapshot = buildSummaryCountSnapshot(summaryState);
    const canonicalReport = buildCanonicalProfileReport(summaryState);
    const fullTimelineState = buildTimelineViewState(summaryState?.allPublicationRanks || summaryState?.publicationRanks || [], 'full');
    const recentHistogram = summaryState?.timeline?.recentHistogram || [];
    const fullHistogram = fullTimelineState.fullHistogram || [];
    const recentFocusedHistograms = getTimelineFocusedHistograms(summaryState?.timeline || { recentHistogram }, 'recent');
    const fullFocusedHistograms = getTimelineFocusedHistograms(fullTimelineState, 'full');
    return {
        exportedAt: new Date().toISOString(),
        extensionVersion: chrome?.runtime?.getManifest?.().version || 'unknown',
        scoreModelVersion: canonicalReport.scoreModelVersion || SCORE_MODEL_VERSION,
        decisionVersion: canonicalReport.decisionVersion || DECISION_VERSION,
        context: summaryState?.context || null,
        counts: {
            conferences: { ...(summaryState?.coreRankCounts || createEmptyCoreRankCounts()) },
            journals: { ...(summaryState?.sjrRankCounts || createEmptySjrRankCounts()) },
            totalPapers: countSnapshot.totalPapers || rows.length,
            rankedCount: countSnapshot.rankedCount,
            reviewCount: countSnapshot.reviewCount,
            authorship: { ...(summaryState?.authorshipCounts || buildAuthorshipCounts(summaryState?.publicationRanks || [])) },
            diagnostics: canonicalReport.diagnostics || {},
            completeness: canonicalReport.completeness || {},
            byReasonCode: canonicalReport.diagnostics?.byReasonCode || {}
        },
        score: {
            gsvrScore: Number(facultyScore.gsvrScore || canonicalReport.scores?.gsvrScore || 0),
            totalScore: Number(facultyScore.gsvrScore || canonicalReport.scores?.gsvrScore || 0),
            eligibleRankedPublications: Number(facultyScore.eligibleRankedPublications || canonicalReport.scores?.eligibleRankedPublications || 0),
            countedPapers: Number(facultyScore.countedPapers || canonicalReport.scores?.eligibleRankedPublications || 0),
            fractionalPublicationWeight: Number(facultyScore.fractionalPublicationWeight || canonicalReport.scores?.fractionalPublicationWeight || 0),
            averageVenueValue: Number(facultyScore.averageVenueValue || canonicalReport.scores?.averageVenueValue || 0),
            coreContribution: Number(facultyScore.coreContribution || canonicalReport.scores?.coreContribution || 0),
            sjrContribution: Number(facultyScore.sjrContribution || canonicalReport.scores?.sjrContribution || 0),
            averageCreditPerPaper: Number(facultyScore.averageCreditPerPaper || 0),
            tierCredits: { ...(facultyScore.tierCredits || {}) },
            completeness: canonicalReport.completeness || facultyScore.completeness || {},
            scores: canonicalReport.scores || null
        },
        completeness: canonicalReport.completeness || facultyScore.completeness || {},
        timeline: {
            activeRange: summaryState?.timeline?.range || fullTimelineState.range,
            recentHistogram,
            fullHistogram,
            recentFocusedHistograms,
            fullFocusedHistograms,
            allUnknownYearCount: fullTimelineState.allUnknownYearCount || 0,
        },
        rows,
        canonicalReport,
        countedPublications: Array.isArray(facultyScore.countedPublications) ? facultyScore.countedPublications.map((item) => ({ ...item })) : []
    };
}
function buildHtmlReport(summaryState) {
    const report = buildDownloadReportData(summaryState);
    const authorName = escapeHtml(report.context?.authorName || 'Unknown');
    const heroMeta = `${authorName} | ${escapeHtml(report.context?.surfaceMode || 'profile')} | ${escapeHtml(report.exportedAt)} | DBLP ${escapeHtml(report.context?.dblpAuthorPid || 'N/A')}`;
    const summaryRows = [
        ['Exported', report.exportedAt],
        ['Extension', report.extensionVersion],
        ['Surface', report.context?.surfaceMode || 'profile'],
        ['DBLP PID', report.context?.dblpAuthorPid || 'N/A'],
        ['GSVR Score', report.score.gsvrScore.toFixed(4)],
        ['Scoring Completeness', `${formatCompletenessPercent(report.score.completeness)} (${Number(report.score.completeness?.scored || 0)}/${Number(report.score.completeness?.total || 0)} scored)`],
        ['Eligible Ranked Publications', String(report.score.eligibleRankedPublications)],
        ['Fractional Publication Weight', report.score.fractionalPublicationWeight.toFixed(4)],
        ['Average Venue Value', report.score.averageVenueValue.toFixed(4)],
        ['CORE Contribution', report.score.coreContribution.toFixed(4)],
        ['SJR Contribution', report.score.sjrContribution.toFixed(4)]
    ].map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('');
    const tierRows = ['A*', 'A', 'B', 'C', 'Q1', 'Q2', 'Q3', 'Q4']
        .map((rank) => `<tr><th>${rank}</th><td>${Number(report.score.tierCredits?.[rank] || 0).toFixed(2)}</td></tr>`)
        .join('');
    const authorshipRows = [
        `<tr><th>First-author publications</th><td>${Number(report.counts.authorship?.first || 0)}</td></tr>`,
        `<tr><th>Last-author publications</th><td>${Number(report.counts.authorship?.last || 0)}</td></tr>`
    ].join('');
    const distributionRows = [
        ...['A*', 'A', 'B', 'C'].map((rank) => `<tr><th>Conference ${rank}</th><td>${Number(report.counts.conferences?.[rank] || 0)}</td></tr>`),
        ...['Q1', 'Q2', 'Q3', 'Q4'].map((rank) => `<tr><th>Journal ${rank}</th><td>${Number(report.counts.journals?.[rank] || 0)}</td></tr>`),
        `<tr><th>Ranked Total</th><td>${report.counts.rankedCount}</td></tr>`,
        `<tr><th>Unranked</th><td>${report.counts.reviewCount}</td></tr>`
    ].join('');
    const auditRows = report.rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.title)}</td>
        <td>${escapeHtml(row.year ?? '')}</td>
        <td>${escapeHtml(row.rankSource)}</td>
        <td>${escapeHtml(row.rank)}</td>
        <td>${escapeHtml(row.exclusionReason || '')}</td>
        <td>${escapeHtml(row.matchedVenue || row.dblpVenue || '')}</td>
        <td>${escapeHtml(row.authorCount || '')}</td>
        <td>${escapeHtml(row.authorRoles || '')}</td>
        <td>${escapeHtml(row.authorPosition || '')}</td>
        <td>${escapeHtml(row.venueValue || '')}</td>
        <td>${escapeHtml(row.fractionalCredit || '')}</td>
        <td>${escapeHtml(row.scoreContribution ?? '')}</td>
      </tr>`).join('');
    const evidenceRows = report.rows.map((row) => `
      <tr>
        <td>${escapeHtml(row.title)}</td>
        <td>${escapeHtml(row.decisionStatus || '')}</td>
        <td>${escapeHtml(row.matchedVenue || row.dblpVenue || '')}</td>
        <td>${escapeHtml(row.dblpKey || '')}</td>
        <td>${escapeHtml(row.rankingSnapshotYear || '')}</td>
        <td>${escapeHtml(row.confidence || '')}</td>
        <td>${escapeHtml(row.authorCount || '')}</td>
        <td>${escapeHtml(row.authorRoles || '')}</td>
        <td>${escapeHtml(row.authorPosition || '')}</td>
        <td>${escapeHtml(row.venueValue || '')}</td>
        <td>${escapeHtml(row.fractionalCredit || '')}</td>
        <td>${escapeHtml(row.scoreContribution ?? '')}</td>
        <td>${escapeHtml(row.decisionEvidence || '')}</td>
      </tr>`).join('');
    const fullTimelineHistogram = Array.isArray(report.timeline?.fullHistogram) ? report.timeline.fullHistogram : [];
    const fullFocusedHistograms = report.timeline?.fullFocusedHistograms || buildFocusedTimelineHistograms(fullTimelineHistogram);
    const renderTimelineLegend = (rankOrder) => rankOrder.map((rank) => `<span class="timeline-legend-item"><span class="timeline-legend-swatch timeline-segment-${escapeHtml(normalizeRankKey(rank))}"></span>${escapeHtml(rank)}</span>`).join('');
    const renderTimelineStrip = (histogram, rankOrder, emptyText) => {
        const buckets = Array.isArray(histogram) ? histogram : [];
        if (!buckets.length) {
            return `<div class="timeline-empty-state">${escapeHtml(emptyText)}</div>`;
        }
        const timelineMaxTotal = Math.max(1, ...buckets.map((bucket) => Number(bucket?.total) || 0));
        const columns = buckets.map((bucket) => {
            const total = Number(bucket?.total || 0);
            const details = rankOrder
                .map((rank) => `${rank}: ${Number(bucket?.ranks?.[rank] || 0)}`)
                .join(', ');
            const segments = rankOrder.slice().reverse().map((rank) => {
                const value = Number(bucket?.ranks?.[rank] || 0);
                if (!value) {
                    return '';
                }
                const height = Math.max(4, (value / timelineMaxTotal) * 100);
                return `<span class="timeline-segment timeline-segment-${escapeHtml(normalizeRankKey(rank))}" style="height:${Math.min(height, 100)}%" title="${escapeHtml(`${bucket.year} ${rank}: ${value}`)}"></span>`;
            }).join('');
            return `<div class="timeline-year-column" title="${escapeHtml(`${bucket.year}: ${total} (${details})`)}"><span class="timeline-count">${total}</span><div class="timeline-bar">${segments || '<span class="timeline-empty"></span>'}</div><span class="timeline-year"><span class="timeline-year-label">${escapeHtml(bucket.year)}</span></span></div>`;
        }).join('');
        return `<div class="timeline-strip" style="grid-template-columns:repeat(${Math.max(1, buckets.length)},minmax(0,1fr))">${columns}</div>`;
    };
    const topCoreTimelineStrip = renderTimelineStrip(fullFocusedHistograms.topCoreHistogram, getTopCoreHistogramRankOrder(), 'No known-year A*/A publications.');
    const q1TimelineStrip = renderTimelineStrip(fullFocusedHistograms.q1Histogram, getQ1HistogramRankOrder(), 'No known-year Q1 journal publications.');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>DBLP-Verified Venue Profile Report - ${authorName}</title>
  <style>
    body{font-family:Georgia,"Times New Roman",serif;margin:32px;color:#18263f;background:#fff}
    h1,h2,h3{margin:0 0 12px;color:#12356f}
    p{margin:0 0 12px;line-height:1.6}
    .meta{margin:14px 0 18px;color:#4a5e84}
    .hero{padding:18px 20px;border:1px solid #c9d7f2;border-radius:16px;background:linear-gradient(135deg,#eef4ff,#fff8e6);margin-bottom:22px}
    .hero-score{font-size:44px;font-weight:800;line-height:1;margin-top:8px}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:20px 0}
    .panel-stack{display:flex;flex-direction:column;gap:16px}
    .panel{border:1px solid #d8e2f5;border-radius:14px;padding:14px 16px}
    .grid>.panel,.panel-stack>.panel{margin-top:0}
    .timeline-grid{display:grid;grid-template-columns:1fr;gap:18px}
    .timeline-panel{break-inside:avoid;page-break-inside:avoid;border:1px solid #d8e2f5;border-radius:16px;padding:16px 18px;background:linear-gradient(180deg,#ffffff,#f8fbff);box-shadow:0 12px 28px rgba(23,49,95,.07)}
    .timeline-panel h3{font-size:18px;margin-bottom:8px}
    .timeline-strip{display:grid;align-items:end;gap:4px;min-height:224px;padding:18px 12px 10px;border:1px solid #dce7fa;border-radius:14px;background:linear-gradient(180deg,#fbfdff 0%,#f4f8ff 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.92)}
    .timeline-year-column{display:grid;grid-template-rows:16px 126px 64px;align-items:end;gap:4px;min-width:0}
    .timeline-count{display:block;color:#5e7297;font-size:9px;font-weight:800;line-height:1;text-align:center;white-space:nowrap}
    .timeline-bar{display:flex;flex-direction:column-reverse;justify-content:flex-start;height:126px;background:linear-gradient(180deg,#f0f5ff,#e6eefb);border-radius:7px 7px 4px 4px;overflow:hidden;box-shadow:inset 0 0 0 1px rgba(183,201,236,.72),inset 0 -12px 18px rgba(23,49,95,.04)}
    .timeline-empty{display:block;width:100%;height:4px;margin-top:auto;background:#cbd7ed}
    .timeline-segment{display:block;width:100%;min-height:2px}
    .timeline-year{display:flex;align-items:flex-start;justify-content:center;height:64px;overflow:visible;color:#53688f;font-size:9px;font-weight:800;line-height:1}
    .timeline-year-label{display:inline-block;writing-mode:vertical-rl;transform:rotate(180deg);white-space:nowrap}
    .timeline-empty-state{padding:44px 8px;border:1px solid #e2ebfb;border-radius:14px;background:#f7faff;color:#5e7297;font-size:12px;text-align:center}
    .timeline-segment-astar{background:#153064}.timeline-segment-a{background:#2f63d8}.timeline-segment-b{background:#7a9b21}.timeline-segment-c{background:#d97836}
    .timeline-segment-q1{background:#c08c12}.timeline-segment-q2{background:#1f9467}.timeline-segment-q3{background:#8ba728}.timeline-segment-q4{background:#d56f3d}
    .timeline-legend{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px;color:#4a5e84;font-size:11px}
    .timeline-legend-item{display:inline-flex;align-items:center;gap:4px}
    .timeline-legend-swatch{width:10px;height:10px;border-radius:2px;display:inline-block}
    table{width:100%;border-collapse:collapse;font-size:12px}
    th,td{border:1px solid #dbe4f5;padding:8px 9px;text-align:left;vertical-align:top}
    th{background:#f3f7ff;color:#12356f}
    section{margin-top:24px}
    .small{font-size:11px;color:#5e7297}
  </style>
</head>
<body>
  <div class="hero">
    <h1>DBLP-Verified Venue Profile Report</h1>
    <div class="meta">${heroMeta}</div>
    <div class="hero-score">${report.score.gsvrScore.toFixed(4)}</div>
  </div>
  <div class="grid">
    <section class="panel">
      <h2>Profile Summary</h2>
      <table><tbody>${summaryRows}</tbody></table>
    </section>
    <div class="panel-stack">
      <section class="panel">
        <h2>Fractional Venue Contribution Breakdown</h2>
        <table><tbody>${tierRows}</tbody></table>
      </section>
      <section class="panel">
        <h2>First/Last Author Publications</h2>
        <table><tbody>${authorshipRows}</tbody></table>
        <p class="small">DBLP author order only; single-author papers are not counted here.</p>
      </section>
    </div>
  </div>
  <section>
    <h2>Rank Distribution</h2>
    <table><tbody>${distributionRows}</tbody></table>
  </section>
  <section>
    <h2>Full Timeline Highlights</h2>
    <div class="timeline-grid">
      <div class="timeline-panel">
        <h3>A*/A CORE Timeline</h3>
        <div class="timeline-legend">${renderTimelineLegend(getTopCoreHistogramRankOrder())}</div>
        ${topCoreTimelineStrip}
      </div>
      <div class="timeline-panel">
        <h3>Q1 Journal Timeline</h3>
        <div class="timeline-legend">${renderTimelineLegend(getQ1HistogramRankOrder())}</div>
        ${q1TimelineStrip}
      </div>
    </div>
  </section>
  <section>
    <h2>Full Audit</h2>
    <table>
      <thead><tr><th>Title</th><th>Year</th><th>Source</th><th>Rank</th><th>Exclusion Reason</th><th>Venue</th><th>Authors</th><th>Authorship</th><th>Position</th><th>Venue Value</th><th>Fractional Credit</th><th>Contribution</th></tr></thead>
      <tbody>${auditRows}</tbody>
    </table>
  </section>
  <section>
    <h2>Evidence Appendix</h2>
    <table>
      <thead><tr><th>Title</th><th>Status</th><th>Matched Venue</th><th>DBLP Key</th><th>Ranking Snapshot Year</th><th>Confidence</th><th>Authors</th><th>Authorship</th><th>Position</th><th>Venue Value</th><th>Fractional Credit</th><th>Contribution</th><th>Decision Evidence</th></tr></thead>
      <tbody>${evidenceRows}</tbody>
    </table>
  </section>
  <p class="small">The GSVR Score is a raw fractional venue score: GSVR = sum(venueValue / authorCount) over eligible ranked publications.</p>
</body>
</html>`;
}
function buildPdfReportDefinition(summaryState, reportVariant = 'full') {
    const report = buildDownloadReportData(summaryState);
    const isSummaryReport = reportVariant === 'summary';
    const authorName = report.context?.authorName || 'Unknown';
    const exportedDate = new Date(report.exportedAt);
    const exportedLabel = Number.isNaN(exportedDate.getTime())
        ? report.exportedAt
        : exportedDate.toLocaleString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
        });
    const palette = {
        ink: '#17315f',
        inkMuted: '#5e7297',
        brand: '#2f63d8',
        brandDeep: '#153064',
        brandSoft: '#eef4ff',
        card: '#fbfcff',
        border: '#cfdcf7',
        borderSoft: '#e2ebfb',
        warm: '#fff4dc',
        warmDeep: '#e5b74f',
        positive: '#1d8f63',
        positiveSoft: '#e7f8f0',
        neutral: '#f4f7fd',
        neutralAlt: '#edf3ff',
        textSoft: '#6d7f9e'
    };
    const noBorderLayout = {
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 0,
        paddingBottom: () => 0
    };
    const cardLayout = {
        hLineWidth: () => 1,
        vLineWidth: () => 1,
        hLineColor: () => palette.border,
        vLineColor: () => palette.border,
        paddingLeft: () => 14,
        paddingRight: () => 14,
        paddingTop: () => 12,
        paddingBottom: () => 12
    };
    const summaryCardLayout = {
        hLineWidth: () => 1,
        vLineWidth: () => 1,
        hLineColor: () => palette.border,
        vLineColor: () => palette.border,
        paddingLeft: () => 10,
        paddingRight: () => 10,
        paddingTop: () => 9,
        paddingBottom: () => 9
    };
    const compactTableLayout = {
        hLineWidth: (index, node) => (index === 0 || index === node.table.body.length ? 0 : 1),
        vLineWidth: () => 0,
        hLineColor: () => palette.borderSoft,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 6,
        paddingBottom: () => 6
    };
    const summaryCompactTableLayout = {
        hLineWidth: (index, node) => (index === 0 || index === node.table.body.length ? 0 : 1),
        vLineWidth: () => 0,
        hLineColor: () => palette.borderSoft,
        paddingLeft: () => 0,
        paddingRight: () => 0,
        paddingTop: () => 4,
        paddingBottom: () => 4
    };
    const dataTableLayout = {
        hLineWidth: () => 1,
        vLineWidth: () => 1,
        hLineColor: () => palette.borderSoft,
        vLineColor: () => palette.borderSoft,
        paddingLeft: () => 7,
        paddingRight: () => 7,
        paddingTop: () => 6,
        paddingBottom: () => 6
    };
    const tierOrder = ['A*', 'A', 'B', 'C', 'Q1', 'Q2', 'Q3', 'Q4'];
    const tierWeights = VENUE_PROFILE_INDEX_WEIGHTS;
    const summaryTierAccents = {
        'A*': '#153064',
        'A': '#2f63d8',
        'B': '#779818',
        'C': '#d97836',
        'Q1': '#c08c12',
        'Q2': '#1f9467',
        'Q3': '#78981d',
        'Q4': '#d56f3d'
    };
    const summaryTierFills = {
        'A*': '#eef3ff',
        'A': '#f2f7ff',
        'B': '#f5fae9',
        'C': '#fff3e9',
        'Q1': '#fff7df',
        'Q2': '#ecf9f2',
        'Q3': '#f6fae9',
        'Q4': '#fff1e6'
    };
    const summaryTable = [
        ['Exported', exportedLabel],
        ['Extension', report.extensionVersion],
        ['Surface', report.context?.surfaceMode || 'profile'],
        ['DBLP PID', report.context?.dblpAuthorPid || 'N/A'],
        ['GSVR Score', report.score.gsvrScore.toFixed(4)],
        ['Scoring Completeness', `${formatCompletenessPercent(report.score.completeness)} (${Number(report.score.completeness?.scored || 0)}/${Number(report.score.completeness?.total || 0)} scored)`],
        ['Eligible Ranked Publications', String(report.score.eligibleRankedPublications)],
        ['Fractional Publication Weight', report.score.fractionalPublicationWeight.toFixed(4)],
        ['Average Venue Value', report.score.averageVenueValue.toFixed(4)]
    ];
    const distributionTable = [
        ['Conference A*', Number(report.counts.conferences?.['A*'] || 0)],
        ['Conference A', Number(report.counts.conferences?.A || 0)],
        ['Conference B', Number(report.counts.conferences?.B || 0)],
        ['Conference C', Number(report.counts.conferences?.C || 0)],
        ['Journal Q1', Number(report.counts.journals?.Q1 || 0)],
        ['Journal Q2', Number(report.counts.journals?.Q2 || 0)],
        ['Journal Q3', Number(report.counts.journals?.Q3 || 0)],
        ['Journal Q4', Number(report.counts.journals?.Q4 || 0)],
        ['Ranked Total', report.counts.rankedCount],
        ['Unranked', report.counts.reviewCount]
    ];
    const authorshipPositionRows = [
        ['First-author publications', Number(report.counts.authorship?.first || 0)],
        ['Last-author publications', Number(report.counts.authorship?.last || 0)]
    ];
    function createKeyValueRows(rows) {
        return rows.map(([label, value]) => [
            { text: String(label), style: 'tableKey' },
            { text: String(value), style: 'tableValue', alignment: 'right' }
        ]);
    }
    function createSummaryKeyValueRows(rows) {
        return rows.map(([label, value]) => [
            { text: String(label), style: 'summaryTableKey' },
            { text: String(value), style: 'summaryTableValue', alignment: 'right' }
        ]);
    }
    function createAuthorshipPositionBody(compact = false) {
        return {
            stack: [
                {
                    table: {
                        widths: ['*', 'auto'],
                        body: compact ? createSummaryKeyValueRows(authorshipPositionRows) : createKeyValueRows(authorshipPositionRows)
                    },
                    layout: compact ? summaryCompactTableLayout : compactTableLayout
                },
                {
                    text: 'DBLP author order only; single-author papers are not counted here.',
                    style: compact ? 'summaryLegendTight' : 'metricNote',
                    margin: [0, compact ? 6 : 8, 0, 0]
                }
            ]
        };
    }
    function wrapCard(title, subtitle, bodyNode) {
        const cardStack = [
            { text: title, style: 'panelTitle' }
        ];
        if (subtitle) {
            cardStack.push({ text: subtitle, style: 'panelSubtitle', margin: [0, 4, 0, 12] });
        }
        cardStack.push(bodyNode);
        return {
            table: {
                widths: ['*'],
                body: [[{
                            stack: cardStack,
                            fillColor: palette.card,
                            border: [false, false, false, false]
                        }]]
            },
            layout: cardLayout
        };
    }
    function createSummaryCard(title, bodyNode, subtitle = null) {
        const cardStack = [
            { text: title, style: 'summaryPanelTitle' }
        ];
        if (subtitle) {
            cardStack.push({ text: subtitle, style: 'summaryPanelSubtitle', margin: [0, 3, 0, 8] });
        }
        cardStack.push(bodyNode);
        return {
            table: {
                widths: ['*'],
                body: [[{
                            stack: cardStack,
                            fillColor: palette.card,
                            border: [false, false, false, false]
                        }]]
            },
            layout: summaryCardLayout
        };
    }
    function createMetricCard(label, value, note, accent) {
        const stack = [
            { text: label, style: 'metricLabel' },
            { text: value, style: 'metricValue', color: accent || palette.ink }
        ];
        if (note) {
            stack.push({ text: note, style: 'metricNote' });
        }
        return {
            width: '*',
            table: {
                widths: ['*'],
                body: [[{
                            stack,
                            fillColor: palette.card,
                            border: [false, false, false, false]
                        }]]
            },
            layout: cardLayout
        };
    }
    function createSummaryMetricCard(label, value, accent, note = '') {
        const stack = [
            { text: label, style: 'summaryMetricLabel' },
            { text: value, style: 'summaryMetricValue', color: accent || palette.ink }
        ];
        if (note) {
            stack.push({ text: note, style: 'summaryMetricNote' });
        }
        return {
            width: '*',
            table: {
                widths: ['*'],
                body: [[{
                            stack,
                            fillColor: palette.card,
                            border: [false, false, false, false]
                        }]]
            },
            layout: summaryCardLayout
        };
    }
    function truncateSummaryText(text, maxLength = 72) {
        const normalized = String(text || '').replace(/\s+/g, ' ').trim();
        if (normalized.length <= maxLength) {
            return normalized;
        }
        return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
    }
    function createSummaryBreakdownTile(rank, value) {
        return {
            width: '*',
            table: {
                widths: ['*'],
                body: [[{
                            stack: [
                                { text: rank, style: 'summaryBreakdownRank', color: summaryTierAccents[rank] || palette.brandDeep },
                                { text: Number(value || 0).toFixed(2), style: 'summaryBreakdownValue', color: summaryTierAccents[rank] || palette.brandDeep }
                            ],
                            fillColor: summaryTierFills[rank] || palette.neutralAlt,
                            border: [false, false, false, false]
                        }]]
            },
            layout: summaryCardLayout
        };
    }
    function createSummaryLinkRow(label, url) {
        if (!url) {
            return null;
        }
        return {
            columns: [
                {
                    width: 'auto',
                    text: `${label}:`,
                    style: 'summaryLinkLabel',
                    margin: [0, 0, 6, 0]
                },
                {
                    width: '*',
                    text: url,
                    style: 'summaryLinkText',
                    link: url
                }
            ],
            columnGap: 0,
            margin: [0, 4, 0, 0]
        };
    }
    function createWeightTile(rank, value) {
        const isTopTier = rank === 'A*' || rank === 'A' || rank === 'Q1';
        const fillColor = isTopTier ? palette.brandSoft : palette.neutral;
        const valueColor = isTopTier ? palette.brandDeep : palette.ink;
        return {
            width: '*',
            table: {
                widths: ['*'],
                body: [[{
                            stack: [
                                { text: rank, style: 'weightRank' },
                                { text: Number(value).toFixed(2), style: 'weightValue', color: valueColor }
                            ],
                            fillColor,
                            border: [false, false, false, false]
                        }]]
            },
            layout: cardLayout
        };
    }
    function getRankColors(rank) {
        switch (rank) {
            case 'A*':
                return { fillColor: '#153f86', color: '#ffffff' };
            case 'A':
            case 'Q1':
                return { fillColor: '#2f63d8', color: '#ffffff' };
            case 'B':
            case 'Q2':
                return { fillColor: '#d9e6ff', color: '#183260' };
            case 'C':
            case 'Q3':
                return { fillColor: '#eef4ff', color: '#254478' };
            case 'Q4':
                return { fillColor: '#fff4dc', color: '#7a5b12' };
            default:
                return { fillColor: '#eef2fb', color: '#52688f' };
        }
    }
    function getSystemColors(system) {
        if (system === 'CORE') {
            return { fillColor: '#e9f1ff', color: '#17315f' };
        }
        if (system === 'SJR') {
            return { fillColor: '#e9f8f2', color: '#11664b' };
        }
        return { fillColor: '#f2f5fb', color: '#4d6387' };
    }
    function createTagCell(text, colors) {
        return {
            text: String(text || ''),
            fillColor: colors.fillColor,
            color: colors.color,
            alignment: 'center',
            bold: true,
            fontSize: 8,
            margin: [0, 2, 0, 0]
        };
    }
    function escapeSvgText(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }
    function createPdfFocusedTimelineChartSvg(histogram, rankOrder, { compact = false, emptyText = 'No known-year publications.' } = {}) {
        const buckets = Array.isArray(histogram) ? histogram : [];
        const ranks = Array.isArray(rankOrder) && rankOrder.length ? rankOrder : getHistogramRankOrder();
        const chartWidth = compact ? 500 : 498;
        const chartHeight = compact ? 174 : 188;
        const plotLeft = compact ? 14 : 16;
        const plotRight = compact ? 10 : 12;
        const plotTop = compact ? 22 : 24;
        const plotHeight = compact ? 92 : 104;
        const labelBaseline = plotTop + plotHeight + (compact ? 46 : 50);
        const axisY = plotTop + plotHeight;
        const plotWidth = chartWidth - plotLeft - plotRight;
        if (!buckets.length) {
            return {
                svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}"><rect x="0" y="0" width="${chartWidth}" height="${chartHeight}" rx="8" fill="#f7faff" stroke="#e2ebfb"/><text x="${chartWidth / 2}" y="${chartHeight / 2}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="${compact ? 7 : 8}" fill="#6d7f9e">${escapeSvgText(emptyText)}</text></svg>`,
                width: chartWidth,
                margin: [0, 2, 0, 0]
            };
        }
        const maxTotal = Math.max(1, ...buckets.map((bucket) => Number(bucket?.total) || 0));
        const columnWidth = plotWidth / Math.max(1, buckets.length);
        const barGap = buckets.length > 24 ? 1.2 : 2.4;
        const barWidth = Math.max(2.4, Math.min(compact ? 9 : 10, columnWidth - barGap));
        const parts = [
            `<svg xmlns="http://www.w3.org/2000/svg" width="${chartWidth}" height="${chartHeight}" viewBox="0 0 ${chartWidth} ${chartHeight}">`,
            `<rect x="0.5" y="0.5" width="${chartWidth - 1}" height="${chartHeight - 1}" rx="12" fill="#f8fbff" stroke="#dce7fa"/>`,
            `<line x1="${plotLeft}" y1="${plotTop + plotHeight * 0.25}" x2="${chartWidth - plotRight}" y2="${plotTop + plotHeight * 0.25}" stroke="#e7eefb" stroke-width="0.8"/>`,
            `<line x1="${plotLeft}" y1="${plotTop + plotHeight * 0.5}" x2="${chartWidth - plotRight}" y2="${plotTop + plotHeight * 0.5}" stroke="#e7eefb" stroke-width="0.8"/>`,
            `<line x1="${plotLeft}" y1="${plotTop + plotHeight * 0.75}" x2="${chartWidth - plotRight}" y2="${plotTop + plotHeight * 0.75}" stroke="#e7eefb" stroke-width="0.8"/>`,
            `<line x1="${plotLeft}" y1="${axisY}" x2="${chartWidth - plotRight}" y2="${axisY}" stroke="#c9d7f2" stroke-width="1.1"/>`,
            `<text x="${plotLeft}" y="${plotTop - 7}" font-family="Roboto, Arial, sans-serif" font-size="${compact ? 6 : 7}" fill="#6d7f9e">Max ${maxTotal}</text>`
        ];
        for (const [index, bucket] of buckets.entries()) {
            const x = plotLeft + index * columnWidth + (columnWidth - barWidth) / 2;
            let y = axisY;
            let rendered = false;
            for (const rank of ranks) {
                const value = Number(bucket?.ranks?.[rank] || 0);
                if (!value) {
                    continue;
                }
                const height = Math.max(1.4, (value / maxTotal) * plotHeight);
                y -= height;
                parts.push(`<rect x="${x.toFixed(2)}" y="${Math.max(plotTop, y).toFixed(2)}" width="${barWidth.toFixed(2)}" height="${Math.min(height, axisY - plotTop).toFixed(2)}" rx="2" fill="${getRankColors(rank).fillColor}"/><rect x="${x.toFixed(2)}" y="${Math.max(plotTop, y).toFixed(2)}" width="${barWidth.toFixed(2)}" height="1" rx="0.5" fill="#ffffff" opacity="0.28"/>`);
                rendered = true;
            }
            if (!rendered) {
                parts.push(`<rect x="${x.toFixed(2)}" y="${(axisY - 2.4).toFixed(2)}" width="${barWidth.toFixed(2)}" height="2.4" rx="1.2" fill="#cfdaee"/>`);
            }
            const total = Number(bucket?.total || 0);
            if (total > 0 && columnWidth >= 12) {
                parts.push(`<text x="${(x + barWidth / 2).toFixed(2)}" y="${Math.max(10, y - 4).toFixed(2)}" text-anchor="middle" font-family="Roboto, Arial, sans-serif" font-size="${compact ? 5.5 : 6.3}" font-weight="700" fill="#52688f">${total}</text>`);
            }
            const labelX = x + barWidth / 2;
            parts.push(`<text x="${labelX.toFixed(2)}" y="${labelBaseline}" text-anchor="start" font-family="Roboto, Arial, sans-serif" font-size="${compact ? 6.2 : 6.8}" font-weight="700" fill="#52688f" transform="rotate(-90 ${labelX.toFixed(2)} ${labelBaseline})">${escapeSvgText(bucket.year)}</text>`);
        }
        parts.push('</svg>');
        return {
            svg: parts.join(''),
            width: chartWidth,
            margin: [0, 2, 0, compact ? 2 : 4]
        };
    }
    function createPdfFocusedTimelineLegend(rankOrder, compact = false) {
        const ranks = Array.isArray(rankOrder) && rankOrder.length ? rankOrder : getHistogramRankOrder();
        return {
            columns: ranks.map((rank) => ({
                width: '*',
                columns: [
                    {
                        width: 8,
                        canvas: [{ type: 'rect', x: 0, y: 2, w: 7, h: 7, color: getRankColors(rank).fillColor }]
                    },
                    { width: '*', text: rank, style: compact ? 'summaryLegendTight' : 'metricNote' }
                ],
                columnGap: 3
            })),
            columnGap: compact ? 3 : 5,
            margin: [0, 0, 0, compact ? 6 : 8]
        };
    }
    function createPdfFocusedTimelineChart(title, histogram, rankOrder, { compact = false, label = 'Papers' } = {}) {
        return {
            unbreakable: true,
            stack: [
                { text: title, style: compact ? 'summarySubsectionTitle' : 'tableKey', margin: [0, 0, 0, 5] },
                createPdfFocusedTimelineLegend(rankOrder, compact),
                createPdfFocusedTimelineChartSvg(histogram, rankOrder, {
                    compact,
                    emptyText: `No known-year ${label.toLowerCase()}.`
                })
            ]
        };
    }
    function createPdfFocusedTimelineChartsNode({ compact = false } = {}) {
        const fullFocusedHistograms = report.timeline?.fullFocusedHistograms || buildFocusedTimelineHistograms(report.timeline?.fullHistogram || []);
        return {
            stack: [
                createPdfFocusedTimelineChart('A*/A CORE Timeline', fullFocusedHistograms.topCoreHistogram || [], getTopCoreHistogramRankOrder(), {
                    compact,
                    label: 'A*/A papers'
                }),
                {
                    margin: [0, compact ? 10 : 14, 0, 0],
                    stack: [
                        createPdfFocusedTimelineChart('Q1 Journal Timeline', fullFocusedHistograms.q1Histogram || [], getQ1HistogramRankOrder(), {
                            compact,
                            label: 'Q1 papers'
                        })
                    ]
                }
            ]
        };
    }
    const conferenceRankedTotal = (Number(report.counts.conferences?.['A*']) || 0)
        + (Number(report.counts.conferences?.A) || 0)
        + (Number(report.counts.conferences?.B) || 0)
        + (Number(report.counts.conferences?.C) || 0);
    const journalRankedTotal = (Number(report.counts.journals?.Q1) || 0)
        + (Number(report.counts.journals?.Q2) || 0)
        + (Number(report.counts.journals?.Q3) || 0)
        + (Number(report.counts.journals?.Q4) || 0);
    const conferenceDistributionRows = [
        ['A*', Number(report.counts.conferences?.['A*'] || 0)],
        ['A', Number(report.counts.conferences?.A || 0)],
        ['B', Number(report.counts.conferences?.B || 0)],
        ['C', Number(report.counts.conferences?.C || 0)],
        ['Conference Total', conferenceRankedTotal]
    ];
    const journalDistributionRows = [
        ['Q1', Number(report.counts.journals?.Q1 || 0)],
        ['Q2', Number(report.counts.journals?.Q2 || 0)],
        ['Q3', Number(report.counts.journals?.Q3 || 0)],
        ['Q4', Number(report.counts.journals?.Q4 || 0)],
        ['Journal Total', journalRankedTotal],
        ['Unranked', report.counts.reviewCount]
    ];
    const summaryContributorItems = report.countedPublications.slice(0, 5);
    const summaryContributorRows = summaryContributorItems.length > 0
        ? summaryContributorItems.map((item, index) => [
            {
                stack: [
                    { text: `#${index + 1} ${truncateSummaryText(item?.title || 'Untitled publication', 74)}`, style: 'summaryContributorTitle' },
                    {
                        text: `${item?.system || 'UNKNOWN'} ${item?.rank || 'N/A'} • ${truncateSummaryText(item?.venue || 'Unknown venue', 48)}`,
                        style: 'summaryContributorMeta',
                        margin: [0, 2, 0, 0]
                    }
                ],
                fillColor: index % 2 === 0 ? '#fbfcff' : '#f6f9ff',
                border: [false, false, false, false]
            },
            {
                stack: [
                    { text: 'Contribution', style: 'summaryContributorCreditLabel' },
                    { text: Number(item?.credit || 0).toFixed(2), style: 'summaryContributorCreditValue' }
                ],
                fillColor: index % 2 === 0 ? '#eef4ff' : '#e9f1ff',
                border: [false, false, false, false]
            }
        ])
        : [[
            {
                text: 'No ranked publications contributed to the score in this export.',
                style: 'summaryEmptyState',
                colSpan: 2,
                fillColor: palette.card,
                border: [false, false, false, false]
            },
            {}
        ]];
    const scholarProfileUrl = report.context?.scholarProfileUrl || (report.context?.userId ? `https://scholar.google.com/citations?user=${encodeURIComponent(report.context.userId)}` : '');
    const summaryContent = [
        {
            columns: [
                {
                    width: '*',
                    stack: [
                        { text: 'GSVR SUMMARY', style: 'summaryEyebrow' },
                        { text: authorName, style: 'summaryHeroAuthor', margin: [0, 4, 0, 0] },
                        { text: `Exported ${exportedLabel}`, style: 'summaryHeroMeta', margin: [0, 6, 0, 0] },
                        ...(scholarProfileUrl ? [createSummaryLinkRow('Google Scholar', scholarProfileUrl)] : [])
                    ],
                    margin: [0, 4, 0, 0]
                },
                {
                    width: 184,
                    table: {
                        widths: ['*'],
                        body: [[{
                                    stack: [
                                        { text: 'GSVR Score', style: 'summaryScoreLabel' },
                                        { text: report.score.gsvrScore.toFixed(4), style: 'summaryScoreValue' },
                                        { text: `${report.score.eligibleRankedPublications} eligible ranked publications`, style: 'summaryScoreMeta', margin: [0, 3, 0, 0] }
                                    ],
                                    fillColor: palette.brandDeep,
                                    border: [false, false, false, false]
                                }]]
                    },
                    layout: summaryCardLayout
                }
            ],
            columnGap: 12,
            margin: [0, 0, 0, 10]
        },
        {
            columns: [
                createSummaryMetricCard('Processed', String(report.counts.totalPapers), palette.brandDeep, 'All profile papers'),
                createSummaryMetricCard('Ranked', String(report.counts.rankedCount), palette.brand, 'CORE + SJR'),
                createSummaryMetricCard('Unranked', String(report.counts.reviewCount), '#c27a16', 'Not Applicable')
            ],
            columnGap: 8,
        margin: [0, 0, 0, 10]
        },
        {
            columns: [
                {
                    width: '*',
                    stack: [
                        createSummaryCard('Venue Distribution', {
                            stack: [
                                { text: 'Conference', style: 'summarySubsectionTitle', margin: [0, 0, 0, 5] },
                                {
                                    table: {
                                        widths: ['*', 'auto'],
                                        body: createSummaryKeyValueRows(conferenceDistributionRows)
                                    },
                                    layout: summaryCompactTableLayout,
                                    margin: [0, 0, 0, 8]
                                },
                                { text: 'Journal', style: 'summarySubsectionTitle', margin: [0, 0, 0, 5] },
                                {
                                    table: {
                                        widths: ['*', 'auto'],
                                        body: createSummaryKeyValueRows(journalDistributionRows)
                                    },
                                    layout: summaryCompactTableLayout
                                }
                            ]
                        })
                    ]
                },
                {
                    width: '*',
                    stack: [
                        createSummaryCard('Score Breakdown', {
                            stack: [
                                {
                                    columns: ['A*', 'A', 'B', 'C'].map((rank) => createSummaryBreakdownTile(rank, report.score.tierCredits?.[rank] || 0)),
                                    columnGap: 6,
                                    margin: [0, 0, 0, 6]
                                },
                                {
                                    columns: ['Q1', 'Q2', 'Q3', 'Q4'].map((rank) => createSummaryBreakdownTile(rank, report.score.tierCredits?.[rank] || 0)),
                                    columnGap: 6,
                                    margin: [0, 0, 0, 6]
                                },
                                { text: 'Contribution is venue value divided by DBLP author count.', style: 'summaryLegend', margin: [0, 0, 0, 3] },
                                { text: `Venue values: A*=${VENUE_PROFILE_INDEX_WEIGHTS['A*'].toFixed(2)} • A=${VENUE_PROFILE_INDEX_WEIGHTS.A.toFixed(2)} • B=${VENUE_PROFILE_INDEX_WEIGHTS.B.toFixed(2)} • C=${VENUE_PROFILE_INDEX_WEIGHTS.C.toFixed(2)} • Q1=${VENUE_PROFILE_INDEX_WEIGHTS.Q1.toFixed(2)} • Q2=${VENUE_PROFILE_INDEX_WEIGHTS.Q2.toFixed(2)} • Q3=${VENUE_PROFILE_INDEX_WEIGHTS.Q3.toFixed(2)} • Q4=${VENUE_PROFILE_INDEX_WEIGHTS.Q4.toFixed(2)}`, style: 'summaryLegendTight' }
                            ]
                        }),
                        {
                            ...createSummaryCard('First/Last Author Publications', createAuthorshipPositionBody(true)),
                            margin: [0, 10, 0, 0]
                        }
                    ]
                }
            ],
            columnGap: 10,
            margin: [0, 0, 0, 10]
        },
        createSummaryCard('Full Timeline Highlights', createPdfFocusedTimelineChartsNode({ compact: true }), 'A*/A CORE and Q1 journal papers across the complete dataset'),
        createSummaryCard('Top Contributors', {
            table: {
                widths: ['*', 56],
                body: summaryContributorRows
            },
            layout: summaryCompactTableLayout
                }, 'Highest contribution publications')
    ];
    function createAuditBody() {
        const header = [
            { text: 'Title', style: 'tableHeader' },
            { text: 'Year', style: 'tableHeader', alignment: 'center' },
            { text: 'Source', style: 'tableHeader', alignment: 'center' },
            { text: 'Rank', style: 'tableHeader', alignment: 'center' },
            { text: 'Exclusion Reason', style: 'tableHeader' },
            { text: 'Venue', style: 'tableHeader' },
            { text: 'Authors', style: 'tableHeader', alignment: 'center' },
            { text: 'Authorship', style: 'tableHeader', alignment: 'center' },
            { text: 'Pos.', style: 'tableHeader', alignment: 'center' },
            { text: 'Venue Value', style: 'tableHeader', alignment: 'center' },
            { text: 'Contribution', style: 'tableHeader', alignment: 'center' }
        ];
        const body = [header];
        report.rows.forEach((row, index) => {
            const fillColor = index % 2 === 0 ? '#fbfcff' : '#f4f8ff';
            body.push([
                { text: row.title || '', style: 'tableCell', fillColor },
                { text: row.year == null ? '' : String(row.year), style: 'tableCell', fillColor, alignment: 'center' },
                createTagCell(row.rankSource || '', getSystemColors(row.rankSource)),
                createTagCell(row.rank || '', getRankColors(row.rank)),
                { text: row.exclusionReason || '', style: 'tableCell', fillColor },
                { text: row.matchedVenue || row.dblpVenue || '', style: 'tableCell', fillColor },
                { text: row.authorCount == null ? '' : String(row.authorCount), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.authorRoles || '', style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.authorPosition == null ? '' : String(row.authorPosition), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.venueValue == null ? '' : String(row.venueValue), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.scoreContribution == null ? '' : String(row.scoreContribution), style: 'tableCell', fillColor, alignment: 'center' }
            ]);
        });
        return body;
    }
    function createEvidenceBody() {
        const header = [
            { text: 'Title', style: 'tableHeader' },
            { text: 'Status', style: 'tableHeader', alignment: 'center' },
            { text: 'Matched Venue', style: 'tableHeader' },
            { text: 'DBLP Key', style: 'tableHeader' },
            { text: 'Ranking Snapshot Year', style: 'tableHeader', alignment: 'center' },
            { text: 'Confidence', style: 'tableHeader', alignment: 'center' },
            { text: 'Authors', style: 'tableHeader', alignment: 'center' },
            { text: 'Authorship', style: 'tableHeader', alignment: 'center' },
            { text: 'Pos.', style: 'tableHeader', alignment: 'center' },
            { text: 'Venue Value', style: 'tableHeader', alignment: 'center' },
            { text: 'Contribution', style: 'tableHeader', alignment: 'center' },
            { text: 'Decision Evidence', style: 'tableHeader' }
        ];
        const body = [header];
        report.rows.forEach((row, index) => {
            const fillColor = index % 2 === 0 ? '#fbfcff' : '#f4f8ff';
            body.push([
                { text: row.title || '', style: 'tableCell', fillColor },
                { text: row.decisionStatus || '', style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.matchedVenue || row.dblpVenue || '', style: 'tableCell', fillColor },
                { text: row.dblpKey || '', style: 'tableCellMono', fillColor },
                { text: row.rankingSnapshotYear == null ? '' : String(row.rankingSnapshotYear), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.confidence == null ? '' : String(row.confidence), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.authorCount == null ? '' : String(row.authorCount), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.authorRoles || '', style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.authorPosition == null ? '' : String(row.authorPosition), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.venueValue == null ? '' : String(row.venueValue), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.scoreContribution == null ? '' : String(row.scoreContribution), style: 'tableCell', fillColor, alignment: 'center' },
                { text: row.decisionEvidence || '', style: 'tableCell', fillColor }
            ]);
        });
        return body;
    }
    function createContributionCard(item, index) {
        return {
            table: {
                widths: ['*'],
                body: [[{
                            stack: [
                                { text: `#${index} • ${item.system} ${item.rank}`, style: 'contributionEyebrow' },
                                { text: item.title || 'Untitled publication', style: 'contributionTitle', margin: [0, 6, 0, 6] },
                                { text: item.venue || 'Unknown venue', style: 'contributionVenue' },
                                {
                                    columns: [
                    { width: '*', text: `Venue value ${Number(item.weight || 0).toFixed(2)}`, style: 'contributionMeta' },
                    { width: '*', text: `Contribution ${Number(item.credit || 0).toFixed(2)}`, style: 'contributionMeta', alignment: 'center' },
                                        { width: '*', text: `${Number(item.authorCount || 0)} authors`, style: 'contributionMeta', alignment: 'right' }
                                    ],
                                    margin: [0, 10, 0, 0]
                                }
                            ],
                            fillColor: palette.card,
                            border: [false, false, false, false]
                        }]]
            },
            layout: cardLayout,
            margin: [0, 0, 0, 10]
        };
    }
    const contributionCards = report.countedPublications.slice(0, 6).map((item, index) => createContributionCard(item, index + 1));
    const leftCards = [];
    const rightCards = [];
    contributionCards.forEach((card, index) => {
        if (index % 2 === 0) {
            leftCards.push(card);
        }
        else {
            rightCards.push(card);
        }
    });
    const heroTextStack = [
        { text: isSummaryReport ? 'GSVR VENUE PROFILE SUMMARY' : 'DBLP-VERIFIED VENUE PROFILE REPORT', style: 'eyebrow' },
        { text: isSummaryReport ? 'Venue Profile Summary' : 'Venue Profile Report', style: 'heroTitle', margin: [0, 6, 0, 0] },
        { text: authorName, style: 'heroAuthor', margin: [0, 12, 0, 0] },
        {
            text: `${report.context?.surfaceMode || 'profile'} • Exported ${exportedLabel} • DBLP ${report.context?.dblpAuthorPid || 'N/A'}`,
            style: 'heroMeta',
            margin: [0, 8, 0, 0]
        }
    ];
    const heroLeadCell = {
        stack: heroTextStack,
        fillColor: palette.brandSoft,
        border: [false, false, false, false]
    };
    const fullContent = [
        {
            table: {
                widths: ['*', 180],
                body: [[
                        heroLeadCell,
                        {
                            stack: [
                                { text: 'GSVR Score', style: 'heroScoreLabel' },
                                { text: report.score.gsvrScore.toFixed(4), style: 'heroScoreValue' },
                                { text: `${report.score.eligibleRankedPublications} eligible ranked publications`, style: 'heroScoreMeta' },
                                { text: `${report.score.fractionalPublicationWeight.toFixed(4)} fractional publication weight`, style: 'heroScoreMeta', margin: [0, 4, 0, 0] }
                            ],
                            fillColor: palette.brandDeep,
                            border: [false, false, false, false]
                        }
                    ]]
            },
            layout: {
                ...noBorderLayout,
                paddingLeft: (index) => index === 0 ? 18 : 16,
                paddingRight: (index, node) => index === node.table.widths.length - 1 ? 16 : 18,
                paddingTop: () => 16,
                paddingBottom: () => 16
            },
            margin: [0, 0, 0, 16]
        },
        {
            columns: [
                createMetricCard('Total Papers', String(report.counts.totalPapers), `${report.counts.rankedCount} ranked`, palette.brand),
                createMetricCard('Unranked', String(report.counts.reviewCount), '', '#c27a16'),
                createMetricCard('Conference Count', String((Number(report.counts.conferences?.['A*']) || 0)
                    + (Number(report.counts.conferences?.A) || 0)
                    + (Number(report.counts.conferences?.B) || 0)
                    + (Number(report.counts.conferences?.C) || 0)), 'CORE-ranked papers', palette.ink),
                createMetricCard('Journal Count', String((Number(report.counts.journals?.Q1) || 0)
                    + (Number(report.counts.journals?.Q2) || 0)
                    + (Number(report.counts.journals?.Q3) || 0)
                    + (Number(report.counts.journals?.Q4) || 0)), 'SJR-ranked papers', palette.positive)
            ],
            columnGap: 10,
            margin: [0, 0, 0, 16]
        },
        {
            columns: [
                {
                    width: '*',
                    stack: [
                        wrapCard('Profile Snapshot', 'Audit context and score summary for this export.', {
                            table: { widths: ['*', 'auto'], body: createKeyValueRows(summaryTable) },
                            layout: compactTableLayout
                        })
                    ]
                },
                {
                    width: '*',
                    stack: [
                        wrapCard('Venue Distribution', 'Conference tiers, journal quartiles, and unranked rows counted in this report.', {
                            table: { widths: ['*', 'auto'], body: createKeyValueRows(distributionTable) },
                            layout: compactTableLayout
                        })
                    ]
                }
            ],
            columnGap: 14,
            margin: [0, 0, 0, 16]
        },
        wrapCard('Full Timeline Highlights', 'Annual A*/A CORE and Q1 journal counts across the complete dataset.', createPdfFocusedTimelineChartsNode({ compact: false })),
        wrapCard('Scoring Model', 'The primary score is raw, unbounded, and fractional.', {
            stack: [
                {
        text: 'Each scored publication contributes venue value divided by DBLP author count. Excluded and unranked publications remain visible in the audit.',
                    style: 'bodyCopy',
                    margin: [0, 0, 0, 12]
                },
                {
                    columns: tierOrder.slice(0, 4).map((rank) => createWeightTile(rank, tierWeights[rank] || 0)),
                    columnGap: 10,
                    margin: [0, 0, 0, 10]
                },
                {
                    columns: tierOrder.slice(4).map((rank) => createWeightTile(rank, tierWeights[rank] || 0)),
                    columnGap: 10
                }
            ]
        }),
        wrapCard('First/Last Author Publications', 'DBLP author-order summary for the verified profile PID.', createAuthorshipPositionBody(false)),
        {
            margin: [0, 16, 0, 0],
            stack: [
                { text: 'Top GSVR Contributions', style: 'sectionTitle' },
                { text: 'Highest-contribution ranked publications included in the GSVR Score.', style: 'sectionSubtitle', margin: [0, 4, 0, 12] },
                contributionCards.length > 0
                    ? {
                        columns: [
                            { width: '*', stack: leftCards },
                            { width: '*', stack: rightCards.length > 0 ? rightCards : [{ text: '', margin: [0, 0, 0, 0] }] }
                        ],
                        columnGap: 12
                    }
                    : { text: 'No ranked publications contributed to the GSVR Score in this export.', style: 'emptyState' }
            ]
        }
    ];
    if (!isSummaryReport) {
        fullContent.push({
            pageBreak: 'before',
            pageOrientation: 'landscape',
            stack: [
                { text: 'Full Audit', style: 'sectionTitle' },
                { text: 'Ranked and unranked publications with scoring columns for committee-style review.', style: 'sectionSubtitle', margin: [0, 4, 0, 12] },
                {
                    table: {
                        headerRows: 1,
                        widths: ['*', 34, 44, 34, 66, 96, 34, 50, 28, 40, 42],
                        body: createAuditBody()
                    },
                    layout: dataTableLayout,
                    fontSize: 8
                }
            ]
        }, {
            pageBreak: 'before',
            pageOrientation: 'landscape',
            stack: [
                { text: 'Evidence Appendix', style: 'sectionTitle' },
                { text: 'Decision metadata, matching confidence, and traceable evidence for every row.', style: 'sectionSubtitle', margin: [0, 4, 0, 12] },
                {
                    table: {
                        headerRows: 1,
                        widths: ['*', 48, 82, 72, 44, 42, 32, 48, 28, 38, 42, '*'],
                        body: createEvidenceBody()
                    },
                    layout: dataTableLayout,
                    fontSize: 8
                }
            ]
        });
    }
    fullContent.push({
        text: `The GSVR Score is a raw fractional venue score: GSVR = sum(venueValue / authorCount). Venue values are A*=${VENUE_PROFILE_INDEX_WEIGHTS['A*'].toFixed(2)}, A=${VENUE_PROFILE_INDEX_WEIGHTS.A.toFixed(2)}, B=${VENUE_PROFILE_INDEX_WEIGHTS.B.toFixed(2)}, C=${VENUE_PROFILE_INDEX_WEIGHTS.C.toFixed(2)}, Q1=${VENUE_PROFILE_INDEX_WEIGHTS.Q1.toFixed(2)}, Q2=${VENUE_PROFILE_INDEX_WEIGHTS.Q2.toFixed(2)}, Q3=${VENUE_PROFILE_INDEX_WEIGHTS.Q3.toFixed(2)}, and Q4=${VENUE_PROFILE_INDEX_WEIGHTS.Q4.toFixed(2)}.`,
        style: 'footnote',
        margin: [0, 14, 0, 0]
    });
    return {
        pageSize: 'A4',
        pageMargins: isSummaryReport ? [18, 18, 18, 18] : [24, 24, 24, 28],
        footer: isSummaryReport ? undefined : ((currentPage, pageCount) => ({
            margin: [24, 4, 24, 0],
            columns: [
                { text: `GSVR v${report.extensionVersion} • ${authorName}`, style: 'footerText' },
                { text: `Page ${currentPage} of ${pageCount}`, style: 'footerText', alignment: 'right' }
            ]
        })),
        content: isSummaryReport ? summaryContent : fullContent,
        styles: {
            eyebrow: { fontSize: 9, bold: true, color: palette.brand, characterSpacing: 1.1 },
            heroTitle: { fontSize: 22, bold: true, color: palette.brandDeep },
            heroAuthor: { fontSize: 14, bold: true, color: palette.ink },
            heroMeta: { fontSize: 9, color: palette.inkMuted },
            heroScoreLabel: { fontSize: 10, bold: true, color: '#dfe9ff', alignment: 'center' },
            heroScoreValue: { fontSize: 34, bold: true, color: '#ffffff', alignment: 'center', margin: [0, 8, 0, 8] },
            heroScoreMeta: { fontSize: 9, color: '#d9e4ff', alignment: 'center' },
            metricLabel: { fontSize: 9, bold: true, color: palette.inkMuted },
            metricValue: { fontSize: 20, bold: true, margin: [0, 6, 0, 4] },
            metricNote: { fontSize: 8, color: palette.textSoft },
            summaryEyebrow: { fontSize: 8, bold: true, color: palette.brand, characterSpacing: 0.9 },
            summaryHeroAuthor: { fontSize: 18, bold: true, color: palette.brandDeep },
            summaryHeroMeta: { fontSize: 8, color: palette.inkMuted },
            summaryScoreLabel: { fontSize: 9, bold: true, color: '#dfe9ff', alignment: 'center' },
            summaryScoreValue: { fontSize: 30, bold: true, color: '#ffffff', alignment: 'center', margin: [0, 6, 0, 6] },
            summaryScoreMeta: { fontSize: 8, color: '#d9e4ff', alignment: 'center' },
            summaryMetricLabel: { fontSize: 8, bold: true, color: palette.inkMuted },
            summaryMetricValue: { fontSize: 18, bold: true, margin: [0, 4, 0, 2] },
            summaryMetricNote: { fontSize: 7, color: palette.textSoft },
            summaryPanelTitle: { fontSize: 12, bold: true, color: palette.brandDeep },
            summaryPanelSubtitle: { fontSize: 8, color: palette.inkMuted },
            summarySubsectionTitle: { fontSize: 9, bold: true, color: palette.brandDeep },
            summaryTableKey: { fontSize: 8, bold: true, color: palette.ink },
            summaryTableValue: { fontSize: 8, color: palette.ink },
            summaryBodyCopy: { fontSize: 8.5, color: palette.ink, lineHeight: 1.2 },
            summaryLegend: { fontSize: 8, color: palette.inkMuted },
            summaryLegendTight: { fontSize: 7.2, color: palette.inkMuted, lineHeight: 1.1 },
            summaryLinkLabel: { fontSize: 7.4, bold: true, color: palette.brandDeep },
            summaryLinkText: { fontSize: 7.2, color: palette.brand, decoration: 'underline' },
            summaryBreakdownRank: { fontSize: 7.5, bold: true, alignment: 'center' },
            summaryBreakdownValue: { fontSize: 12, bold: true, alignment: 'center', margin: [0, 3, 0, 0] },
            summaryContributorTitle: { fontSize: 8.2, bold: true, color: palette.ink },
            summaryContributorMeta: { fontSize: 7.1, color: palette.inkMuted },
            summaryContributorCreditLabel: { fontSize: 6.5, bold: true, color: palette.inkMuted, alignment: 'center' },
            summaryContributorCreditValue: { fontSize: 12, bold: true, color: palette.brandDeep, alignment: 'center', margin: [0, 2, 0, 0] },
            summaryEmptyState: { fontSize: 8, italics: true, color: palette.textSoft },
            panelTitle: { fontSize: 13, bold: true, color: palette.brandDeep },
            panelSubtitle: { fontSize: 9, color: palette.inkMuted },
            sectionTitle: { fontSize: 15, bold: true, color: palette.brandDeep },
            sectionSubtitle: { fontSize: 9, color: palette.inkMuted },
            tableHeader: { fontSize: 8, bold: true, color: '#ffffff', fillColor: palette.brandDeep, margin: [0, 2, 0, 0] },
            tableKey: { fontSize: 9, bold: true, color: palette.ink },
            tableValue: { fontSize: 9, color: palette.ink },
            tableCell: { fontSize: 8, color: palette.ink },
            tableCellMono: { fontSize: 8, color: palette.inkMuted },
            weightRank: { fontSize: 10, bold: true, color: palette.brandDeep, alignment: 'center' },
            weightValue: { fontSize: 16, bold: true, alignment: 'center', margin: [0, 8, 0, 0] },
            contributionEyebrow: { fontSize: 8, bold: true, color: palette.brand },
            contributionTitle: { fontSize: 11, bold: true, color: palette.ink },
            contributionVenue: { fontSize: 9, color: palette.inkMuted },
            contributionMeta: { fontSize: 8, color: palette.textSoft },
            bodyCopy: { fontSize: 10, color: palette.ink, lineHeight: 1.35 },
            emptyState: { fontSize: 10, italics: true, color: palette.textSoft },
            footnote: { fontSize: 9, color: palette.inkMuted },
            footerText: { fontSize: 8, color: palette.textSoft }
        },
        defaultStyle: {
            fontSize: 10,
            color: palette.ink
        }
    };
}
// pdfmake (~2.2 MB with fonts) is loaded on demand the first time a PDF report
// is generated, instead of being parsed on every Scholar page load.
let pdfMakeLoadPromise = null;
function ensurePdfMakeLoaded() {
    if (typeof window !== 'undefined' && window.pdfMake?.createPdf) {
        return Promise.resolve(window.pdfMake);
    }
    if (!pdfMakeLoadPromise) {
        pdfMakeLoadPromise = (async () => {
            const pdfModule = await import(chrome.runtime.getURL('vendor/pdfmake.min.js'));
            if (!window.pdfMake?.createPdf) {
                // The UMD bundle normally attaches to self/window; fall back to
                // the module namespace if a future build stops doing that.
                const candidate = pdfModule?.pdfMake || pdfModule?.default;
                if (candidate?.createPdf) {
                    window.pdfMake = candidate;
                }
            }
            await import(chrome.runtime.getURL('vendor/vfs_fonts.js'));
            if (!window.pdfMake?.createPdf) {
                throw new Error('pdfMake failed to initialize after dynamic load.');
            }
            return window.pdfMake;
        })().catch((error) => {
            pdfMakeLoadPromise = null;
            throw error;
        });
    }
    return pdfMakeLoadPromise;
}
async function buildPdfReportDataUrl(summaryState, reportVariant = 'full') {
    const pdfMake = await ensurePdfMakeLoaded();
    const docDefinition = buildPdfReportDefinition(summaryState, reportVariant);
    return await new Promise((resolve, reject) => {
        let settled = false;
        const timeoutId = window.setTimeout(() => {
            if (settled) {
                return;
            }
            settled = true;
            reject(new Error(`PDF generation timed out for ${reportVariant} report.`));
        }, 15000);
        try {
            pdfMake.createPdf(docDefinition).getDataUrl((dataUrl) => {
                if (settled) {
                    return;
                }
                settled = true;
                window.clearTimeout(timeoutId);
                if (dataUrl) {
                    resolve(dataUrl);
                }
                else {
                    reject(new Error('PDF data URL was empty.'));
                }
            });
        }
        catch (error) {
            if (settled) {
                return;
            }
            settled = true;
            window.clearTimeout(timeoutId);
            reject(error);
        }
    });
}
function sanitizeFilenamePart(value) {
    const fallback = String(value || 'gsvr').trim();
    return fallback.replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'gsvr';
}
async function copyTextToClipboard(text) {
    if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'readonly');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
}
async function triggerDownload(filename, mimeType, content) {
    if (chrome?.runtime?.sendMessage) {
        try {
            const result = await chrome.runtime.sendMessage({
                type: 'GSVR_DOWNLOAD',
                filename,
                mimeType,
                content,
            });
            if (result?.ok) {
                return true;
            }
        }
        catch {
            // fall through to anchor download
        }
    }
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
}
async function triggerDataUrlDownload(filename, dataUrl) {
    if (chrome?.runtime?.sendMessage) {
        try {
            const result = await chrome.runtime.sendMessage({
                type: 'GSVR_DOWNLOAD',
                filename,
                dataUrl,
            });
            if (result?.ok) {
                return true;
            }
        }
        catch {
            // fall through to anchor download
        }
    }
    const anchor = document.createElement('a');
    anchor.href = dataUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
}
function buildReportPayload(info) {
    const payload = {
        createdAt: new Date().toISOString(),
        profile: {
            authorName: currentProfileContext.authorName,
            scholarUserId: currentProfileContext.userId,
            dblpAuthorPid: currentProfileContext.dblpAuthorPid,
            surfaceMode: currentProfileContext.surfaceMode,
        },
        paper: info ? {
            title: getPaperTitle(info),
            scholarUrl: info.url || null,
            publicationYear: getPublicationYear(info),
        } : null,
        decision: info ? {
            system: info.system || 'UNKNOWN',
            rank: info.rank || 'N/A',
            reason: info.reason || getReviewReason(info),
            decisionStatus: info.decisionStatus || null,
            matchedVenue: info.matchedVenue || null,
            dblpVenue: info.dblpVenue || null,
            sourceYear: info.sourceYear || null,
            confidence: info.confidence ?? null,
            matchConfidence: info.matchConfidence ?? null,
            venueMatchConfidence: info.venueMatchConfidence ?? null,
            decisionEvidence: getDecisionEvidenceTokens(info),
            topCandidates: getTopCandidates(info),
        } : null,
    };
    return payload;
}
function getCurrentSummaryFilenameBase() {
    const authorPart = sanitizeFilenamePart(currentProfileContext.authorName || currentProfileContext.userId || 'profile');
    const surfacePart = sanitizeFilenamePart(currentProfileContext.surfaceMode || 'profile');
    return `${authorPart}-${surfacePart}`;
}
function padFilenameDatePart(value) {
    return String(value).padStart(2, '0');
}
function formatFilenameTimestamp(date = new Date()) {
    const safeDate = date instanceof Date && Number.isFinite(date.getTime()) ? date : new Date();
    const datePart = [
        safeDate.getFullYear(),
        padFilenameDatePart(safeDate.getMonth() + 1),
        padFilenameDatePart(safeDate.getDate())
    ].join('-');
    const timePart = [
        padFilenameDatePart(safeDate.getHours()),
        padFilenameDatePart(safeDate.getMinutes()),
        padFilenameDatePart(safeDate.getSeconds())
    ].join('-');
    return { datePart, timePart };
}
function sanitizeReportFilenameName(value) {
    return String(value || 'profile')
        .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() || 'profile';
}
function getCurrentReportDownloadFilenameBase() {
    const authorName = currentSummaryState?.context?.authorName || currentProfileContext.authorName || currentSummaryState?.context?.userId || currentProfileContext.userId || 'profile';
    const fullName = sanitizeReportFilenameName(authorName);
    const { datePart, timePart } = formatFilenameTimestamp();
    return `${fullName}_${datePart}_${timePart}`;
}
function buildSnapshotFromSummary(summaryState) {
    if (!summaryState) {
        return null;
    }
    const counts = {
        aStar: Number(summaryState.coreRankCounts?.['A*']) || 0,
        a: Number(summaryState.coreRankCounts?.A) || 0,
        q1: Number(summaryState.sjrRankCounts?.Q1) || 0,
        review: Number(summaryState.insights?.reviewCount) || 0,
        ranked: Number(summaryState.insights?.rankedCount) || 0,
        total: Number(summaryState.insights?.totalPapers) || 0,
    };
    return {
        id: `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
        authorName: summaryState.context?.authorName || currentProfileContext.authorName || 'Unknown',
        userId: summaryState.context?.userId || currentProfileContext.userId || null,
        dblpAuthorPid: summaryState.context?.dblpAuthorPid || currentProfileContext.dblpAuthorPid || null,
        surfaceMode: summaryState.context?.surfaceMode || currentProfileContext.surfaceMode || 'profile',
        cacheTimestamp: summaryState.cacheTimestamp ?? null,
        coreRankCounts: { ...(summaryState.coreRankCounts || {}) },
        sjrRankCounts: { ...(summaryState.sjrRankCounts || {}) },
        dateRangeMode: summaryState.dateRangeMode || activeDateRangeMode,
        allPublicationRanks: Array.isArray(summaryState.allPublicationRanks) ? summaryState.allPublicationRanks.map((item) => ({ ...item })) : [],
        insights: summaryState.insights ? JSON.parse(JSON.stringify(summaryState.insights)) : null,
        publicationRanks: Array.isArray(summaryState.publicationRanks) ? summaryState.publicationRanks.map((item) => ({ ...item })) : [],
        counts,
    };
}
function buildSnapshotOptionLabel(snapshot) {
    if (!snapshot) {
        return 'Unknown snapshot';
    }
    const author = snapshot.authorName || 'Unknown';
    const when = formatTimestamp(snapshot.createdAt);
    return `${author} · ${when}`;
}
function getSnapshotMetric(summaryLike, key) {
    if (!summaryLike) {
        return 0;
    }
    if (key === 'rankedShare') {
        return Number(summaryLike.insights?.rankedShare) || 0;
    }
    if (key === 'aStarA') {
        return (Number(summaryLike.coreRankCounts?.['A*']) || 0) + (Number(summaryLike.coreRankCounts?.A) || 0);
    }
    if (key === 'q1') {
        return Number(summaryLike.sjrRankCounts?.Q1) || 0;
    }
    if (key === 'review') {
        return Number(summaryLike.insights?.reviewCount) || 0;
    }
    if (key === 'ranked') {
        return Number(summaryLike.insights?.rankedCount) || 0;
    }
    if (key === 'total') {
        return Number(summaryLike.insights?.totalPapers) || 0;
    }
    return 0;
}
function buildRankedVenueMap(summaryLike) {
    const map = new Map();
    for (const info of summaryLike?.publicationRanks || []) {
        if (!isRankedResultInfo(info)) {
            continue;
        }
        const key = String(info.matchedVenue || info.dblpVenue || info.rank || 'Unknown Venue').trim();
        if (!key) {
            continue;
        }
        map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
}
function buildComparisonSummary(leftSummary, rightSummary) {
    const metrics = [
        { key: 'total', label: 'Tracked Papers' },
        { key: 'ranked', label: 'Ranked Papers' },
        { key: 'rankedShare', label: 'Ranked Share' },
        { key: 'aStarA', label: 'A*/A Mix' },
        { key: 'q1', label: 'Q1 Mix' },
        { key: 'review', label: 'Review Backlog' },
    ].map((metric) => {
        const leftValue = getSnapshotMetric(leftSummary, metric.key);
        const rightValue = getSnapshotMetric(rightSummary, metric.key);
        return {
            ...metric,
            leftValue,
            rightValue,
            delta: typeof leftValue === 'number' && typeof rightValue === 'number'
                ? rightValue - leftValue
                : 0,
        };
    });
    const leftVenues = buildRankedVenueMap(leftSummary);
    const rightVenues = buildRankedVenueMap(rightSummary);
    const venueDelta = [];
    const allVenueNames = new Set([...leftVenues.keys(), ...rightVenues.keys()]);
    for (const venue of allVenueNames) {
        const leftCount = leftVenues.get(venue) || 0;
        const rightCount = rightVenues.get(venue) || 0;
        const delta = rightCount - leftCount;
        if (delta !== 0) {
            venueDelta.push({ venue, leftCount, rightCount, delta });
        }
    }
    venueDelta.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta) || left.venue.localeCompare(right.venue));
    return {
        metrics,
        venueDelta: venueDelta.slice(0, 8),
    };
}
async function saveCurrentProfileSnapshot() {
    if (!currentSummaryState) {
        return null;
    }
    const nextSnapshot = buildSnapshotFromSummary(currentSummaryState);
    if (!nextSnapshot) {
        return null;
    }
    const existing = await loadFeatureState('profileSnapshots');
    const snapshots = Array.isArray(existing) ? existing.slice(0, 11) : [];
    snapshots.unshift(nextSnapshot);
    await saveFeatureState('profileSnapshots', snapshots);
    return nextSnapshot;
}
function sortReviewItems(items, sortBy) {
    const list = Array.isArray(items) ? items.slice() : [];
    const getConfidenceValue = (info) => {
        if (typeof info?.confidence === 'number') {
            return info.confidence;
        }
        if (typeof info?.venueMatchConfidence === 'number') {
            return info.venueMatchConfidence;
        }
        if (typeof info?.matchConfidence === 'number') {
            return info.matchConfidence;
        }
        return -1;
    };
    list.sort((left, right) => {
        if (sortBy === 'year-desc') {
            return (getPublicationYear(right) || -1) - (getPublicationYear(left) || -1)
                || getPaperTitle(left).localeCompare(getPaperTitle(right));
        }
        if (sortBy === 'title') {
            return getPaperTitle(left).localeCompare(getPaperTitle(right))
                || (getPublicationYear(right) || -1) - (getPublicationYear(left) || -1);
        }
        if (sortBy === 'confidence') {
            return getConfidenceValue(right) - getConfidenceValue(left)
                || getPaperTitle(left).localeCompare(getPaperTitle(right));
        }
        return getReviewReason(left).localeCompare(getReviewReason(right))
            || (getPublicationYear(right) || -1) - (getPublicationYear(left) || -1)
            || getPaperTitle(left).localeCompare(getPaperTitle(right));
    });
    return list;
}
function setActiveDateRangeMode(nextMode) {
    const normalized = normalizeDateRangeMode(nextMode);
    if (normalized === activeDateRangeMode) {
        return;
    }
    const previousSummaryState = currentSummaryState;
    activeDateRangeMode = normalized;
    if (!previousSummaryState) {
        return;
    }
    const allPublicationRanks = previousSummaryState.allPublicationRanks || previousSummaryState.publicationRanks || [];
    displaySummaryPanel(
        previousSummaryState.allCoreRankCounts || previousSummaryState.coreRankCounts || createEmptyCoreRankCounts(),
        previousSummaryState.allSjrRankCounts || previousSummaryState.sjrRankCounts || createEmptySjrRankCounts(),
        previousSummaryState.context?.userId || currentProfileContext.userId,
        allPublicationRanks,
        previousSummaryState.cacheTimestamp,
        previousSummaryState.context?.dblpAuthorPid || currentProfileContext.dblpAuthorPid,
        previousSummaryState.scanLifecycle || null,
        previousSummaryState.context || currentProfileContext
    );
}
function createDateRangeToggle(summaryState) {
    const range = summaryState?.timeline?.range || buildTimelineViewState([], activeDateRangeMode).range;
    const currentYear = summaryState?.timeline?.currentYear || getTimelineCurrentYear();
    const last10Start = currentYear - 9;
    const activeMode = range.mode === 'last10' ? 'last10' : 'full';
    const toggleInstanceId = ++dateRangeToggleInstanceCounter;
    const inputName = `gsr-date-range-toggle-${toggleInstanceId}`;
    const control = document.createElement('div');
    control.className = 'gsr-date-range-toggle';
    control.dataset.gsrActiveDateRangeMode = activeMode;
    control.setAttribute('role', 'radiogroup');
    control.setAttribute('aria-label', 'Statistics date range');
    const options = [
        {
            mode: 'full',
            label: 'Full Timeline',
            title: 'Use the complete Scholar profile timeline for all statistics'
        },
        {
            mode: 'last10',
            label: 'Last 10 Years',
            title: `Use ${last10Start}-${currentYear} for all statistics`
        }
    ];
    const updateToggleVisualState = (nextMode) => {
        const normalizedMode = nextMode === 'last10' ? 'last10' : 'full';
        control.dataset.gsrActiveDateRangeMode = normalizedMode;
        control.querySelectorAll('.gsr-date-range-toggle__input').forEach((item) => {
            if (item instanceof HTMLInputElement) {
                item.checked = item.value === normalizedMode;
            }
        });
        control.querySelectorAll('.gsr-date-range-toggle__label').forEach((item) => {
            const isActive = item instanceof HTMLElement && item.dataset.gsrDateRangeMode === normalizedMode;
            item.classList.toggle('is-active', isActive);
        });
    };
    for (const option of options) {
        const input = document.createElement('input');
        input.type = 'radio';
        input.className = 'gsr-date-range-toggle__input';
        input.name = inputName;
        input.id = `${inputName}-${option.mode}`;
        input.value = option.mode;
        input.checked = activeMode === option.mode;
        input.addEventListener('change', () => {
            if (!input.checked || (control.dataset.gsrActiveDateRangeMode || 'full') === option.mode) {
                return;
            }
            updateToggleVisualState(option.mode);
            window.setTimeout(() => setActiveDateRangeMode(option.mode), 180);
        });
        control.appendChild(input);
    }
    for (const option of options) {
        const label = document.createElement('label');
        label.className = 'gsr-date-range-toggle__label';
        label.dataset.gsrDateRangeMode = option.mode;
        label.htmlFor = `${inputName}-${option.mode}`;
        label.textContent = option.label;
        label.title = option.title;
        label.classList.toggle('is-active', activeMode === option.mode);
        control.appendChild(label);
    }
    const slider = document.createElement('span');
    slider.className = 'gsr-date-range-toggle__slider';
    slider.setAttribute('aria-hidden', 'true');
    control.appendChild(slider);
    return control;
}
function getHistogramRankOrder() {
    return TIMELINE_STATS_API?.HISTOGRAM_RANKS || ['A*', 'A', 'B', 'C', 'Q1', 'Q2', 'Q3', 'Q4'];
}
function getTopCoreHistogramRankOrder() {
    return TIMELINE_STATS_API?.TOP_CORE_HISTOGRAM_RANKS || ['A*', 'A'];
}
function getQ1HistogramRankOrder() {
    return TIMELINE_STATS_API?.Q1_HISTOGRAM_RANKS || ['Q1'];
}
function buildFocusedTimelineHistogram(histogram, rankOrder) {
    const ranks = Array.isArray(rankOrder) ? rankOrder : [];
    return (Array.isArray(histogram) ? histogram : []).map((bucket) => {
        const focusedRanks = {};
        let total = 0;
        for (const rank of ranks) {
            const value = Number(bucket?.ranks?.[rank] || 0);
            focusedRanks[rank] = value;
            total += value;
        }
        return {
            year: bucket?.year,
            ranks: focusedRanks,
            total,
        };
    });
}
function buildFocusedTimelineHistograms(histogram) {
    if (TIMELINE_STATS_API?.buildFocusedHistograms) {
        return TIMELINE_STATS_API.buildFocusedHistograms(histogram);
    }
    return {
        topCoreHistogram: buildFocusedTimelineHistogram(histogram, getTopCoreHistogramRankOrder()),
        q1Histogram: buildFocusedTimelineHistogram(histogram, getQ1HistogramRankOrder()),
    };
}
function getTimelineFocusedHistograms(timelineState, scope = 'recent') {
    const normalizedScope = scope === 'full' ? 'full' : 'recent';
    const focused = timelineState?.focusedHistograms?.[normalizedScope];
    if (focused?.topCoreHistogram && focused?.q1Histogram) {
        return focused;
    }
    const histogram = normalizedScope === 'full'
        ? timelineState?.fullHistogram
        : timelineState?.recentHistogram;
    return buildFocusedTimelineHistograms(histogram || []);
}
function createCompactStaticRankBadge(rank, className = '') {
    const normalizedRank = String(rank || '').trim().toUpperCase();
    if (!normalizedRank)
        return null;
    const system = SJR_QUARTILES.includes(normalizedRank) ? 'SJR' : 'CORE';
    const badge = document.createElement('span');
    badge.className = `gsr-rank-badge gsr-rank-badge--static${className ? ` ${className}` : ''}`.trim();
    badge.dataset.gsrRank = normalizeRankKey(normalizedRank);
    badge.dataset.gsrSystem = system.toLowerCase();
    badge.textContent = normalizedRank;
    badge.setAttribute('aria-label', `${system} ${normalizedRank}`);
    if (system === 'SJR') {
        badge.classList.add('gsr-rank-badge--sjr', 'gsr-rank-badge--ranked', `gsr-rank-badge--${normalizedRank.toLowerCase()}`);
    }
    else {
        const rankKey = normalizeRankKey(normalizedRank);
        badge.classList.add('gsr-rank-badge--core', 'gsr-rank-badge--ranked', `gsr-rank-badge--${rankKey}`);
    }
    return badge;
}
function annotateScholarCitationYearChart(summaryState = currentSummaryState) {
    const citationPanel = document.querySelector('#gsc_rsb_cit');
    if (!citationPanel || !summaryState?.timeline) {
        return;
    }
    citationPanel.querySelectorAll('.gsr-scholar-year-rank-badges').forEach((node) => node.remove());
    const labels = Array.from(citationPanel.querySelectorAll('.gsc_g_t'));
    const bars = Array.from(citationPanel.querySelectorAll('.gsc_g_a'));
    const chartRoot = citationPanel.querySelector('#gsc_rsb_citb') || null;
    if (!labels.length) {
        return;
    }
    const badgeGutterPx = 18;
    if (chartRoot) {
        chartRoot.classList.add('gsr-scholar-year-chart--badged');
        chartRoot.style.setProperty('--gsr-scholar-year-badge-gutter', `${badgeGutterPx}px`);
    }
    [...bars, ...labels].forEach((node) => {
        if (node instanceof HTMLElement) {
            node.classList.add('gsr-scholar-year-chart__shifted-node');
            node.style.setProperty('--gsr-scholar-year-badge-gutter', `${badgeGutterPx}px`);
        }
    });
    const histogram = Array.isArray(summaryState.timeline.fullHistogram)
        ? summaryState.timeline.fullHistogram
        : buildTimelineViewState(summaryState.allPublicationRanks || summaryState.publicationRanks || [], 'full').fullHistogram;
    const byYear = new Map((histogram || []).map((bucket) => [String(bucket?.year || ''), bucket]));
    const ranks = getHistogramRankOrder();
    for (let index = 0; index < labels.length; index++) {
        const label = labels[index];
        const year = String(label.childNodes?.[0]?.textContent || label.textContent || '').trim().match(/\b(?:19|20)\d{2}\b/)?.[0] || '';
        const bucket = byYear.get(year);
        if (!year || !bucket?.ranks) {
            continue;
        }
        const presentRanks = ranks.filter((rank) => Number(bucket.ranks[rank] || 0) > 0);
        if (!presentRanks.length) {
            continue;
        }
        const badgeRow = document.createElement('span');
        badgeRow.className = 'gsr-scholar-year-rank-badges';
        badgeRow.dataset.gsrYear = year;
        for (const rank of presentRanks) {
            const badge = createCompactStaticRankBadge(rank, 'gsr-scholar-year-rank-badge');
            if (!badge)
                continue;
            const value = Number(bucket.ranks[rank] || 0);
            badge.title = `${year} ${rank}: ${value}`;
            badgeRow.appendChild(badge);
        }
        if (badgeRow.children.length) {
            const bar = bars[index] || null;
            if (bar) {
                badgeRow.style.left = '50%';
                badgeRow.style.top = '-4px';
                bar.appendChild(badgeRow);
            }
            else {
                label.appendChild(badgeRow);
            }
        }
    }
}
function scheduleScholarCitationYearChartAnnotation(summaryState = currentSummaryState) {
    annotateScholarCitationYearChart(summaryState);
    window.setTimeout(() => annotateScholarCitationYearChart(summaryState), 250);
    window.setTimeout(() => annotateScholarCitationYearChart(summaryState), 1000);
}
function createTimelineHistogramSection(histogram, { titleText, subtitleText, rankOrder, variant } = {}) {
    const buckets = Array.isArray(histogram) ? histogram : [];
    const ranks = Array.isArray(rankOrder) && rankOrder.length ? rankOrder : getHistogramRankOrder();
    const section = document.createElement('div');
    section.className = `gsr-timeline-histogram${variant ? ` gsr-timeline-histogram--${variant}` : ''}`;
    const header = document.createElement('div');
    header.className = 'gsr-timeline-histogram__header';
    const title = document.createElement('div');
    title.className = 'gsr-timeline-histogram__title';
    title.textContent = titleText || 'Yearly Timeline';
    header.appendChild(title);
    if (subtitleText) {
        const subtitle = document.createElement('span');
        subtitle.className = 'gsr-timeline-histogram__subtitle';
        subtitle.textContent = subtitleText;
        header.appendChild(subtitle);
    }
    section.appendChild(header);
    const maxTotal = Math.max(1, ...buckets.map((bucket) => Number(bucket?.total) || 0));
    const chart = document.createElement('div');
    chart.className = 'gsr-timeline-histogram__chart';
    const createTimelineRankBadge = (rank, className = 'gsr-timeline-histogram__legend-badge') => createCompactStaticRankBadge(rank, className);
    for (const bucket of buckets) {
        const column = document.createElement('div');
        column.className = 'gsr-timeline-histogram__column';
        const bar = document.createElement('div');
        bar.className = 'gsr-timeline-histogram__bar';
        bar.title = `${bucket.year}: ${Number(bucket.total || 0)} ranked paper${Number(bucket.total || 0) === 1 ? '' : 's'}`;
        const count = document.createElement('span');
        count.className = 'gsr-timeline-histogram__count';
        count.textContent = String(Number(bucket.total || 0));
        column.appendChild(count);
        for (const rank of ranks.slice().reverse()) {
            const value = Number(bucket?.ranks?.[rank] || 0);
            if (!value) {
                continue;
            }
            const segment = document.createElement('span');
            segment.className = 'gsr-timeline-histogram__segment';
            segment.dataset.gsrRank = normalizeRankKey(rank);
            segment.style.height = `${Math.max(4, (value / maxTotal) * 100)}%`;
            segment.title = `${bucket.year} ${rank}: ${value}`;
            bar.appendChild(segment);
        }
        if (!bar.children.length) {
            const empty = document.createElement('span');
            empty.className = 'gsr-timeline-histogram__empty';
            bar.appendChild(empty);
        }
        column.appendChild(bar);
        const yearLabel = document.createElement('span');
        yearLabel.className = 'gsr-timeline-histogram__year';
        const yearText = document.createElement('span');
        yearText.className = 'gsr-timeline-histogram__year-text';
        yearText.textContent = String(bucket.year);
        yearLabel.appendChild(yearText);
        const yearBadges = document.createElement('span');
        yearBadges.className = 'gsr-timeline-histogram__year-badges';
        for (const rank of ranks) {
            const value = Number(bucket?.ranks?.[rank] || 0);
            if (!value) {
                continue;
            }
            const badge = createTimelineRankBadge(rank, 'gsr-timeline-histogram__year-badge');
            badge.title = `${bucket.year} ${rank}: ${value}`;
            yearBadges.appendChild(badge);
        }
        if (yearBadges.children.length) {
            yearLabel.appendChild(yearBadges);
        }
        column.appendChild(yearLabel);
        chart.appendChild(column);
    }
    section.appendChild(chart);
    const legend = document.createElement('div');
    legend.className = 'gsr-timeline-histogram__legend';
    for (const rank of ranks) {
        const item = document.createElement('span');
        item.className = 'gsr-timeline-histogram__legend-item';
        item.appendChild(createTimelineRankBadge(rank));
        legend.appendChild(item);
    }
    section.appendChild(legend);
    return section;
}
function groupReviewItems(items, groupBy) {
    const source = Array.isArray(items) ? items : [];
    if (groupBy !== 'reason') {
        return [{ label: 'All Review Items', items: source }];
    }
    const groups = new Map();
    for (const item of source) {
        const reason = getReviewReason(item);
        if (!groups.has(reason)) {
            groups.set(reason, []);
        }
        groups.get(reason).push(item);
    }
    return Array.from(groups.entries())
        .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
        .map(([label, entries]) => ({ label, items: entries }));
}
async function buildDataFreshnessState(summaryState) {
    const manifestVersion = chrome?.runtime?.getManifest?.().version || 'unknown';
    const coreYears = ORDERED_CORE_DATA_FILES.map((value) => getCoreDatasetYear(value)).filter((value) => Number.isFinite(value));
    const sjrStartYear = SJR_DATASET_START_YEAR;
    const sjrEndYear = SJR_DATASET_END_YEAR;
    const freshness = {
        generatedAt: new Date().toISOString(),
        extensionVersion: manifestVersion,
        activePacks: currentRankingPacks.slice(),
        coreCoverageStart: coreYears.length ? Math.min(...coreYears) : null,
        coreCoverageEnd: coreYears.length ? Math.max(...coreYears) : null,
        coreCoverageYears: coreYears,
        sjrCoverageStart: sjrStartYear,
        sjrCoverageEnd: sjrEndYear,
        changelogNotes: CHANGELOG_NOTES.slice(),
        cacheTimestamp: summaryState?.cacheTimestamp ?? null,
        reviewReasons: (summaryState?.insights?.reviewReasons || []).map((entry) => ({ ...entry })),
        lastProfileRunAt: new Date().toISOString(),
        lastSeenVersion: manifestVersion,
        lastDataRefreshLabel: `CORE ${coreYears.length ? Math.max(...coreYears) : 'Unknown'} / SJR ${sjrEndYear || 'Unknown'}`,
        lastCoreDatasetYear: coreYears.length ? Math.max(...coreYears) : null,
        lastSjrDatasetYear: sjrEndYear || null,
        updatedAt: new Date().toISOString(),
        lastUserId: currentProfileContext.userId || null,
    };
    await saveFeatureState('dataFreshnessState', freshness);
    return freshness;
}
function getDialogFocusableElements(container) {
    return Array.from(container.querySelectorAll('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'))
        .filter((element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true');
}
function closeDialogOverlay(overlay, panel, { restoreFocus = true } = {}) {
    overlay.classList.remove('is-open');
    panel.setAttribute('aria-hidden', 'true');
    if (typeof overlay.__gsrOnClose === 'function') {
        try {
            overlay.__gsrOnClose();
        }
        catch (error) {
            console.warn('GSR: dialog onClose hook failed.', error);
        }
    }
    if (restoreFocus && gsrDialogLastFocusedEl instanceof HTMLElement) {
        gsrDialogLastFocusedEl.focus();
    }
}
function openDialogOverlay(overlay, panel, initialFocusSelector = '.gsr-icon-button, .gsr-button, button, a[href], input, select, textarea') {
    gsrDialogLastFocusedEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlay.classList.add('is-open');
    panel.setAttribute('aria-hidden', 'false');
    window.setTimeout(() => {
        const focusTarget = panel.querySelector(initialFocusSelector);
        if (focusTarget instanceof HTMLElement) {
            focusTarget.focus();
        }
    }, 0);
}
function createDialogOverlay({ overlayId, panelClass, titleId, titleText, descriptionId, descriptionText, onClose = null }) {
    const overlay = document.createElement('div');
    overlay.id = overlayId;
    if (typeof onClose === 'function') {
        overlay.__gsrOnClose = onClose;
    }
    overlay.className = 'search-utility-overlay gsr-dialog-overlay';
    const panel = document.createElement('div');
    panel.className = `gsr-dialog-panel ${panelClass}`.trim();
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', titleId);
    panel.setAttribute('aria-describedby', descriptionId);
    panel.setAttribute('aria-hidden', 'true');
    const header = document.createElement('div');
    header.className = 'gsr-search-panel__header gsr-dialog-panel__header';
    const titleGroup = document.createElement('div');
    titleGroup.className = 'gsr-dialog-panel__title-group';
    const title = document.createElement('h3');
    title.className = 'gsr-dialog-panel__title';
    title.id = titleId;
    title.textContent = titleText;
    titleGroup.appendChild(title);
    const description = document.createElement('p');
    description.id = descriptionId;
    description.className = 'gsr-search-panel__description gsr-dialog-panel__description';
    description.textContent = descriptionText;
    titleGroup.appendChild(description);
    header.appendChild(titleGroup);
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'gsr-icon-button gsr-dialog-panel__close';
    closeButton.setAttribute('aria-label', `Close ${titleText}`);
    closeButton.textContent = '×';
    header.appendChild(closeButton);
    panel.appendChild(header);
    const body = document.createElement('div');
    body.className = 'gsr-dialog-panel__body';
    panel.appendChild(body);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) {
            closeDialogOverlay(overlay, panel);
        }
    });
    closeButton.addEventListener('click', () => closeDialogOverlay(overlay, panel));
    panel.addEventListener('click', (event) => event.stopPropagation());
    panel.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            closeDialogOverlay(overlay, panel);
            return;
        }
        if (event.key === 'Tab') {
            const focusable = getDialogFocusableElements(panel);
            if (!focusable.length) {
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            }
            else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        }
    });
    document.body.appendChild(overlay);
    return { overlay, panel, body, closeButton, title, description };
}

// Wait until the Scholar publication table's row count stays stable for a short window.
// This reduces run-to-run variability caused by racing the UI rendering pipeline.
async function waitForStablePublicationRowCount(stableWindowMs = 350, timeoutMs = 5000) {
    const start = Date.now();
    let lastCount = -1;
    let lastChange = Date.now();
    while (Date.now() - start < timeoutMs) {
        const count = document.querySelectorAll('tr.gsc_a_tr').length;
        if (count !== lastCount) {
            lastCount = count;
            lastChange = Date.now();
        }
        else if (Date.now() - lastChange >= stableWindowMs) {
            return;
        }
        await new Promise(r => setTimeout(r, 80));
    }
}
async function expandAllPublications(statusElement) {
    const showMoreButtonId = 'gsc_bpf_more';
    const publicationsTableBodySelector = '#gsc_a_b';
    let attempts = 0;
    const maxAttempts = 30;
    const statusTextElement = statusElement?.querySelector('.gsr-status-text');
    while (attempts < maxAttempts) {
        const showMoreButton = document.getElementById(showMoreButtonId);
        if (!showMoreButton || showMoreButton.disabled) {
            if (statusTextElement && (statusTextElement.textContent || "").includes("Expanding")) {
                statusTextElement.textContent = "All publications loaded.";
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            break;
        }
        if (statusTextElement)
            statusTextElement.textContent = `Expanding publications... (click ${attempts + 1})`;
        const tableBody = document.querySelector(publicationsTableBodySelector);
        if (!tableBody) {
            if (statusTextElement)
                statusTextElement.textContent = "Error finding table.";
            break;
        }
        const contentLoadedPromise = new Promise((resolve) => {
            const observer = new MutationObserver((mutationsList, obs) => {
                for (const mutation of mutationsList) {
                    if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                        const newRows = Array.from(mutation.addedNodes).filter(node => node.nodeName === 'TR' && node.classList.contains('gsc_a_tr'));
                        if (newRows.length > 0) {
                            obs.disconnect();
                            resolve();
                            return;
                        }
                    }
                }
            });
            observer.observe(tableBody, { childList: true, subtree: false });
            showMoreButton.click();
            setTimeout(() => { observer.disconnect(); resolve(); }, 5000); // Timeout for click
        });
        await contentLoadedPromise;
        // Deterministic post-click wait: wait for the row count to settle.
        await waitForStablePublicationRowCount(350, 5000);
        attempts++;
    }
    if (attempts >= maxAttempts) {
        console.warn("Google Scholar Ranker: Reached max attempts for 'Show more'.");
        if (statusTextElement)
            statusTextElement.textContent = "Max expansion attempts.";
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}
// CORE evaluation rounds present in rankings.csv (newest first).
const CORE_DATASET_YEARS = [2026, 2023, 2021, 2020, 2018, 2017, 2014, 2013, 2010, 2008];
const ORDERED_CORE_DATA_FILES = CORE_DATASET_YEARS.map((year) => `CORE_${year}`);
function getCoreDataFileForYear(pubYear) {
    // Newest round when the year is unknown; otherwise the most recent round
    // at or before the publication year (clamped to the oldest round).
    if (pubYear == null) {
        return ORDERED_CORE_DATA_FILES[0];
    }
    const year = CORE_DATASET_YEARS.find((y) => pubYear >= y) ?? CORE_DATASET_YEARS[CORE_DATASET_YEARS.length - 1];
    return `CORE_${year}`;
}
function getCoreDatasetYear(coreDataFile) {
    const match = String(coreDataFile || '').match(/CORE_(\d{4})/i);
    return match ? parseInt(match[1], 10) : null;
}
function formatCoreStatusLabel(rawRankLabel) {
    const value = String(rawRankLabel || '').trim();
    if (!value)
        return null;
    return value.charAt(0).toUpperCase() + value.slice(1);
}
function buildConferenceSearchCandidates(venueQuery) {
    const query = String(venueQuery || '').trim();
    if (!query)
        return [];
    const candidates = [];
    const seen = new Set();
    const pushCandidate = (value) => {
        const trimmed = String(value || '').replace(/\s+/g, ' ').trim();
        if (!trimmed)
            return;
        const key = trimmed.toLowerCase();
        if (seen.has(key))
            return;
        seen.add(key);
        candidates.push(trimmed);
    };
    const addExpandedVariants = (value) => {
        pushCandidate(value);
        if (RANKING_UTILS?.canonicalizeCsrankingsVenueName) {
            pushCandidate(RANKING_UTILS.canonicalizeCsrankingsVenueName(value));
        }
        if (RANKING_UTILS?.expandVenueCandidates) {
            for (const variant of RANKING_UTILS.expandVenueCandidates(value)) {
                pushCandidate(variant);
            }
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
        default:
            return 1;
    }
}
function pickBetterConferenceSearchOutcome(currentBest, nextCandidate) {
    if (!currentBest)
        return nextCandidate;
    const statusDelta = getConferenceSearchStatusPriority(nextCandidate.status) - getConferenceSearchStatusPriority(currentBest.status);
    if (statusDelta !== 0)
        return statusDelta > 0 ? nextCandidate : currentBest;
    const matchDelta = getConferenceSearchMatchPriority(nextCandidate.matchType) - getConferenceSearchMatchPriority(currentBest.matchType);
    if (matchDelta !== 0)
        return matchDelta > 0 ? nextCandidate : currentBest;
    const nextConfidence = typeof nextCandidate.confidence === 'number' ? nextCandidate.confidence : -1;
    const currentConfidence = typeof currentBest.confidence === 'number' ? currentBest.confidence : -1;
    if (nextConfidence !== currentConfidence)
        return nextConfidence > currentConfidence ? nextCandidate : currentBest;
    const nextMatchedVenue = String(nextCandidate.matchedVenue || '');
    const currentMatchedVenue = String(currentBest.matchedVenue || '');
    if (nextMatchedVenue.length !== currentMatchedVenue.length)
        return nextMatchedVenue.length > currentMatchedVenue.length ? nextCandidate : currentBest;
    return currentBest;
}
async function searchConferenceInCoreFile(venueQuery, coreDataFile) {
    const coreData = await loadCoreDataForFile(coreDataFile);
    const datasetYear = getCoreDatasetYear(coreDataFile);
    const originalQuery = String(venueQuery || '').trim();
    let best = null;
    for (const candidate of buildConferenceSearchCandidates(originalQuery)) {
        const details = {};
        const resolvedRank = findRankForVenue(candidate, coreData, originalQuery, details);
        const outcome = {
            query: originalQuery,
            searchedCandidate: candidate,
            coreDataFile,
            sourceYear: datasetYear,
            rank: VALID_RANKS.includes(resolvedRank) ? resolvedRank : 'N/A',
            status: details.decisionStatus
                || (VALID_RANKS.includes(resolvedRank)
                    ? DECISION_STATUS.MATCHED
                    : (details.matchedVenue ? DECISION_STATUS.UNRANKED : DECISION_STATUS.MISSING)),
            matchedVenue: details.matchedVenue ?? null,
            confidence: (typeof details.venueMatchConfidence === 'number' ? details.venueMatchConfidence : null),
            matchedKey: details.matchedKey ?? null,
            matchType: details.matchType ?? null,
            rawRankLabel: details.rawRankLabel ?? null,
            decisionEvidence: details.decisionEvidence ?? null,
            topCandidates: details.topCandidates ?? null
        };
        best = pickBetterConferenceSearchOutcome(best, outcome);
        if (best?.status === DECISION_STATUS.MATCHED && best.matchType && best.matchType !== 'fuzzy') {
            break;
        }
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
        topCandidates: null
    };
}
async function resolveConferenceSearchQuery(venueQuery, yearVal) {
    const inferredYear = Number.isFinite(yearVal) ? yearVal : parseYearFromText(venueQuery);
    const primaryFile = getCoreDataFileForYear(inferredYear ?? null);
    const primary = await searchConferenceInCoreFile(venueQuery, primaryFile);
    let latestRankedSnapshot = null;
    const primaryYear = getCoreDatasetYear(primaryFile) ?? Number.POSITIVE_INFINITY;
    const fallbackFiles = ORDERED_CORE_DATA_FILES.filter((file) => file !== primaryFile && ((getCoreDatasetYear(file) ?? 0) < primaryYear));
    for (const fallbackFile of fallbackFiles) {
        const outcome = await searchConferenceInCoreFile(venueQuery, fallbackFile);
        if (outcome.status === DECISION_STATUS.MATCHED && VALID_RANKS.includes(outcome.rank)) {
            latestRankedSnapshot = outcome;
            break;
        }
    }
    return { primary, latestRankedSnapshot };
}
async function buildConferenceSearchHistory(venueQuery) {
    const history = [];
    for (const coreDataFile of ORDERED_CORE_DATA_FILES) {
        const outcome = await searchConferenceInCoreFile(venueQuery, coreDataFile);
        if (!outcome?.sourceYear) {
            continue;
        }
        history.push({
            sourceYear: outcome.sourceYear,
            rank: outcome.rank,
            status: outcome.status,
            matchedVenue: outcome.matchedVenue || null,
            rawRankLabel: outcome.rawRankLabel || null,
        });
    }
    return history
        .sort((left, right) => (right.sourceYear || 0) - (left.sourceYear || 0))
        .filter((entry, index, array) => array.findIndex((candidate) => candidate.sourceYear === entry.sourceYear) === index)
        .slice(0, 6);
}
async function buildJournalSearchHistory(journalName) {
    const history = [];
    for (let year = SJR_DATASET_END_YEAR; year >= SJR_DATASET_START_YEAR; year--) {
        const result = await resolveSjrQuartile(journalName, year);
        if (result.status === 'success' && result.quartile) {
            history.push({
                sourceYear: result.year || year,
                quartile: result.quartile,
                resolvedTitle: result.resolvedTitle || journalName,
            });
        }
    }
    return history
        .filter((entry, index, array) => array.findIndex((candidate) => candidate.sourceYear === entry.sourceYear) === index)
        .slice(0, 8);
}
function generateAcronymFromTitle(title) {
    if (!title)
        return "";
    const words = title.split(/[\s\-‑\/.,:;&]+/);
    let acronym = "";
    for (const word of words) {
        if (word.length > 0 && word[0] === word[0].toUpperCase() && /^[A-Za-z]/.test(word[0])) {
            acronym += word[0];
        }
        if (acronym.length >= 8)
            break;
    }
    return acronym.toUpperCase();
}
function normalizeCoreRawRankLabel(value) {
    const text = String(value || '').trim();
    if (!text)
        return null;
    const upper = text.toUpperCase();
    if (VALID_RANKS.includes(upper)) {
        return upper;
    }
    if (/\b(unranked|merged|journal|inactive|discontinued|ceased|not\s+ranked|removed|withdrawn|retired|suspended)\b/i.test(text)) {
        return text;
    }
    return null;
}
async function loadCoreDataForFile(coreDataFile) {
    if (coreDataCache[coreDataFile]) {
        if (!coreAliasIndexCache[coreDataFile] && RANKING_UTILS?.createCoreAliasIndex) {
            coreAliasIndexCache[coreDataFile] = RANKING_UTILS.createCoreAliasIndex(coreDataCache[coreDataFile]);
        }
        return coreDataCache[coreDataFile];
    }
    const year = getCoreDatasetYear(coreDataFile);
    const { coreByYear } = await loadRankingsData();
    const parsedData = coreByYear.get(year) || [];
    coreDataCache[coreDataFile] = parsedData;
    if (RANKING_UTILS?.createCoreAliasIndex) {
        coreAliasIndexCache[coreDataFile] = RANKING_UTILS.createCoreAliasIndex(parsedData);
    }
    return parsedData;
}
async function fetchVenueAndYear(publicationUrl) {
    let venueName = null, publicationYear = null, venueLabel = null, pdfUrl = null, doi = null;
    try {
        const response = await gsvrFetch(publicationUrl);
        if (!response.ok) {
            return { venueName, publicationYear, venueLabel, pdfUrl, doi };
        }
        const htmlText = await response.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(htmlText, 'text/html');

        const baseUrl = new URL(publicationUrl);

        const resolveHref = (href) => {
            if (!href) return null;
            try {
                return new URL(href, baseUrl).toString();
            } catch {
                return null;
            }
        };

        // Best-effort PDF link extraction (usually present for [PDF] versions).
        const pdfCandidates = [
            doc.querySelector('#gsc_oci_title_gg a'),
            doc.querySelector('.gsc_oci_title_gg a'),
            doc.querySelector('a.gsc_oci_title_gg'),
        ].filter(Boolean);

        for (const a of pdfCandidates) {
            const href = a?.getAttribute?.('href') || null;
            const resolved = resolveHref(href);
            if (resolved) { pdfUrl = resolved; break; }
        }

        if (!pdfUrl) {
            for (const a of Array.from(doc.querySelectorAll('a'))) {
                const href = a.getAttribute('href') || '';
                const text = (a.textContent || '').trim();
                const looksPdf = /\.pdf(\?|#|$)/i.test(href) || /\bpdf\b/i.test(text) || /scholar\.googleusercontent\.com/i.test(href);
                if (!looksPdf) continue;
                const resolved = resolveHref(href);
                if (resolved) { pdfUrl = resolved; break; }
            }
        }

        const targetLabels = ['journal', 'conference', 'proceedings', 'book title', 'series', 'source', 'publication', 'book'];
        const yearLabel = 'publication date';

        let foundInOci = false;
        const sectionsOci = doc.querySelectorAll('#gsc_oci_table div.gs_scl');
        if (sectionsOci.length > 0) {
            for (const section of sectionsOci) {
                const fieldEl = section.querySelector('div.gsc_oci_field'), valueEl = section.querySelector('div.gsc_oci_value');
                if (fieldEl && valueEl) {
                    const label = fieldEl.textContent?.trim().toLowerCase() || '';
                    const valueText = valueEl.textContent?.trim() || '';
                    if (!venueName && targetLabels.includes(label)) {
                        venueName = valueText || null;
                        venueLabel = label;
                        foundInOci = true;
                    }
                    if (!publicationYear && label === yearLabel) {
                        const yT = valueText.split('/')[0];
                        if (yT && /^\d{4}$/.test(yT)) publicationYear = parseInt(yT, 10);
                        foundInOci = true;
                    }
                    if (!doi && label === 'doi') {
                        doi = valueText || null;
                        foundInOci = true;
                    }
                }
                if (venueName && publicationYear && (doi !== null || true)) {
                    // don't break solely on doi; keep scanning quickly
                    // but venue+year is enough to stop.
                    if (venueName && publicationYear) break;
                }
            }
        }

        if (!venueName || !publicationYear || !foundInOci) {
            const rowsVcd = doc.querySelectorAll('#gsc_vcd_table tr');
            for (const row of rowsVcd) {
                const fieldEl = row.querySelector('td.gsc_vcd_field'), valueEl = row.querySelector('td.gsc_vcd_value');
                if (fieldEl && valueEl) {
                    const label = fieldEl.textContent?.trim().toLowerCase() || '';
                    const valueText = valueEl.textContent?.trim() || '';
                    if (!venueName && targetLabels.includes(label)) {
                        venueName = valueText || null;
                        venueLabel = label;
                    }
                    if (!publicationYear && label === yearLabel) {
                        const yT = valueText.split('/')[0];
                        if (yT && /^\d{4}$/.test(yT)) publicationYear = parseInt(yT, 10);
                    }
                    if (!doi && label === 'doi') {
                        doi = valueText || null;
                    }
                }
                if (venueName && publicationYear) break;
            }
        }
    }
    catch (error) {
        console.error(`Error fetching/parsing ${publicationUrl}:`, error);
    }
    return { venueName, publicationYear, venueLabel, pdfUrl, doi };
}
// Best-effort PDF page count extraction.
// Only attempts PDFs hosted on scholar.googleusercontent.com (allowed by host permissions).
async function tryGetPdfPageCount(pdfUrl) {
    if (!pdfUrl) return null;
    let urlObj;
    try { urlObj = new URL(pdfUrl); } catch { return null; }
    if (urlObj.hostname !== 'scholar.googleusercontent.com') return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    try {
        // Range request keeps this lightweight (not all servers honor Range; that's ok).
        const resp = await gsvrFetch(pdfUrl, {
            headers: { 'Range': 'bytes=0-2000000' },
            signal: controller.signal
        });
        if (!resp.ok) return null;
        const buf = await resp.arrayBuffer();
        const text = new TextDecoder('latin1').decode(buf);

        const m = text.match(/\/Type\s*\/Pages[\s\S]{0,250}\/Count\s+(\d+)/);
        if (m && m[1]) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n) && n > 0) return n;
        }
        const matches = text.match(/\/Type\s*\/Page\b/g);
        if (matches && matches.length > 0) return matches.length;
        return null;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timeout);
    }
}

function normalizeJournalName(name) {
    if (!name)
        return "";
    // Journal names coming from DBLP and Scholar are often abbreviated and may contain
    // volume/issue/year tokens. For SJR matching we want a *stable* representation that:
    //  - expands common abbreviations
    //  - strips numeric volume/issue/year tokens
    //  - removes low-signal stop words
    //  - lightly stems plural forms (networks->network, surveys->survey, etc.)
    let cleaned = cleanTextForComparison(name, true);
    if (!cleaned)
        return "";
    // Drop numeric/alphanumeric citation tokens (years, volumes, pages, article ids).
    cleaned = cleaned.replace(/\b\d{1,6}[a-z]\b/g, " ");
    cleaned = cleaned.replace(/\b\d{1,6}\b/g, " ");
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    if (!cleaned)
        return "";

    const STOP = new Set([
        'a', 'an', 'the', 'of', 'and', 'for', 'in', 'on', 'to', 'at',
        // Journal boilerplate terms
        'journal', 'international', 'transactions', 'letters'
    ]);

    const stem = (tok) => {
        // Simple stemming sufficient for venue name matching.
        if (tok.length <= 4)
            return tok;
        if (tok.endsWith('ies') && tok.length > 5)
            return tok.slice(0, -3) + 'y';
        if (tok.endsWith('sses'))
            return tok; // e.g., "processes" edge
        if (tok.endsWith('s') && !tok.endsWith('ss'))
            return tok.slice(0, -1);
        return tok;
    };

    const tokens = cleaned
        .split(' ')
        .map(t => t.trim())
        .filter(t => t.length > 0)
        .map(t => stem(t))
        .filter(t => t.length > 0 && !STOP.has(t));

    return tokens.join(' ').trim();
}
function generateJournalNormalizationVariants(name) {
    const base = normalizeJournalName(name);
    if (!base)
        return [];
    const variants = new Set([base]);
    if (/\bcomputer\b/.test(base)) {
        variants.add(base.replace(/\bcomputer\b/g, 'computing'));
    }
    if (/\bcomputing\b/.test(base)) {
        variants.add(base.replace(/\bcomputing\b/g, 'computer'));
    }
    // "ACM computer survey" vs "ACM computing survey"
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
function isArxivLikeVenue(info) {
    const key = info.dblpKey?.toLowerCase() ?? "";
    if (key.startsWith('journals/corr') || key.includes('/corr/')) {
        return true;
    }
    const candidates = [info.venue, info.venue_full, info.acronym];
    for (const candidate of candidates) {
        if (!candidate)
            continue;
        const normalized = normalizeJournalName(candidate);
        if (!normalized)
            continue;
        if (ARXIV_NORMALIZED_VALUES.has(normalized)) {
            return true;
        }
        const padded = ` ${normalized} `;
        for (const keyword of ARXIV_PLAIN_KEYWORDS) {
            if (padded.includes(keyword)) {
                return true;
            }
        }
    }
    return false;
}
function isPatentLikeVenue(value) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text)
        return false;
    return /\b(?:u\.?\s*s\.?|us|united\s+states|european|international|china|chinese|japan|japanese|korea|korean|wo|wipo)\s+patents?\b/i.test(text)
        || /\bpatents?\s+(?:no\.?\s*)?\d[\d,.\-/]*\b/i.test(text)
        || /\b(?:u\.?\s*s\.?|us)\s+\d[\d,.\-/]*\b/i.test(text) && /\bpatents?\b/i.test(text);
}
const SJR_DATASET_START_YEAR = 1999;
const SJR_DATASET_END_YEAR = 2025;
const sjrLookupCache = new Map();
const venueRankingDecisionCache = new Map();
const VENUE_RANKING_DECISION_CACHE_LIMIT = 5000;
let sjrDatasetPromise = null;
let rankingsDataPromise = null;
let rankingsDataWarmupStarted = false;
function createTokenIndexFromPacked(tokenToIndexesRows, tokenFrequencyRows) {
    const tokenToIndexes = new Map();
    for (const [token, indexes] of Array.isArray(tokenToIndexesRows) ? tokenToIndexesRows : []) {
        tokenToIndexes.set(String(token), new Set(Array.isArray(indexes) ? indexes.map(Number).filter(Number.isFinite) : []));
    }
    const tokenFrequency = new Map();
    for (const [token, count] of Array.isArray(tokenFrequencyRows) ? tokenFrequencyRows : []) {
        const numericCount = Number(count);
        if (Number.isFinite(numericCount))
            tokenFrequency.set(String(token), numericCount);
    }
    return { tokenToIndexes, tokenFrequency };
}
function hydrateRankingsWorkerPayload(payload) {
    const timer = gsvrTimingStart('hydrateRankingsWorkerPayload');
    const coreByYear = new Map();
    for (const [year, rows] of Array.isArray(payload?.coreByYear) ? payload.coreByYear : []) {
        const numericYear = Number(year);
        if (Number.isFinite(numericYear)) {
            coreByYear.set(numericYear, Array.isArray(rows) ? rows : []);
        }
    }
    const sjrEntries = (Array.isArray(payload?.sjrDataset?.entries) ? payload.sjrDataset.entries : [])
        .map((entry) => createSjrEntry(entry.normalizedTitle, entry.resolvedTitle, entry.quartileString, entry.quartileStartYear, {
        tokens: entry.tokenSet,
        issns: entry.issns,
        sourceId: entry.sourceId,
        coverage: entry.coverage
    }));
    const sjrByNormalized = new Map();
    for (const [normalized, index] of Array.isArray(payload?.sjrDataset?.byNormalized) ? payload.sjrDataset.byNormalized : []) {
        const entry = sjrEntries[Number(index)];
        if (entry)
            sjrByNormalized.set(String(normalized), entry);
    }
    const sjrDataset = {
        version: payload?.sjrDataset?.version ?? 1,
        startYear: payload?.sjrDataset?.startYear ?? SJR_DATASET_START_YEAR,
        endYear: payload?.sjrDataset?.endYear ?? SJR_DATASET_END_YEAR,
        byNormalized: sjrByNormalized,
        byIssn: new Map(),
        entries: sjrEntries,
        tokenIndex: createTokenIndexFromPacked(payload?.sjrDataset?.tokenIndex?.tokenToIndexes, payload?.sjrDataset?.tokenIndex?.tokenFrequency),
        tokenIndexPromise: null
    };
    const venueEntries = (Array.isArray(payload?.venueDataset?.entries) ? payload.venueDataset.entries : [])
        .map((entry, index) => ({
        index,
        id: String(entry.id || ''),
        type: String(entry.type || 'unknown'),
        title: String(entry.title || ''),
        shortName: String(entry.shortName || ''),
        aliases: Array.isArray(entry.aliases) ? entry.aliases.map(String) : [],
        normalizedAliases: Array.isArray(entry.normalizedAliases) ? entry.normalizedAliases.map(String).filter(Boolean) : [],
        flags: Array.isArray(entry.flags) ? entry.flags.map(String) : [],
        yearStart: Number.isFinite(entry.yearStart) ? entry.yearStart : null,
        yearEnd: Number.isFinite(entry.yearEnd) ? entry.yearEnd : null,
        count: Number.isFinite(entry.count) ? entry.count : 0,
        rankInfo: Array.isArray(entry.rankInfo) ? entry.rankInfo : null
    }));
    const byNormalized = new Map();
    for (const [normalized, indexes] of Array.isArray(payload?.venueDataset?.byNormalized) ? payload.venueDataset.byNormalized : []) {
        const matches = (Array.isArray(indexes) ? indexes : [indexes])
            .map(index => venueEntries[Number(index)])
            .filter(Boolean);
        if (matches.length)
            byNormalized.set(String(normalized), matches);
    }
    const venueDataset = {
        version: payload?.venueDataset?.version ?? 1,
        source: payload?.venueDataset?.source || null,
        entries: venueEntries,
        byNormalized,
        tokenIndex: createTokenIndexFromPacked(payload?.venueDataset?.tokenIndex?.tokenToIndexes, payload?.venueDataset?.tokenIndex?.tokenFrequency),
        tokenIndexPromise: null,
        available: venueEntries.length > 0
    };
    gsvrTimingEnd(timer, `(${sjrEntries.length} SJR entries, ${venueEntries.length} DBLP venues)`);
    return { coreByYear, sjrDataset, venueDataset, workerTimings: payload?.timings || null };
}
async function createRankingsWorkerInstance() {
    const workerUrl = chrome.runtime.getURL('rankings_worker.js');
    try {
        return { worker: new Worker(workerUrl), objectUrl: null, mode: 'extension-url' };
    }
    catch (directError) {
        const sourceResponse = await gsvrFetch(workerUrl);
        if (!sourceResponse.ok) {
            throw directError;
        }
        const source = await sourceResponse.text();
        const objectUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        try {
            return { worker: new Worker(objectUrl), objectUrl, mode: 'blob' };
        }
        catch (blobError) {
            URL.revokeObjectURL(objectUrl);
            throw blobError;
        }
    }
}
function loadRankingsDataViaWorker(indexUrl) {
    if (typeof Worker !== 'function' || !(chrome?.runtime?.getURL)) {
        return null;
    }
    return (async () => {
        const { worker, objectUrl, mode } = await createRankingsWorkerInstance();
        return new Promise((resolve, reject) => {
            const timer = gsvrTimingStart('rankingsWorkerRoundTrip');
            let settled = false;
            const cleanup = () => {
                try {
                    worker.terminate();
                }
                catch {
                    // ignore termination failures
                }
                if (objectUrl) {
                    URL.revokeObjectURL(objectUrl);
                }
            };
            worker.onmessage = (event) => {
                if (settled)
                    return;
                const message = event.data || {};
                if (message.type === 'ready') {
                    settled = true;
                    cleanup();
                    gsvrTimingEnd(timer, `${mode} ${message.timings ? JSON.stringify(message.timings) : ''}`);
                    resolve(hydrateRankingsWorkerPayload(message.payload));
                }
                else if (message.type === 'error') {
                    settled = true;
                    cleanup();
                    reject(new Error(message.error || 'Rankings worker failed'));
                }
            };
            worker.onerror = (event) => {
                if (settled)
                    return;
                settled = true;
                cleanup();
                reject(new Error(event?.message || 'Rankings worker error'));
            };
            worker.postMessage({ type: 'load', indexUrl });
        });
    })();
}
// Single source of truth: the prebuilt data/rankings-index.json (generated from
// rankings.csv by scripts/generate_rankings_index.mjs). Loaded and indexed once,
// then reused for both CORE (by year) and SJR matching.
async function loadRankingsData() {
    if (rankingsDataPromise) return rankingsDataPromise;
    rankingsDataPromise = (async () => {
        const url = chrome.runtime.getURL('data/rankings-index.json');
        const workerPromise = loadRankingsDataViaWorker(url);
        if (workerPromise) {
            try {
                return await workerPromise;
            }
            catch (error) {
                console.warn('GSR: Rankings worker failed; falling back to content-thread loader.', error);
            }
        }
        const loadTimer = gsvrTimingStart('loadRankingsData:fallback-total');
        const response = await gsvrFetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch rankings-index.json: ${response.status} ${response.statusText}`);
        }
        const parseTimer = gsvrTimingStart('loadRankingsData:response.json');
        const index = await response.json();
        gsvrTimingEnd(parseTimer);
        const coreTimer = gsvrTimingStart('loadRankingsData:coreByYear');
        const coreByYear = new Map();
        for (const [yearStr, rows] of Object.entries(index.core || {})) {
            const year = parseInt(yearStr, 10);
            coreByYear.set(year, rows.map(([title, acronym, rank]) => ({ title, acronym, rank, rawRank: rank })));
        }
        gsvrTimingEnd(coreTimer);
        // SJR entries are packed tuples [n, t, qstr]; qstr has one char per year
        // from startYear: '0' = unranked, '1'-'4' = Q1-Q4. The packed string is
        // kept as-is and decoded on lookup by selectPrecomputedSjrQuartile.
        const sjrStartYear = index.startYear ?? SJR_DATASET_START_YEAR;
        const byNormalized = new Map();
        const entries = [];
        const packedSjrRows = index.sjr || [];
        const sjrTimer = gsvrTimingStart('loadRankingsData:sjrDataset');
        for (let rowIndex = 0; rowIndex < packedSjrRows.length; rowIndex++) {
            const [n, t, qstr, tokens] = packedSjrRows[rowIndex];
            if (!n || !t || !qstr) continue;
            const entry = createSjrEntry(n, t, qstr, sjrStartYear, { tokens });
            byNormalized.set(entry.normalizedTitle, entry);
            entries.push(entry);
            if (rowIndex > 0 && rowIndex % 2000 === 0)
                await sleepMs(0);
        }
        gsvrTimingEnd(sjrTimer, `(${entries.length} entries)`);
        const sjrDataset = {
            version: index.version ?? 1,
            startYear: index.startYear ?? SJR_DATASET_START_YEAR,
            endYear: index.endYear ?? SJR_DATASET_END_YEAR,
            byNormalized,
            byIssn: new Map(),
            entries,
            tokenIndex: index.sjrTokenIndex && Array.isArray(index.sjrTokenIndex.tokenToIndexes)
                ? createTokenIndexFromPacked(index.sjrTokenIndex.tokenToIndexes, index.sjrTokenIndex.tokenFrequency)
                : null,
            tokenIndexPromise: null
        };
        const venueDataset = await createDblpVenueDataset(index.venues || null);
        gsvrTimingEnd(loadTimer, `(${entries.length} SJR entries, ${venueDataset.entries.length} DBLP venues)`);
        return { coreByYear, sjrDataset, venueDataset };
    })();
    return rankingsDataPromise;
}
function warmRankingsData(reason = 'warmup') {
    if (rankingsDataWarmupStarted)
        return rankingsDataPromise || Promise.resolve(null);
    rankingsDataWarmupStarted = true;
    const promise = loadRankingsData();
    promise.catch((error) => {
        rankingsDataWarmupStarted = false;
        console.warn(`GSR: Rankings data ${reason} failed:`, error);
    });
    return promise;
}
function buildSjrLookupCacheKey(normalizedQuery, queryIssns = []) {
    const utils = (typeof window !== 'undefined' && window.GSVRUtils) ? window.GSVRUtils : null;
    if (typeof utils?.buildJournalLookupCacheKey === 'function') {
        return utils.buildJournalLookupCacheKey(normalizedQuery, queryIssns);
    }
    const base = String(normalizedQuery || '').trim().toLowerCase();
    const issnKey = normalizeIssnList(queryIssns).join(',');
    return issnKey ? `${base}::issn:${issnKey}` : base;
}
function parseSjrCsv(text) {
    const rows = [];
    let currentField = '';
    let currentRow = [];
    let inQuotes = false;
    const sanitized = text.replace(/\ufeff/g, '');
    for (let i = 0; i < sanitized.length; i++) {
        const char = sanitized[i];
        if (char === '"') {
            if (inQuotes && sanitized[i + 1] === '"') {
                currentField += '"';
                i++;
            }
            else {
                inQuotes = !inQuotes;
            }
        }
        else if (char === ';' && !inQuotes) {
            currentRow.push(currentField);
            currentField = '';
        }
        else if ((char === '\n' || char === '\r') && !inQuotes) {
            if (char === '\r' && sanitized[i + 1] === '\n') {
                i++;
            }
            currentRow.push(currentField);
            currentField = '';
            if (currentRow.some(value => value.trim().length > 0)) {
                rows.push(currentRow);
            }
            currentRow = [];
        }
        else {
            currentField += char;
        }
    }
    if (currentField.length > 0 || currentRow.length > 0) {
        currentRow.push(currentField);
        if (currentRow.some(value => value.trim().length > 0)) {
            rows.push(currentRow);
        }
    }
    return rows;
}
function createTokenSet(normalizedTitle) {
    const STOP_WORDS = new Set(['and', 'the', 'of', 'for', 'in', 'on', 'journal', 'international', 'transactions', 'letters']);
    const tokens = normalizedTitle
        .split(' ')
        .map(token => token.trim())
        .filter(token => token.length >= 3 && !STOP_WORDS.has(token));
    return new Set(tokens);
}
function normalizeDblpVenueAlias(value) {
    let normalized = String(value || '').toLowerCase();
    normalized = normalized.replace(/\p{Extended_Pictographic}/gu, ' ');
    normalized = normalized.replace(/[\uFE0E\uFE0F]/g, ' ');
    normalized = normalized.replace(/&/g, ' and ');
    normalized = normalized.replace(/@/g, ' ');
    const venueAbbreviations = {
        ...COMMON_ABBREVIATIONS,
        "gener.": "generation",
        "gener": "generation",
        "meas.": "measurement",
        "meas": "measurement",
        "anal.": "analysis",
        "anal": "analysis",
        "softw.": "software",
        "softw": "software"
    };
    const stripCitationSuffixes = (input) => String(input || '')
        .replace(/\s*(?:\.\.\.|…)\s*$/g, ' ')
        .replace(/\b(19|20)\d{2}\b/g, ' ')
        .replace(/\b(19|20)\d{2}\b\s*[,;:]?\s*$/g, ' ')
        .replace(/\b\d+(?:st|nd|rd|th)\b/gi, ' ')
        .replace(WORD_ORDINAL_PATTERN, ' ')
        .replace(/\b\d{1,4}\s*\(\s*\d{1,4}\b[^)]*$/g, ' ')
        .replace(/\b\d{1,4}\s*\(\s*\d{1,4}\s*\)\s*[,;:]?\s*\d{1,6}\s*[-\u2010-\u2015]\s*\d{1,6}\s*$/g, ' ')
        .replace(/\b\d{1,4}\s*[,;:]\s*\d{1,6}\s*[-\u2010-\u2015]\s*\d{1,6}\s*$/g, ' ')
        .replace(/\b\d{1,4}\s+\d{1,6}\s*[-\u2010-\u2015]\s*\d{1,6}\s*$/g, ' ')
        .replace(/\b(pp\.?|pages?)\s*\d{1,6}\s*[-\u2010-\u2015]\s*\d{1,6}\s*$/g, ' ')
        .replace(/\b(volume|vol|issue|no|number)\s*\d+\b/g, ' ')
        .replace(/\b\d{1,4}\s+\d{1,6}\s+\d{1,6}\s*$/g, ' ')
        .replace(/\b\d{1,4}\s+\d{1,6}\s*$/g, ' ')
        .replace(/\b\d{1,4}\b\s*$/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    normalized = stripCitationSuffixes(normalized);
    for (const [abbr, expansion] of Object.entries(venueAbbreviations)) {
        normalized = normalized.replace(new RegExp(`\\b${escapeRegExp(abbr)}\\b`, 'gi'), expansion);
    }
    normalized = normalized.replace(/[\.,\/#!$%\^;\*:{}=\_`~?"“”'’()\[\]+]/g, ' ');
    normalized = normalized.replace(/[-\u2010-\u2015]/g, ' ');
    normalized = stripCitationSuffixes(normalized);
    normalized = normalized.replace(/\s+/g, ' ').trim();
    normalized = normalized.replace(/^\s*(proceedings\s+of\s+the|proceedings\s+of|proc\.?\s+of\s+the|proc\.?\s+of|proceedings|proc\.?)\s+/i, '');
    return normalized.replace(/\s+/g, ' ').trim();
}
function createAcronymVariantsFromCompactDblpAlias(value) {
    const compact = normalizeDblpVenueAlias(value).replace(/\s+/g, '');
    if (!/^[a-z0-9]{4,24}$/.test(compact))
        return [];
    const variants = new Set([compact]);
    for (const prefix of ['euro', 'asia', 'acm', 'ieee', 'ifip', 'usenix']) {
        if (compact.startsWith(prefix) && compact.length - prefix.length >= 3) {
            variants.add(compact.slice(prefix.length));
        }
    }
    return Array.from(variants);
}
function normalizeDblpVenueAliasStemmed(value) {
    return normalizeDblpVenueAlias(value)
        .split(' ')
        .map((token) => {
            if (token.length <= 4)
                return token;
            if (token.endsWith('ies') && token.length > 5)
                return token.slice(0, -3) + 'y';
            if (token.endsWith('sses'))
                return token;
            if (token.endsWith('s') && !token.endsWith('ss'))
                return token.slice(0, -1);
            return token;
        })
        .join(' ')
        .trim();
}
function createVenueTokenSet(normalizedTitle) {
    const STOP_WORDS = new Set(['and', 'the', 'of', 'for', 'in', 'on', 'journal', 'conference', 'international', 'workshop', 'symposium', 'proceedings']);
    return new Set(
        String(normalizedTitle || '')
            .split(' ')
            .map(token => token.trim())
            .filter(token => token.length >= 3 && !STOP_WORDS.has(token))
    );
}
function countSetIntersection(left, right) {
    let count = 0;
    for (const value of left || []) {
        if (right?.has?.(value))
            count++;
    }
    return count;
}
function createNormalizedTokenSet(value, minLength = 2) {
    return new Set(
        String(value || '')
            .split(/\s+/)
            .map(token => token.trim())
            .filter(token => token.length >= minLength)
    );
}
function computeDblpVenueFuzzySimilarity(query, alias) {
    const jaroScore = RANKING_UTILS?.jaroWinkler
        ? RANKING_UTILS.jaroWinkler(query, alias)
        : jaroWinkler(query, alias);
    const queryTokens = createNormalizedTokenSet(query, 2);
    const aliasTokens = createNormalizedTokenSet(alias, 2);
    const tokenIntersection = countSetIntersection(queryTokens, aliasTokens);
    const tokenUnion = queryTokens.size + aliasTokens.size - tokenIntersection;
    const tokenJaccard = tokenUnion > 0 ? tokenIntersection / tokenUnion : 0;
    const queryContentTokens = createVenueTokenSet(query);
    const aliasContentTokens = createVenueTokenSet(alias);
    const contentIntersection = countSetIntersection(queryContentTokens, aliasContentTokens);
    const contentCoverage = queryContentTokens.size > 0 ? contentIntersection / queryContentTokens.size : 0;
    const contentPurity = aliasContentTokens.size > 0 ? contentIntersection / aliasContentTokens.size : 0;
    const exactContentMatch = queryContentTokens.size > 0
        && queryContentTokens.size === aliasContentTokens.size
        && contentIntersection === queryContentTokens.size;
    const score = (0.40 * jaroScore)
        + (0.25 * tokenJaccard)
        + (0.25 * contentCoverage)
        + (0.10 * contentPurity)
        + (exactContentMatch ? 0.04 : 0);
    return Math.min(0.995, score);
}
function createDblpVenueTokenIndex(entries) {
    const tokenToIndexes = new Map();
    const tokenFrequency = new Map();
    entries.forEach((entry, index) => {
        for (const alias of entry.normalizedAliases || []) {
            for (const token of createVenueTokenSet(alias)) {
                if (!tokenToIndexes.has(token))
                    tokenToIndexes.set(token, new Set());
                tokenToIndexes.get(token).add(index);
                tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
            }
        }
    });
    return { tokenToIndexes, tokenFrequency };
}
async function createDblpVenueTokenIndexAsync(entries) {
    const tokenToIndexes = new Map();
    const tokenFrequency = new Map();
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        for (const alias of entry.normalizedAliases || []) {
            for (const token of createVenueTokenSet(alias)) {
                if (!tokenToIndexes.has(token))
                    tokenToIndexes.set(token, new Set());
                tokenToIndexes.get(token).add(index);
                tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
            }
        }
        if (index > 0 && index % 500 === 0)
            await sleepMs(0);
    }
    return { tokenToIndexes, tokenFrequency };
}
function ensureDblpVenueTokenIndex(dataset) {
    const timer = gsvrTimingStart('ensureDblpVenueTokenIndex');
    if (!dataset)
        return Promise.resolve(null);
    if (dataset.tokenIndex) {
        gsvrTimingEnd(timer, '(ready)');
        return Promise.resolve(dataset.tokenIndex);
    }
    if (!dataset.tokenIndexPromise) {
        dataset.tokenIndexPromise = createDblpVenueTokenIndexAsync(dataset.entries || [])
            .then((tokenIndex) => {
            dataset.tokenIndex = tokenIndex;
            gsvrTimingEnd(timer, `(${dataset.entries?.length || 0} venues)`);
            return tokenIndex;
        })
            .catch((error) => {
            dataset.tokenIndexPromise = null;
            gsvrTimingEnd(timer, '(failed)');
            throw error;
        });
    }
    else {
        return dataset.tokenIndexPromise.then((tokenIndex) => {
            gsvrTimingEnd(timer, '(waited)');
            return tokenIndex;
        });
    }
    return dataset.tokenIndexPromise;
}
async function createDblpVenueDataset(catalog) {
    const timer = gsvrTimingStart('createDblpVenueDataset');
    const rawEntries = Array.isArray(catalog?.entries) ? catalog.entries : [];
    const entries = [];
    const rawIndexToEntry = [];
    for (let rawIndex = 0; rawIndex < rawEntries.length; rawIndex++) {
        const tuple = rawEntries[rawIndex];
        const [id, type, title, shortName, aliases, flags, yearStart, yearEnd, count, normalizedAliasesPacked, rankInfo] = Array.isArray(tuple) ? tuple : [];
        const aliasList = Array.isArray(aliases) ? aliases : [];
        const normalizedAliases = Array.isArray(normalizedAliasesPacked) && normalizedAliasesPacked.length
            ? Array.from(new Set(normalizedAliasesPacked.map(String).filter(Boolean)))
            : Array.from(new Set([
            normalizeDblpVenueAlias(title),
            normalizeDblpVenueAliasStemmed(title),
            normalizeDblpVenueAlias(shortName),
            normalizeDblpVenueAliasStemmed(shortName),
            ...aliasList.map(normalizeDblpVenueAlias)
                .flatMap((alias, index) => [alias, normalizeDblpVenueAliasStemmed(aliasList[index])]),
            ...[title, shortName, ...aliasList].flatMap(createAcronymVariantsFromCompactDblpAlias)
        ].filter(Boolean)));
        const entry = {
            index: entries.length,
            id: String(id || ''),
            type: String(type || 'unknown'),
            title: String(title || ''),
            shortName: String(shortName || ''),
            aliases: aliasList,
            normalizedAliases,
            flags: Array.isArray(flags) ? flags.map(String) : [],
            yearStart: Number.isFinite(yearStart) ? yearStart : null,
            yearEnd: Number.isFinite(yearEnd) ? yearEnd : null,
            count: Number.isFinite(count) ? count : 0,
            rankInfo: Array.isArray(rankInfo) ? rankInfo : null
        };
        if (entry.id && entry.title && entry.normalizedAliases.length) {
            entry.index = entries.length;
            entries.push(entry);
            rawIndexToEntry[rawIndex] = entry;
        }
        if (rawIndex > 0 && rawIndex % 500 === 0)
            await sleepMs(0);
    }
    const byNormalized = new Map();
    if (Array.isArray(catalog?.byNormalized) && catalog.byNormalized.length) {
        for (const [key, indexes] of catalog.byNormalized) {
            const matches = (Array.isArray(indexes) ? indexes : [indexes])
                .map(index => rawIndexToEntry[Number(index)])
                .filter(Boolean);
            if (key && matches.length)
                byNormalized.set(String(key), matches);
        }
    }
    else {
        const catalogAliases = catalog?.aliases && typeof catalog.aliases === 'object' ? catalog.aliases : {};
        const catalogAliasEntries = Object.entries(catalogAliases);
        for (let aliasIndex = 0; aliasIndex < catalogAliasEntries.length; aliasIndex++) {
            const [key, indexes] = catalogAliasEntries[aliasIndex];
            const normalized = normalizeDblpVenueAlias(key);
            if (!normalized)
                continue;
            const matches = (Array.isArray(indexes) ? indexes : [indexes])
                .map(index => rawIndexToEntry[Number(index)])
                .filter(Boolean);
            if (matches.length)
                byNormalized.set(normalized, matches);
            if (aliasIndex > 0 && aliasIndex % 2000 === 0)
                await sleepMs(0);
        }
        for (let index = 0; index < entries.length; index++) {
            const entry = entries[index];
            for (const alias of entry.normalizedAliases) {
                if (!byNormalized.has(alias))
                    byNormalized.set(alias, []);
                const list = byNormalized.get(alias);
                if (!list.some(existing => existing.id === entry.id))
                    list.push(entry);
            }
            if (index > 0 && index % 500 === 0)
                await sleepMs(0);
        }
    }
    const result = {
        version: catalog?.version ?? 1,
        source: catalog?.source || null,
        entries,
        byNormalized,
        tokenIndex: catalog?.tokenIndex && Array.isArray(catalog.tokenIndex.tokenToIndexes)
            ? createTokenIndexFromPacked(catalog.tokenIndex.tokenToIndexes, catalog.tokenIndex.tokenFrequency)
            : null,
        tokenIndexPromise: null,
        available: entries.length > 0
    };
    gsvrTimingEnd(timer, `(${entries.length} venues, ${byNormalized.size} aliases)`);
    return result;
}
function createSjrTokenIndex(entries) {
    const tokenToIndexes = new Map();
    const tokenFrequency = new Map();
    entries.forEach((entry, index) => {
        for (const token of entry.tokenSet || []) {
            if (!tokenToIndexes.has(token))
                tokenToIndexes.set(token, new Set());
            tokenToIndexes.get(token).add(index);
            tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
        }
    });
    return { tokenToIndexes, tokenFrequency };
}
async function createSjrTokenIndexAsync(entries) {
    const tokenToIndexes = new Map();
    const tokenFrequency = new Map();
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        for (const token of entry.tokenSet || []) {
            if (!tokenToIndexes.has(token))
                tokenToIndexes.set(token, new Set());
            tokenToIndexes.get(token).add(index);
            tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
        }
        if (index > 0 && index % 1000 === 0)
            await sleepMs(0);
    }
    return { tokenToIndexes, tokenFrequency };
}
function ensureSjrTokenIndex(dataset) {
    const timer = gsvrTimingStart('ensureSjrTokenIndex');
    if (!dataset)
        return Promise.resolve(null);
    if (dataset.tokenIndex) {
        gsvrTimingEnd(timer, '(ready)');
        return Promise.resolve(dataset.tokenIndex);
    }
    if (!dataset.tokenIndexPromise) {
        dataset.tokenIndexPromise = createSjrTokenIndexAsync(dataset.entries || [])
            .then((tokenIndex) => {
            dataset.tokenIndex = tokenIndex;
            gsvrTimingEnd(timer, `(${dataset.entries?.length || 0} entries)`);
            return tokenIndex;
        })
            .catch((error) => {
            dataset.tokenIndexPromise = null;
            gsvrTimingEnd(timer, '(failed)');
            throw error;
        });
    }
    else {
        return dataset.tokenIndexPromise.then((tokenIndex) => {
            gsvrTimingEnd(timer, '(waited)');
            return tokenIndex;
        });
    }
    return dataset.tokenIndexPromise;
}
function chooseBetterQuartile(existing, nextValue) {
    if (!nextValue)
        return existing;
    if (!existing)
        return nextValue;
    const parse = (value) => {
        const match = value.match(/^Q(\d)$/i);
        return match ? parseInt(match[1], 10) : Number.POSITIVE_INFINITY;
    };
    return parse(nextValue) < parse(existing) ? nextValue : existing;
}
function createSjrEntry(normalizedTitle, title, quartileString, quartileStartYear, extra = {}) {
    return {
        normalizedTitle,
        resolvedTitle: title,
        quartileString: String(quartileString || ''),
        quartileStartYear,
        tokenSet: new Set(Array.isArray(extra.tokens) ? extra.tokens : createTokenSet(normalizedTitle)),
        issns: normalizeIssnList(extra.issns),
        sourceId: extra.sourceId ?? null,
        coverage: extra.coverage ?? null
    };
}
async function loadSjrDataset() {
    // Backed by the unified rankings.csv (source=SCImago rows).
    return (await loadRankingsData()).sjrDataset;
}
function ensureSjrDataset() {
    if (!sjrDatasetPromise) {
        sjrDatasetPromise = loadSjrDataset().then((dataset) => {
            if (dataset?.loadFailed) {
                // Allow a later scan (e.g. manual rescan) to retry the fetch.
                sjrDatasetPromise = null;
            }
            return dataset;
        });
    }
    return sjrDatasetPromise;
}
function selectQuartileForYear(data, publicationYear) {
    const selection = selectPrecomputedSjrQuartile(data.quartileString, publicationYear ?? null, data.quartileStartYear);
    if (!selection) {
        return { quartile: null, year: null };
    }
    return { quartile: selection.rank, year: selection.year, sourceYearFallback: selection.sourceYearFallback };
}
function latestRankedSjrYear(entry) {
    const text = String(entry?.quartileString || '');
    for (let index = text.length - 1; index >= 0; index--) {
        if (text[index] !== '0') return entry.quartileStartYear + index;
    }
    return 0;
}
function buildSjrQuartileSelectionResult(data, selection, extra = {}) {
    if (selection?.historicalCoverageUnavailable) {
        return {
            status: 'historical_coverage_unavailable',
            reason: 'sjr_historical_coverage_unavailable',
            quartile: null,
            year: null,
            resolvedTitle: data?.resolvedTitle ?? null,
            matchScore: extra.matchScore ?? null,
            matchedNormalizedTitle: extra.matchedNormalizedTitle ?? null,
            matchedSourceId: data?.sourceId ?? extra.matchedSourceId ?? null,
            sourceYearFallback: false
        };
    }
    return {
        status: 'success',
        quartile: selection?.quartile ?? null,
        year: selection?.year ?? null,
        resolvedTitle: data?.resolvedTitle ?? null,
        matchScore: extra.matchScore ?? null,
        matchedNormalizedTitle: extra.matchedNormalizedTitle ?? null,
        matchedSourceId: data?.sourceId ?? extra.matchedSourceId ?? null,
        sourceYearFallback: selection?.sourceYearFallback === true
    };
}
function selectSjrCandidateIndexes(queryTokens, dataset) {
    if (!queryTokens.length || !dataset?.tokenIndex)
        return null;
    const ranked = queryTokens
        .map(token => ({ token, count: dataset.tokenIndex.tokenFrequency.get(token) || Number.POSITIVE_INFINITY }))
        .filter(entry => Number.isFinite(entry.count))
        .sort((a, b) => a.count - b.count || a.token.localeCompare(b.token));
    if (!ranked.length)
        return null;
    let candidateSet = null;
    for (const entry of ranked.slice(0, 3)) {
        const indexes = dataset.tokenIndex.tokenToIndexes.get(entry.token);
        if (!indexes?.size)
            continue;
        candidateSet = candidateSet ? new Set([...candidateSet].filter(index => indexes.has(index))) : new Set(indexes);
        if (candidateSet.size > 0 && candidateSet.size <= 48) {
            break;
        }
    }
    if (candidateSet?.size) {
        return candidateSet;
    }
    return dataset.tokenIndex.tokenToIndexes.get(ranked[0].token) || null;
}
function findBestSjrMatch({ normalizedQuery, queryIssns, dataset, allowFuzzy = true }) {
    const exactIssnMatches = [];
    for (const issn of normalizeIssnList(queryIssns)) {
        const matches = dataset.byIssn?.get(issn) || [];
        for (const match of matches) {
            if (!exactIssnMatches.includes(match))
                exactIssnMatches.push(match);
        }
    }
    if (exactIssnMatches.length === 1) {
        return { status: DECISION_STATUS.MATCHED, entry: exactIssnMatches[0], score: 1.0, matchedBy: 'issn' };
    }
    if (exactIssnMatches.length > 1) {
        const exactTitleMatch = exactIssnMatches.find((entry) => entry.normalizedTitle === normalizedQuery);
        if (exactTitleMatch) {
            return { status: DECISION_STATUS.MATCHED, entry: exactTitleMatch, score: 1.0, matchedBy: 'issn' };
        }
        const sourceIds = new Set(exactIssnMatches.map((entry) => entry.sourceId).filter(Boolean));
        if (sourceIds.size === 1) {
            const latestSourceEntry = exactIssnMatches
                .slice()
                .sort((left, right) => latestRankedSjrYear(right) - latestRankedSjrYear(left))[0];
            if (latestSourceEntry) {
                return { status: DECISION_STATUS.MATCHED, entry: latestSourceEntry, score: 1.0, matchedBy: 'issn' };
            }
        }
        let bestIssnMatch = null;
        let secondIssnMatch = null;
        for (const entry of exactIssnMatches) {
            const score = RANKING_UTILS?.hybridSimilarity
                ? RANKING_UTILS.hybridSimilarity(normalizedQuery, entry.normalizedTitle)
                : (0.72 * jaroWinkler(normalizedQuery, entry.normalizedTitle));
            const candidate = { entry, score };
            if (!bestIssnMatch || score > bestIssnMatch.score) {
                secondIssnMatch = bestIssnMatch;
                bestIssnMatch = candidate;
            }
            else if (!secondIssnMatch || score > secondIssnMatch.score) {
                secondIssnMatch = candidate;
            }
        }
        const issnGap = secondIssnMatch ? bestIssnMatch.score - secondIssnMatch.score : Number.POSITIVE_INFINITY;
        if (bestIssnMatch && (bestIssnMatch.score >= 0.97 || issnGap >= RANKING_CONFIG.sjrAmbiguityGap)) {
            return { status: DECISION_STATUS.MATCHED, entry: bestIssnMatch.entry, score: bestIssnMatch.score, matchedBy: 'issn' };
        }
        return { status: DECISION_STATUS.AMBIGUOUS, score: 1.0, matchedBy: 'issn' };
    }
    const directMatch = dataset.byNormalized.get(normalizedQuery);
    if (directMatch) {
        return { status: DECISION_STATUS.MATCHED, entry: directMatch, score: 1.0, matchedBy: 'title_exact' };
    }
    if (!allowFuzzy) {
        return { status: DECISION_STATUS.MISSING };
    }
    const queryTokens = normalizedQuery
        .split(' ')
        .map(token => token.trim())
        .filter(token => token.length >= 3);
    const candidateIndexes = selectSjrCandidateIndexes(queryTokens, dataset) || new Set(dataset.entries.map((_, index) => index));
    let best = null;
    let second = null;
    for (const index of candidateIndexes) {
        const entry = dataset.entries[index];
        if (!entry)
            continue;
        const score = RANKING_UTILS?.hybridSimilarity
            ? RANKING_UTILS.hybridSimilarity(normalizedQuery, entry.normalizedTitle)
            : (0.72 * jaroWinkler(normalizedQuery, entry.normalizedTitle));
        if (score < RANKING_CONFIG.sjrFuzzyThreshold) {
            continue;
        }
        const candidate = { entry, score };
        if (!best || score > best.score) {
            second = best;
            best = candidate;
        }
        else if (!second || score > second.score) {
            second = candidate;
        }
    }
    if (!best) {
        return { status: DECISION_STATUS.MISSING };
    }
    const gap = second ? best.score - second.score : Number.POSITIVE_INFINITY;
    if (second && best.score < 0.97 && gap < RANKING_CONFIG.sjrAmbiguityGap) {
        return { status: DECISION_STATUS.AMBIGUOUS, score: best.score, gap, matchedBy: 'title_fuzzy' };
    }
    return { status: DECISION_STATUS.MATCHED, entry: best.entry, score: best.score, matchedBy: 'title_fuzzy' };
}
async function resolveSjrQuartile(journalName, publicationYear, journalMeta = {}) {
    const variants = generateJournalNormalizationVariants(journalName);
    if (!variants.length)
        return { status: 'not_found' };
    const queryIssns = normalizeIssnList(journalMeta.issns);
    const hasScopedIssns = queryIssns.length > 0;

    // Try cache first across variants.
    let sawNotFound = false;
    for (const normalizedQuery of variants) {
        const scopedCacheKey = buildSjrLookupCacheKey(normalizedQuery, queryIssns);
        const genericCacheKey = buildSjrLookupCacheKey(normalizedQuery, []);
        const scopedEntry = sjrLookupCache.get(scopedCacheKey);
        if (scopedEntry?.kind === 'success') {
            const selection = selectQuartileForYear(scopedEntry.data, publicationYear ?? null);
            return buildSjrQuartileSelectionResult(scopedEntry.data, selection, {
                matchScore: scopedEntry.matchScore ?? null,
                matchedNormalizedTitle: scopedEntry.matchedNormalizedTitle ?? null
            });
        }
        const genericEntry = genericCacheKey !== scopedCacheKey ? sjrLookupCache.get(genericCacheKey) : null;
        if (genericEntry?.kind === 'success') {
            const selection = selectQuartileForYear(genericEntry.data, publicationYear ?? null);
            return buildSjrQuartileSelectionResult(genericEntry.data, selection, {
                matchScore: genericEntry.matchScore ?? null,
                matchedNormalizedTitle: genericEntry.matchedNormalizedTitle ?? null
            });
        }
        if (scopedEntry?.kind === 'not_found') {
            sawNotFound = true;
            continue;
        }
        if (!hasScopedIssns && genericEntry?.kind === 'not_found') {
            sawNotFound = true;
            continue;
        }
    }
    try {
        const dataset = await ensureSjrDataset();
        if (dataset?.loadFailed) {
            return { status: 'error', transient: true };
        }
        let sawAmbiguous = false;
        const useMatch = (match) => {
            if (!match || match.status === DECISION_STATUS.MISSING)
                return null;
            if (match.status === DECISION_STATUS.AMBIGUOUS) {
                sawAmbiguous = true;
                return null;
            }
            const entry = match.entry;
            const data = {
                resolvedTitle: entry.resolvedTitle,
                quartileString: entry.quartileString,
                quartileStartYear: entry.quartileStartYear,
                sourceId: entry.sourceId ?? null
            };
            const cacheKeys = (hasScopedIssns && match.matchedBy === 'issn')
                ? variants.map((variant) => buildSjrLookupCacheKey(variant, queryIssns))
                : variants.map((variant) => buildSjrLookupCacheKey(variant, []));
            // Cache the successful match for all equivalent variants. Exact ISSN hits stay scoped
            // so a title-only miss from fast scan cannot suppress a later ISSN-backed depth hit.
            for (const cacheKey of cacheKeys) {
                sjrLookupCache.set(cacheKey, {
                    kind: 'success',
                    data,
                    matchScore: match.score,
                    matchedNormalizedTitle: entry.normalizedTitle
                });
            }
            const selection = selectQuartileForYear(data, publicationYear ?? null);
            return buildSjrQuartileSelectionResult(data, selection, {
                matchScore: match.score,
                matchedNormalizedTitle: entry.normalizedTitle
            });
        };
        for (const normalizedQuery of variants) {
            const result = useMatch(findBestSjrMatch({ normalizedQuery, queryIssns, dataset, allowFuzzy: false }));
            if (result)
                return result;
        }
        if (!sawAmbiguous) {
            await ensureSjrTokenIndex(dataset);
            for (const normalizedQuery of variants) {
                const result = useMatch(findBestSjrMatch({ normalizedQuery, queryIssns, dataset, allowFuzzy: true }));
                if (result)
                    return result;
            }
        }
        if (sawAmbiguous) {
            return { status: 'ambiguous' };
        }

        // Not found: cache negative result. ISSN-aware misses stay scoped to that ISSN set.
        if (!sawNotFound) {
            const missCacheKeys = hasScopedIssns
                ? variants.map((variant) => buildSjrLookupCacheKey(variant, queryIssns))
                : variants.map((variant) => buildSjrLookupCacheKey(variant, []));
            for (const cacheKey of missCacheKeys) {
                sjrLookupCache.set(cacheKey, { kind: 'not_found' });
            }
        }
        return { status: 'not_found' };
    }
    catch (error) {
        console.error('Error resolving SJR quartile from local dataset:', error);
        return { status: 'error', transient: false };
    }
}
function escapeRegExp(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


const COMMON_ABBREVIATIONS = {
    "int'l": "international",
    "intl": "international",
    "int.": "international",
    "int": "international",
    "conf.": "conference",
    "conf": "conference",
    "proc.": "proceedings",
    "proc": "proceedings",
    "symp.": "symposium",
    "symp": "symposium",
    "j.": "journal",
    "j": "journal",
    "jour": "journal",
    "trans.": "transactions",
    "trans": "transactions",
    "annu.": "annual",
    "annu": "annual",
    // NOTE: DBLP abbreviations use "Comput." overwhelmingly to mean "Computer".
    // Some venues expand to "Computing" (e.g., "ACM Computing Surveys"),
    // which we handle via lightweight normalization variants in journal matching.
    "comput.": "computer",
    "comput": "computer",
    "comp.": "computer",
    "comp": "computer",
    "commun.": "communications",
    "commun": "communications",
    "comm.": "communications",
    "comm": "communications",
    "rev.": "review",
    "rev": "review",
    "syst.": "systems",
    "syst": "systems",
    // Common DBLP journal abbreviations
    "meas.": "measurement",
    "meas": "measurement",
    "anal.": "analysis",
    "anal": "analysis",
    "manag.": "management",
    "manag": "management",
    "process.": "processing",
    "process": "processing",
    "sci.": "science",
    "sci": "science",
    "sens.": "sensor",
    "sens": "sensor",
    "netw.": "networks",
    "netw": "networks",
    "pers.": "personal",
    "pers": "personal",
    "embed.": "embedded",
    "embed": "embedded",
    "distr.": "distributed",
    "distr": "distributed",
    "archit.": "architecture",
    "archit": "architecture",
    "tech.": "technical",
    "tech": "technical",
    "technol": "technology",
    "engin.": "engineering",
    "engin": "engineering",
    "res.": "research",
    "res": "research",
    "adv.": "advances",
    "adv": "advances",
    "appl.": "applications",
    "appl": "applications",
    "surv.": "surveys",
    "surv": "surveys",
    "wirel.": "wireless",
    "wirel": "wireless",
    "inf.": "information",
    "inf": "information",
    "lectures notes": "lecture notes",
    "lect notes": "lecture notes",
    "lncs": "lecture notes in computer science",
};
function cleanTextForComparison(text, isGoogleScholarVenue = false) {
    if (!text)
        return "";
    let cleanedText = text.toLowerCase();
    cleanedText = cleanedText.replace(/\p{Extended_Pictographic}/gu, " ");
    cleanedText = cleanedText.replace(/[\uFE0E\uFE0F]/g, " ");
    cleanedText = cleanedText.replace(/&/g, " and ");
    cleanedText = cleanedText.replace(/[\.,\/#!$%\^;\*:{}=\_`~?"“”()\[\]]/g, " ");
    cleanedText = cleanedText.replace(/\s-\s/g, " ");
    if (isGoogleScholarVenue) {
        cleanedText = cleanedText.replace(/^(\d{4}\s+|\d{1,2}(st|nd|rd|th)\s+)/, "");
        cleanedText = cleanedText.replace(/,\s*\d{4}$/, "");
        cleanedText = cleanedText.replace(/\(\d{4}\)$/, "");
        // Scholar/DBLP often appends "(2)", "(Part 2)", etc. Strip trailing numeric/issue tokens.
        cleanedText = cleanedText.replace(/\b(part|volume|vol|issue|no|number)\s*\d+\b/g, " ");
        cleanedText = cleanedText.replace(/\b\d{1,3}\b\s*$/g, "");
    }
    // Also remove a trailing standalone number for non-Scholar venues (e.g., "MobiQuitous (2)")
    cleanedText = cleanedText.replace(/\b\d{1,3}\b\s*$/g, "");
    cleanedText = cleanedText.replace(/\s+/g, ' ').trim();

    // Expand abbreviations *after* punctuation is normalized to spaces.
    // This avoids false negatives for dotted abbreviations like "Commun." or "J.".
    for (const [abbr, expansion] of Object.entries(COMMON_ABBREVIATIONS)) {
        const regex = new RegExp(`\\b${escapeRegExp(abbr)}\\b`, 'gi');
        cleanedText = cleanedText.replace(regex, expansion);
    }

    cleanedText = cleanedText.replace(/\s+/g, ' ');
    return cleanedText.trim();
}
const FUZZY_THRESHOLD = 0.90;
function jaroWinkler(s1, s2) {
    if (!s1 || !s2)
        return 0;
    const m = (a, b) => {
        const bound = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
        const match = new Array(a.length).fill(false), bMatch = new Array(b.length).fill(false);
        let matches = 0;
        for (let i = 0; i < a.length; i++) {
            const lo = Math.max(0, i - bound), hi = Math.min(i + bound + 1, b.length);
            for (let j = lo; j < hi; j++)
                if (!bMatch[j] && a[i] === b[j]) {
                    match[i] = bMatch[j] = true;
                    matches++;
                    break;
                }
        }
        if (!matches)
            return { matches: 0, trans: 0 };
        let k = 0, trans = 0;
        for (let i = 0; i < a.length; i++)
            if (match[i]) {
                while (!bMatch[k])
                    k++;
                if (a[i] !== b[k])
                    trans++;
                k++;
            }
        return { matches, trans: trans / 2 };
    };
    const { matches, trans } = m(s1, s2);
    if (!matches)
        return 0;
    const j = (matches / s1.length + matches / s2.length + (matches - trans) / matches) / 3;
    const l = Math.min(4, [...s1].findIndex((c, i) => c !== s2[i] || i >= s2.length));
    return j + l * 0.1 * (1 - j);
}
const ORG_PREFIXES_TO_IGNORE = ["acm/ieee", "ieee/acm", "acm-ieee", "ieee-acm", "acm sigplan", "acm sigops", "acm sigbed", "acm sigcomm", "acm sigmod", "acm sigarch", "acm sigsac", "acm", "ieee", "ifip", "usenix", "eurographics", "springer", "elsevier", "wiley", "sigplan", "sigops", "sigbed", "sigcomm", "sigmod", "sigarch", "sigsac", "international", "national", "annual"];
function stripOrgPrefixes(text) {
    let currentText = text;
    let strippedSomething;
    do {
        strippedSomething = false;
        for (const prefix of ORG_PREFIXES_TO_IGNORE) {
            if (currentText.startsWith(prefix + " ") || currentText === prefix) {
                currentText = currentText.substring(prefix.length).trim();
                strippedSomething = true;
            }
        }
    } while (strippedSomething && currentText.length > 0);
    return currentText;
}
const CORE_TITLE_TRAILING_PATTERNS = [
    /\bpreviously\b.*$/,
    /\bformerly\b.*$/,
    /\bincluding\b.*$/,
    /\bincorporating\b.*$/,
    /\bfeaturing\b.*$/,
    /\bco\s+located\b.*$/,
    /\bco\s+hosted\b.*$/,
];
function generateCoreTitleVariants(coreTitle) {
    const normalized = coreTitle.replace(/\s+/g, ' ').trim();
    if (!normalized)
        return [];
    const variants = new Set([normalized]);
    for (const pattern of CORE_TITLE_TRAILING_PATTERNS) {
        const trimmed = normalized.replace(pattern, '').trim();
        if (trimmed && trimmed !== normalized) {
            variants.add(trimmed);
        }
    }
    return Array.from(variants);
}
function findRankForVenue(venueKey, coreData, fullVenueTitle = undefined, detailsOut = null) {
    const setDetails = (details) => {
        if (!detailsOut || typeof detailsOut !== 'object')
            return;
        for (const [key, value] of Object.entries(details || {})) {
            detailsOut[key] = value;
        }
    };
    const resolver = RANKING_UTILS?.resolveCoreVenue;
    const aliasIndex = Object.values(coreAliasIndexCache).find((entry) => entry?.entries === coreData) || null;
    if (resolver) {
        const result = resolver({
            venueKey,
            fullVenueTitle,
            coreData,
            aliasIndex
        });
        if (result) {
            setDetails({
                matchType: result.matchType ?? result.status ?? null,
                matchedVenue: result.matchedVenue ?? venueKey ?? null,
                venueMatchConfidence: (typeof result.confidence === 'number' ? result.confidence : null),
                decisionStatus: result.status ?? null,
                matchedKey: result.matchedKey ?? null,
                rawRankLabel: result.rawRankLabel ?? null,
                decisionEvidence: result.reason ? [result.reason] : null,
                topCandidates: Array.isArray(result.topCandidates) ? result.topCandidates : null
            });
            return VALID_RANKS.includes(result.rank) ? result.rank : "N/A";
        }
    }
    return "N/A";
}
function extractPotentialAcronymsFromText(scholarVenueName) {
    const acronyms = new Set();
    const originalVenueName = scholarVenueName;
    const parentheticalMatches = originalVenueName.match(/\(([^)]+)\)/g);
    if (parentheticalMatches) {
        parentheticalMatches.forEach(match => {
            const contentInParen = match.slice(1, -1).trim();
            const partsInParen = contentInParen.split(/[,;]/).map(p => p.trim());
            for (const part of partsInParen) {
                const potentialAcronym = part.match(/^([A-Z][a-zA-Z0-9'’]*[a-zA-Z0-9]|[A-Z]{2,}[0-9'’]*)$/);
                if (potentialAcronym && potentialAcronym[0]) {
                    let extracted = potentialAcronym[0];
                    let cleanedParenAcronym = extracted.replace(/['’]\d{2,4}$/, '').replace(/['’]s$/, '');
                    if (cleanedParenAcronym.length >= 2 && cleanedParenAcronym.length <= 12 &&
                        !/^\d+$/.test(cleanedParenAcronym) &&
                        !IGNORE_KEYWORDS.includes(cleanedParenAcronym.toLowerCase()) &&
                        !["was", "formerly", "inc", "ltd", "vol", "no"].includes(cleanedParenAcronym.toLowerCase())) {
                        acronyms.add(cleanedParenAcronym.toLowerCase());
                    }
                }
                else {
                    const simplerPatterns = part.match(/([A-Z]{2,}[0-9']*\b|[A-Z]+[0-9]+[A-Z0-9]*\b)/g);
                    if (simplerPatterns) {
                        simplerPatterns.forEach(pAcronym => {
                            let cleanedParenAcronym = pAcronym.replace(/['’]\d{2,4}$/, '').replace(/['’]s$/, '');
                            if (cleanedParenAcronym.length >= 2 && cleanedParenAcronym.length <= 12 &&
                                !/^\d+$/.test(cleanedParenAcronym) &&
                                !IGNORE_KEYWORDS.includes(cleanedParenAcronym.toLowerCase()) &&
                                !["was", "formerly"].includes(cleanedParenAcronym.toLowerCase())) {
                                acronyms.add(cleanedParenAcronym.toLowerCase());
                            }
                        });
                    }
                }
            }
        });
    }
    let textWithoutParens = originalVenueName.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    textWithoutParens = textWithoutParens.replace(/\b(Proceedings\s+of\s+(the)?|Proc\.\s+of\s+(the)?|International\s+Conference\s+on|Intl\.\s+Conf\.\s+on|Conference\s+on|Symposium\s+on|Workshop\s+on|Journal\s+of)\b/gi, ' ').trim();
    const words = textWithoutParens.split(/[\s\-‑\/.,:;&]+/);
    const commonNonAcronymWords = new Set([...IGNORE_KEYWORDS, 'acm', 'ieee', 'aaai', 'usenix', 'ifip', 'proc', 'data', 'services', 'models', 'security', 'time', 'proceedings', 'journal', 'conference', 'conf', 'symposium', 'symp', 'workshop', 'ws', 'international', 'intl', 'natl', 'national', 'annual', 'vol', 'volume', 'no', 'number', 'pp', 'page', 'pages', 'part', 'edition', 'of', 'the', 'on', 'in', 'and', 'for', 'to', 'at', 'st', 'nd', 'rd', 'th', 'springer', 'elsevier', 'wiley', 'press', 'extended', 'abstracts', 'poster', 'session', 'sessions', 'doctoral', 'companion', 'joint', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'advances', 'systems', 'networks', 'computing', 'applications', 'technology', 'technologies', 'research', 'science', 'sciences', 'engineering', 'management', 'information', 'communication', 'communications', 'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec', 'letters', 'bulletin', 'archive', 'archives', 'series', 'chapter', 'section', 'tutorial', 'tutorials', 'report', 'technical', 'tech', ...(Array.from({ length: 75 }, (_, i) => (1970 + i).toString()))]);
    words.forEach(word => {
        const cleanWordOriginalCase = word.trim();
        if (cleanWordOriginalCase.length >= 2 && cleanWordOriginalCase.length <= 12 && !/^\d+$/.test(cleanWordOriginalCase)) {
            if ((!commonNonAcronymWords.has(cleanWordOriginalCase.toLowerCase())) &&
                (/^[A-Z0-9]+$/.test(cleanWordOriginalCase) ||
                    /^[A-Z][a-z]+[A-Z]+[A-Za-z0-9]*$/.test(cleanWordOriginalCase) ||
                    /^[A-Z][A-Z0-9]+$/.test(cleanWordOriginalCase) && cleanWordOriginalCase.length <= 5)) {
                acronyms.add(cleanWordOriginalCase.toLowerCase());
            }
        }
    });
    if (acronyms.size === 0 &&
        originalVenueName.length >= 2 && originalVenueName.length <= 10 &&
        !originalVenueName.includes(" ") && /^[A-Za-z0-9]+$/.test(originalVenueName) &&
        !/^\d+$/.test(originalVenueName) &&
        !commonNonAcronymWords.has(originalVenueName.toLowerCase())) {
        acronyms.add(originalVenueName.toLowerCase());
    }
    return Array.from(acronyms);
}
function getPossibleAcronymsFromVenue(venueText) {
    if (!venueText || typeof venueText !== "string") return [];
    try {
        // Reuse the existing acronym extractor and return a small set of uppercase candidates.
        const extracted = extractPotentialAcronymsFromText(venueText) || [];
        const out = [];
        const seen = new Set();
        for (const a of extracted) {
            if (!a) continue;
            const upper = String(a).trim().toUpperCase();
            if (!upper || upper.length < 2 || upper.length > 12) continue;
            if (!/^[A-Z0-9]+$/.test(upper)) continue;
            if (!seen.has(upper)) {
                seen.add(upper);
                out.push(upper);
            }
            if (out.length >= 8) break;
        }
        return out;
    } catch (e) {
        return [];
    }
}
function buildBadgeDetailItems(rank, system, reason = null, meta = null) {
    const items = [];
    items.push({ label: 'Source', value: system });
    items.push({ label: 'Rank', value: rank });
    if (reason) {
        items.push({ label: 'Reason', value: reason });
    }
    const authorship = normalizePublicationAuthorship(meta?.authorship, meta?.authorCount ?? null);
    if (authorship.status === 'verified' && authorship.position && authorship.authorCount) {
        items.push({ label: 'Authorship', value: formatAuthorshipSummary(authorship) });
    }
    if (meta && typeof meta === 'object' && currentSettings.showDebugDetails !== false) {
        const pct = (value) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : null);
        if (meta.sourceYear) {
            items.push({ label: 'Ranking Snapshot Year', value: String(meta.sourceYear) });
        }
        if (meta.sourceYearFallback) {
            items.push({ label: 'Snapshot Mode', value: 'Latest available snapshot' });
        }
        if (meta.matchedVenue && (system === 'CORE' || system === 'SJR')) {
            items.push({ label: 'Matched Venue', value: meta.matchedVenue });
        }
        if (meta.matchedSourceId && system === 'SJR') {
            items.push({ label: 'SJR Source ID', value: String(meta.matchedSourceId) });
        }
        if (pct(meta.venueMatchConfidence) && (system === 'CORE' || system === 'SJR')) {
            items.push({ label: 'Venue Confidence', value: pct(meta.venueMatchConfidence) });
        }
        if (pct(meta.matchConfidence)) {
            items.push({ label: 'DBLP Title Match', value: pct(meta.matchConfidence) });
        }
        if (meta.decisionStatus) {
            items.push({ label: 'Decision', value: String(meta.decisionStatus) });
        }
        if (pct(meta.confidence) && !pct(meta.venueMatchConfidence) && !pct(meta.matchConfidence)) {
            items.push({ label: 'Confidence', value: pct(meta.confidence) });
        }
    }
    return items.filter(item => item.value);
}
function ensureBadgePopover() {
    if (gsrBadgePopoverEl && document.body.contains(gsrBadgePopoverEl)) {
        return gsrBadgePopoverEl;
    }
    const popover = document.createElement('div');
    popover.id = BADGE_POPOVER_ID;
    popover.className = 'gsr-badge-popover';
    popover.setAttribute('role', 'tooltip');
    popover.setAttribute('aria-hidden', 'true');
    document.body.appendChild(popover);
    gsrBadgePopoverEl = popover;
    return popover;
}
function hideBadgePopover(immediate = false) {
    if (gsrBadgePopoverHideTimeout) {
        clearTimeout(gsrBadgePopoverHideTimeout);
        gsrBadgePopoverHideTimeout = null;
    }
    const applyHide = () => {
        const popover = ensureBadgePopover();
        popover.classList.remove('is-visible');
        popover.innerHTML = '';
        popover.setAttribute('aria-hidden', 'true');
    };
    if (immediate) {
        applyHide();
        return;
    }
    gsrBadgePopoverHideTimeout = window.setTimeout(applyHide, 120);
}
function showBadgePopover(anchor, items) {
    if (!anchor || !items.length) {
        hideBadgePopover(true);
        return;
    }
    if (gsrBadgePopoverHideTimeout) {
        clearTimeout(gsrBadgePopoverHideTimeout);
        gsrBadgePopoverHideTimeout = null;
    }
    const popover = ensureBadgePopover();
    popover.innerHTML = items
        .map(item => `<div class="gsr-badge-popover__row"><span class="gsr-badge-popover__label">${escapeHtml(item.label)}</span><span class="gsr-badge-popover__value">${escapeHtml(item.value)}</span></div>`)
        .join('');
    popover.classList.add('is-visible');
    popover.setAttribute('aria-hidden', 'false');
    const rect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    let left = rect.left + (rect.width / 2) - (popoverRect.width / 2);
    let top = rect.bottom + 10;
    const maxLeft = window.innerWidth - popoverRect.width - 12;
    left = Math.max(12, Math.min(left, maxLeft));
    if (top + popoverRect.height > window.innerHeight - 12) {
        top = rect.top - popoverRect.height - 10;
    }
    popover.style.left = `${Math.max(12, left)}px`;
    popover.style.top = `${Math.max(12, top)}px`;
}
function attachBadgeDetailBehavior(badge, rank, system, reason = null, meta = null) {
    const items = buildBadgeDetailItems(rank, system, reason, meta);
    if (!items.length) {
        return;
    }
    badge.removeAttribute('title');
    badge.setAttribute('aria-describedby', BADGE_POPOVER_ID);
    if (meta) {
        badge.setAttribute('role', 'button');
    }
    const show = () => showBadgePopover(badge, items);
    badge.addEventListener('mouseenter', show);
    badge.addEventListener('focus', show);
    badge.addEventListener('mouseleave', () => hideBadgePopover(false));
    badge.addEventListener('blur', () => hideBadgePopover(false));
    badge.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (meta) {
            openDetailDrawer(meta);
        }
    });
    badge.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && meta) {
            event.preventDefault();
            openDetailDrawer(meta);
        }
        if (event.key === 'Escape') {
            hideBadgePopover(true);
        }
    });
}
function setRowRankingMetadata(rowElement, info) {
    if (!rowElement || !info)
        return;
    const statusKind = getRowStatusKind(info);
    const authorRoles = getAuthorshipRoles(info);
    rowElement.dataset.gsrSystem = String(info.system || 'UNKNOWN').toLowerCase();
    rowElement.dataset.gsrRank = normalizeRankKey(info.rank || 'N/A');
    rowElement.dataset.gsrStatus = statusKind;
    if (authorRoles.length) {
        rowElement.dataset.gsrAuthorRoles = authorRoles.join(' ');
    }
    else {
        delete rowElement.dataset.gsrAuthorRoles;
    }
    rowElement.dataset.gsrAuthorStatus = normalizePublicationAuthorship(info.authorship, info.authorCount ?? null).status || 'unknown';
    rowElement.classList.toggle('gsr-row--needs-review', statusKind !== 'ranked');
    rowElement.classList.toggle('gsr-row--ranked', statusKind === 'ranked');
    rowElement.classList.toggle('gsr-row--authorship', authorRoles.length > 0);
    updateRowAuthorshipRail(rowElement, info);
}
function isSameSummaryFilter(a, b) {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
function getEffectiveSummaryFilter() {
    return previewSummaryFilter ?? activeSummaryFilter;
}
function matchesSummaryFilter(rowElement, filter) {
    if (!filter || !rowElement)
        return true;
    const status = rowElement.dataset.gsrStatus || '';
    const system = rowElement.dataset.gsrSystem || '';
    const rank = rowElement.dataset.gsrRank || '';
    const authorRoles = String(rowElement.dataset.gsrAuthorRoles || '').split(/\s+/).filter(Boolean);
    if (filter.type === 'preset') {
        if (filter.mode === 'ranked-only') {
            return status === 'ranked';
        }
        if (filter.mode === 'needs-review') {
            return status === 'dblp-missing' || status === 'unranked';
        }
        return true;
    }
    if (filter.type === 'status') {
        return status === filter.status;
    }
    if (filter.type === 'authorship') {
        return authorRoles.includes(filter.role);
    }
    return system === filter.system && rank === filter.rank;
}
function syncSummaryFilterButtons() {
    const panel = document.getElementById(SUMMARY_PANEL_ID);
    if (!panel)
        return;
    panel.classList.toggle('gsr-summary-card--has-active-filter', !!activeSummaryFilter);
    panel.classList.toggle('gsr-summary-card--has-rank-selection', activeSummaryFilter?.type === 'rank' || activeSummaryFilter?.type === 'status');
    panel.querySelectorAll('[data-gsr-filter-type]').forEach((button) => {
        let isActive = false;
        let isPreviewed = false;
        const type = button.getAttribute('data-gsr-filter-type');
        if (type === 'reset') {
            isActive = !activeSummaryFilter;
        }
        else if (type === 'rank' && activeSummaryFilter?.type === 'rank') {
            isActive = activeSummaryFilter.system === button.getAttribute('data-gsr-system')
                && activeSummaryFilter.rank === button.getAttribute('data-gsr-rank');
        }
        else if (type === 'status' && activeSummaryFilter?.type === 'status') {
            isActive = activeSummaryFilter.status === button.getAttribute('data-gsr-status');
        }
        else if (type === 'authorship' && activeSummaryFilter?.type === 'authorship') {
            isActive = activeSummaryFilter.role === button.getAttribute('data-gsr-author-role');
        }
        else if (type === 'preset' && activeSummaryFilter?.type === 'preset') {
            isActive = activeSummaryFilter.mode === button.getAttribute('data-gsr-mode');
        }
        if (type === 'rank' && previewSummaryFilter?.type === 'rank') {
            isPreviewed = previewSummaryFilter.system === button.getAttribute('data-gsr-system')
                && previewSummaryFilter.rank === button.getAttribute('data-gsr-rank');
        }
        else if (type === 'status' && previewSummaryFilter?.type === 'status') {
            isPreviewed = previewSummaryFilter.status === button.getAttribute('data-gsr-status');
        }
        else if (type === 'authorship' && previewSummaryFilter?.type === 'authorship') {
            isPreviewed = previewSummaryFilter.role === button.getAttribute('data-gsr-author-role');
        }
        else if (type === 'preset' && previewSummaryFilter?.type === 'preset') {
            isPreviewed = previewSummaryFilter.mode === button.getAttribute('data-gsr-mode');
        }
        button.classList.toggle('is-active', isActive);
        button.classList.toggle('is-previewed', !isActive && isPreviewed);
        button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
}
function applyActiveSummaryFilter() {
    const effectiveFilter = getEffectiveSummaryFilter();
    const hasPreview = !!previewSummaryFilter;
    const hasActiveSelection = !!activeSummaryFilter && !hasPreview;
    document.querySelectorAll('tr.gsc_a_tr').forEach((row) => {
        const matches = matchesSummaryFilter(row, effectiveFilter);
        row.classList.toggle('gsr-row--dimmed', !!effectiveFilter && !matches);
        row.classList.toggle('gsr-row--highlighted', !!effectiveFilter && matches);
        row.classList.toggle('gsr-row--selected', hasActiveSelection);
        row.classList.toggle('gsr-row--preview', hasPreview);
        row.classList.toggle('gsr-row--dimmed-strong', hasActiveSelection && !matches);
        row.classList.toggle('gsr-row--highlighted-strong', hasActiveSelection && matches);
    });
    syncSummaryFilterButtons();
}
function toggleSummaryFilter(nextFilter) {
    const sameFilter = isSameSummaryFilter(activeSummaryFilter, nextFilter);
    activeSummaryFilter = sameFilter ? null : nextFilter;
    previewSummaryFilter = null;
    applyActiveSummaryFilter();
}
function setSummaryFilterPreview(nextFilter) {
    if (isSameSummaryFilter(previewSummaryFilter, nextFilter)) {
        return;
    }
    previewSummaryFilter = nextFilter;
    applyActiveSummaryFilter();
}
function clearSummaryFilterPreview(nextFilter) {
    if (!isSameSummaryFilter(previewSummaryFilter, nextFilter)) {
        return;
    }
    previewSummaryFilter = null;
    applyActiveSummaryFilter();
}

// Short qualifiers for abstain chips. The chip stays compact next to the
// paper title; the FULL reason always remains available in the popover (see
// buildBadgeDetailItems) and in the badge's aria-label.
const BADGE_REASON_QUALIFIERS = Object.freeze({
    'workshop': 'Workshop',
    'short-paper': 'Short paper',
    'demo/poster': 'Demo/Poster',
    'extended abstract': 'Abstract',
    'ambiguous venue match': 'Ambiguous',
    'ambiguous journal match': 'Ambiguous',
    'sjr historical coverage unavailable': 'No SJR data',
    'preprint': 'Preprint',
});
function getBadgeReasonQualifier(reason) {
    const key = String(reason || '').trim().toLowerCase();
    if (!key) {
        return null;
    }
    return BADGE_REASON_QUALIFIERS[key] || String(reason).trim();
}
function createRankBadgeElement(rank, system, reason = null, meta = null) {
    const badge = document.createElement('span');
    badge.classList.add('gsr-rank-badge');
    badge.dataset.gsrSystem = String(system || 'unknown').toLowerCase();
    let fullLabel;
    if (system === 'DBLP' && rank === DBLP_ENTRY_MISSING_LABEL) {
        // Chip stays short; the full state lives in the popover and aria-label.
        badge.textContent = 'No DBLP';
        fullLabel = `${system} ${DBLP_ENTRY_MISSING_LABEL}`;
    }
    else if (rank === 'N/A' && reason) {
        badge.textContent = getBadgeReasonQualifier(reason);
        fullLabel = `${system} not scored: ${reason}`;
    }
    else {
        badge.textContent = rank;
        fullLabel = `${system} ${rank}`;
    }
    badge.setAttribute('tabindex', '0');
    badge.setAttribute('aria-label', fullLabel);

    if (system === 'DBLP' && rank === DBLP_ENTRY_MISSING_LABEL) {
        badge.classList.add('badge-missing-dblp', 'gsr-rank-badge--ranked', 'gsr-rank-badge--neutral');
        badge.dataset.gsrKind = 'dblp-missing';
        attachBadgeDetailBehavior(badge, rank, system, reason, meta);
        return badge;
    }
    if (system === 'SJR' && SJR_QUARTILES.includes(rank)) {
        badge.classList.add('gsr-rank-badge--sjr', 'gsr-rank-badge--ranked', `gsr-rank-badge--${rank.toLowerCase()}`);
        badge.dataset.gsrKind = 'ranked';
        attachBadgeDetailBehavior(badge, rank, system, reason, meta);
        return badge;
    }
    if (system === 'CORE' && VALID_RANKS.includes(rank)) {
        const rankKey = normalizeRankKey(rank);
        badge.classList.add('gsr-rank-badge--core', 'gsr-rank-badge--ranked', `gsr-rank-badge--${rankKey}`);
        badge.dataset.gsrKind = 'ranked';
        attachBadgeDetailBehavior(badge, rank, system, reason, meta);
        return badge;
    }
    if (rank === 'N/A') {
        badge.classList.add('gsr-rank-badge--neutral', 'gsr-rank-badge--ranked');
        badge.dataset.gsrKind = 'unranked';
        attachBadgeDetailBehavior(badge, rank, system, reason, meta);
        return badge;
    }
    return null;
}
function createAuthorshipRailElement(authorship, meta = null) {
    const normalized = normalizePublicationAuthorship(authorship, meta?.authorCount ?? null);
    const label = formatAuthorshipRailLabel(normalized);
    if (!label) {
        return null;
    }
    const rail = document.createElement('span');
    rail.className = `gsr-authorship-rail gsr-authorship-rail--${getAuthorshipRailRoleClass(normalized)}`;
    rail.dataset.gsrKind = 'authorship';
    rail.dataset.gsrAuthorRoles = normalized.roles.join(' ');
    rail.setAttribute('tabindex', '0');
    rail.setAttribute('aria-label', `${label} author: ${formatAuthorshipSummary(normalized)}`);
    rail.setAttribute('title', formatAuthorshipSummary(normalized));
    const railText = document.createElement('span');
    railText.className = 'gsr-authorship-rail__text';
    railText.textContent = label;
    rail.appendChild(railText);
    const items = [
        { label: 'Authorship', value: label },
        { label: 'DBLP Position', value: `${normalized.position} of ${normalized.authorCount}` },
        { label: 'Source', value: 'DBLP author order' },
    ];
    rail.setAttribute('aria-describedby', BADGE_POPOVER_ID);
    if (meta) {
        rail.setAttribute('role', 'button');
    }
    const show = () => showBadgePopover(rail, items);
    rail.addEventListener('mouseenter', show);
    rail.addEventListener('focus', show);
    rail.addEventListener('mouseleave', () => hideBadgePopover(false));
    rail.addEventListener('blur', () => hideBadgePopover(false));
    rail.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (meta) {
            openDetailDrawer(meta);
        }
    });
    rail.addEventListener('keydown', (event) => {
        if ((event.key === 'Enter' || event.key === ' ') && meta) {
            event.preventDefault();
            openDetailDrawer(meta);
        }
        if (event.key === 'Escape') {
            hideBadgePopover(true);
        }
    });
    return rail;
}
function updateRowAuthorshipRail(rowElement, info) {
    const titleCell = rowElement?.querySelector?.('td.gsc_a_t');
    if (!titleCell) {
        return;
    }
    titleCell.querySelector('span.gsr-authorship-rail')?.remove();
    const rail = createAuthorshipRailElement(info?.authorship, info);
    if (rail) {
        titleCell.insertAdjacentElement('afterbegin', rail);
    }
}
function displayRankBadgeAfterTitle(rowElement, rank, system, reason = null, meta = null) {
    const titleCell = rowElement.querySelector('td.gsc_a_t');
    if (titleCell) {
        const oldBadge = titleCell.querySelector('span.gsr-rank-badge-inline');
        oldBadge?.remove(); // Ensure any previous badge is cleared first
        const oldAuthorshipRail = titleCell.querySelector('span.gsr-authorship-rail');
        oldAuthorshipRail?.remove();
    }
    else {
        return; // No title cell found
    }
    // Original logic: if (!VALID_RANKS.includes(rank)) return;
    // We DO want to create N/A badges if rank is "N/A" via createRankBadgeElement
    // So, only return if createRankBadgeElement itself returns null (e.g. invalid rank string not in VALID_RANKS and not N/A)
    const titleLinkElement = rowElement.querySelector('td.gsc_a_t a.gsc_a_at');
    if (!titleLinkElement)
        return;
    const badge = createRankBadgeElement(rank, system, reason, meta); // Can return N/A badge or null
    if (badge) {
        badge.classList.add('gsr-rank-badge-inline');
        titleLinkElement.insertAdjacentElement('afterend', badge);
    }
    setRowRankingMetadata(rowElement, { rank, system, reason, ...(meta || {}) });
    if (activeSummaryFilter || previewSummaryFilter) {
        applyActiveSummaryFilter();
    }
}

// --- START: Manual Rank/Quartile Search Utility (Phase 2) ---
async function populateVenueDatalistIfNeeded() {
    if (gsrVenueDatalistPopulated)
        return;
    gsrVenueDatalistPopulated = true;
    try {
        const datalistId = 'gsr-venue-datalist';
        let datalist = document.getElementById(datalistId);
        if (!datalist) {
            datalist = document.createElement('datalist');
            datalist.id = datalistId;
            document.body.appendChild(datalist);
        }
        const coreData = await loadCoreDataForFile(getCoreDataFileForYear(null));
        const seen = new Set();
        for (const entry of coreData) {
            const candidates = [entry.acronym, entry.title].filter(Boolean);
            for (const c of candidates) {
                const val = String(c || '').trim();
                if (!val)
                    continue;
                const key = val.toLowerCase();
                if (seen.has(key))
                    continue;
                seen.add(key);
                const opt = document.createElement('option');
                opt.value = val;
                datalist.appendChild(opt);
            }
        }
    }
    catch (err) {
        console.warn('GSR: Failed to populate venue autocomplete list.', err);
        // allow retry next time
        gsrVenueDatalistPopulated = false;
    }
}

function ensureSearchUtilityOverlay() {
    if (gsrSearchOverlayEl && document.body.contains(gsrSearchOverlayEl)) {
        return gsrSearchOverlayEl;
    }
    // Built on the shared dialog scaffold (header/close/Escape/backdrop/focus
    // trap come from createDialogOverlay); only the search form is bespoke.
    const scaffold = createDialogOverlay({
        overlayId: 'gsr-search-utility-overlay',
        panelClass: 'gsr-search-panel',
        titleId: 'gsr-search-panel-title',
        titleText: 'Venue Explorer',
        descriptionId: 'gsr-search-panel-description',
        descriptionText: 'Search across the bundled CORE and SJR datasets, review historical snapshots, and inspect ambiguity or alias hints without leaving Google Scholar.',
        onClose: () => {
            hideBadgePopover(true);
            const input = document.getElementById('gsr-venue-search-input');
            const year = document.getElementById('gsr-venue-search-year');
            const resultHost = document.getElementById('gsr-venue-search-result');
            if (input instanceof HTMLInputElement) input.value = '';
            if (year instanceof HTMLSelectElement) year.value = '';
            if (resultHost instanceof HTMLElement) resultHost.textContent = 'Choose a scope, enter a venue and optionally a year, then press Search.';
        }
    });
    const { overlay, panel, body } = scaffold;
    const row1 = document.createElement('div');
    row1.className = 'gsr-search-row';
    const venueLabel = document.createElement('label');
    venueLabel.className = 'gsr-search-label';
    venueLabel.htmlFor = 'gsr-venue-search-input';
    venueLabel.textContent = 'Venue Name or Acronym';
    body.appendChild(venueLabel);
    const venueInput = document.createElement('input');
    venueInput.type = 'text';
    venueInput.placeholder = 'Venue name or acronym (e.g., SIGCOMM, TPAMI)';
    venueInput.id = 'gsr-venue-search-input';
    venueInput.name = 'venue';
    venueInput.autocomplete = 'off';
    venueInput.setAttribute('list', 'gsr-venue-datalist');
    row1.appendChild(venueInput);
    body.appendChild(row1);
    const rowType = document.createElement('div');
    rowType.className = 'gsr-search-row gsr-search-type-row';
    const typeLabel = document.createElement('span');
    typeLabel.className = 'gsr-type-label';
    typeLabel.textContent = 'Scope:';
    typeLabel.id = 'gsr-venue-type-label';
    rowType.appendChild(typeLabel);
    const mkRadio = (id, value, labelText, checked) => {
        const wrap = document.createElement('label');
        wrap.className = 'gsr-radio-wrap';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'gsr-venue-type';
        input.id = id;
        input.value = value;
        input.checked = !!checked;
        input.setAttribute('aria-labelledby', 'gsr-venue-type-label');
        const txt = document.createElement('span');
        txt.textContent = labelText;
        wrap.appendChild(input);
        wrap.appendChild(txt);
        return wrap;
    };

    rowType.appendChild(mkRadio('gsr-type-auto', 'auto', 'Auto', true));
    rowType.appendChild(mkRadio('gsr-type-conference', 'conference', 'Conference', false));
    rowType.appendChild(mkRadio('gsr-type-journal', 'journal', 'Journal/Transaction', false));
    body.appendChild(rowType);
    const row2 = document.createElement('div');
    row2.className = 'gsr-search-row';
    const yearLabel = document.createElement('label');
    yearLabel.className = 'gsr-search-label';
    yearLabel.htmlFor = 'gsr-venue-search-year';
    yearLabel.textContent = 'Publication Year';
    body.appendChild(yearLabel);
    const yearSelect = document.createElement('select');
    yearSelect.id = 'gsr-venue-search-year';
    yearSelect.name = 'year';
    const yearAuto = document.createElement('option');
    yearAuto.value = '';
    yearAuto.textContent = 'Year (Auto)';
    yearSelect.appendChild(yearAuto);
    for (let y = 2026; y >= SJR_DATASET_START_YEAR; y--) {
        const opt = document.createElement('option');
        opt.value = String(y);
        opt.textContent = String(y);
        yearSelect.appendChild(opt);
    }
    row2.appendChild(yearSelect);
    body.appendChild(row2);
    const actions = document.createElement('div');
    actions.className = 'gsr-search-actions';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    const searchBtn = document.createElement('button');
    searchBtn.type = 'button';
    searchBtn.textContent = 'Search';
    searchBtn.className = 'gsr-button gsr-button--primary';
    clearBtn.className = 'gsr-button gsr-button--ghost';
    actions.appendChild(clearBtn);
    actions.appendChild(searchBtn);
    body.appendChild(actions);
    const result = document.createElement('div');
    result.className = 'gsr-search-result';
    result.id = 'gsr-venue-search-result';
    result.setAttribute('role', 'status');
    result.setAttribute('aria-live', 'polite');
    result.textContent = 'Choose a scope, enter a venue and optionally a year, then press Search.';
    body.appendChild(result);
    // Backdrop click, the header close button, Escape, and the focus trap are
    // wired by the shared scaffold; field clearing happens in onClose above.
    const closeOverlay = () => closeDialogOverlay(overlay, panel);
    clearBtn.addEventListener('click', () => {
        venueInput.value = '';
        yearSelect.value = '';
        result.textContent = 'Choose a scope, enter a venue and optionally a year, then press Search.';
        venueInput.focus();
    });
    const doSearch = async () => {
        const venueQuery = String(venueInput.value || '').trim();
        if (!venueQuery) {
            result.textContent = 'Please enter a venue name or acronym.';
            venueInput.focus();
            return;
        }
        const yearVal = yearSelect.value ? parseInt(yearSelect.value, 10) : null;
        const selectedType = (panel.querySelector('input[name="gsr-venue-type"]:checked')?.value) || 'auto';
        result.textContent = 'Searching…';
        try {
            result.innerHTML = '';
            const addSection = (titleText) => {
                const section = document.createElement('section');
                section.className = 'gsr-venue-explorer__section';
                const heading = document.createElement('h4');
                heading.className = 'gsr-venue-explorer__title';
                heading.textContent = titleText;
                section.appendChild(heading);
                result.appendChild(section);
                return section;
            };
            const addItem = (label, value, host = result) => {
                const line = document.createElement('div');
                line.className = 'gsr-result-item';
                const l = document.createElement('span');
                l.className = 'gsr-result-label';
                l.textContent = label;
                const v = document.createElement('span');
                v.textContent = value;
                line.appendChild(l);
                line.appendChild(v);
                host.appendChild(line);
            };
            const addNote = (text, host = result) => {
                const note = document.createElement('div');
                note.className = 'gsr-result-item gsr-result-item--note';
                note.textContent = text;
                host.appendChild(note);
            };
            if (selectedType === 'auto' || selectedType === 'conference') {
                const section = addSection('Conference / CORE');
                const conferenceSearch = await resolveConferenceSearchQuery(venueQuery, yearVal);
                const primary = conferenceSearch.primary;
                const primaryYear = primary?.sourceYear ?? getCoreDatasetYear(getCoreDataFileForYear(yearVal));
                let primaryValue = 'Not found';
                if (primary.status === DECISION_STATUS.MATCHED && VALID_RANKS.includes(primary.rank)) {
                    primaryValue = primary.rank;
                }
                else if (primary.status === DECISION_STATUS.UNRANKED) {
                    primaryValue = 'Unranked';
                }
                else if (primary.status === DECISION_STATUS.AMBIGUOUS) {
                    primaryValue = 'Ambiguous';
                }
                addItem(`Conference (CORE ${primaryYear || ''})`, primaryValue, section);
                if (primary.matchedVenue) {
                    addItem('Matched Venue', primary.matchedVenue, section);
                    if (primary.matchedVenue.toLowerCase() !== venueQuery.toLowerCase()) {
                        addItem('Alias / Rename Hint', `${venueQuery} resolved to ${primary.matchedVenue}`, section);
                    }
                }
                if (primary.status === DECISION_STATUS.UNRANKED && primary.rawRankLabel) {
                    addItem('Current CORE status', formatCoreStatusLabel(primary.rawRankLabel), section);
                }
                if (conferenceSearch.latestRankedSnapshot
                    && conferenceSearch.latestRankedSnapshot.sourceYear
                    && conferenceSearch.latestRankedSnapshot.sourceYear !== primary.sourceYear) {
                    addItem('Latest ranked snapshot', `CORE ${conferenceSearch.latestRankedSnapshot.sourceYear} · ${conferenceSearch.latestRankedSnapshot.rank}`, section);
                }
                const conferenceHistory = await buildConferenceSearchHistory(venueQuery);
                if (conferenceHistory.length) {
                    addItem('History', conferenceHistory
                        .map((entry) => `CORE ${entry.sourceYear}: ${entry.status === DECISION_STATUS.MATCHED ? entry.rank : (entry.status === DECISION_STATUS.UNRANKED ? 'Unranked' : humanizeIdentifier(entry.status))}`)
                        .join(' | '), section);
                }
                if (primary.status === DECISION_STATUS.AMBIGUOUS) {
                    addNote('Multiple CORE venues matched this query too closely. Please use a more specific venue title or inspect the candidate list below.', section);
                    const candidates = getTopCandidates(primary);
                    if (candidates.length) {
                        addItem('Candidates', candidates.map((candidate) => candidate.title || candidate.acronym || candidate.venue || 'Candidate').join(' | '), section);
                    }
                }
                else if (primary.status === DECISION_STATUS.UNRANKED) {
                    addNote(conferenceSearch.latestRankedSnapshot
                        ? 'This venue exists in the current CORE snapshot but is not currently ranked there. The latest ranked snapshot is shown above.'
                        : 'This venue exists in the current CORE snapshot but is currently unranked there.', section);
                }
                else if (primary.status !== DECISION_STATUS.MATCHED) {
                    addNote(conferenceSearch.latestRankedSnapshot
                        ? 'No ranked result was found in the selected CORE snapshot. The latest ranked snapshot is shown above.'
                        : 'No match was found in the bundled CORE snapshots for this query.', section);
                }
            }
            if (selectedType === 'auto' || selectedType === 'journal') {
                const section = addSection('Journal / SJR');
                const sjr = await resolveSjrQuartile(venueQuery, yearVal);
                const sjrQuartile = (sjr.status === 'success' && sjr.quartile) ? sjr.quartile : null;
                addItem('Journal / Transaction (SJR)', (sjrQuartile && SJR_QUARTILES.includes(sjrQuartile)) ? sjrQuartile : (sjr.status === 'ambiguous' ? 'Ambiguous' : 'Not found'), section);
                if (sjr.status === 'success' && sjr.resolvedTitle) {
                    addItem('Matched Journal', sjr.resolvedTitle, section);
                    if (sjr.resolvedTitle.toLowerCase() !== venueQuery.toLowerCase()) {
                        addItem('Alias / Rename Hint', `${venueQuery} resolved to ${sjr.resolvedTitle}`, section);
                    }
                }
                const journalHistory = await buildJournalSearchHistory(venueQuery);
                if (journalHistory.length) {
                    addItem('History', journalHistory.map((entry) => `${entry.sourceYear}: ${entry.quartile}`).join(' | '), section);
                }
                if (sjr.status === 'ambiguous') {
                    addNote('Multiple SJR journals matched this query too closely. Try a fuller journal title.', section);
                }
                else if (!(sjrQuartile && SJR_QUARTILES.includes(sjrQuartile))) {
                    addNote('No match in the local SJR dataset for this query.', section);
                }
            }
            if (!result.childNodes.length) {
                result.textContent = 'No result was found in the bundled ranking datasets.';
            }
            else if (selectedType === 'auto') {
                const intro = document.createElement('div');
                intro.className = 'gsr-result-item gsr-result-item--note';
                intro.textContent = 'Auto mode searched both conference and journal datasets from one surface.';
                result.prepend(intro);
            }
        }
        catch (err) {
            console.warn('GSR: Manual venue search failed.', err);
            result.textContent = 'Search failed. Please try again.';
        }
    };
    searchBtn.addEventListener('click', doSearch);
    venueInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });
    gsrSearchOverlayEl = overlay;
    return overlay;
}

function openSearchUtilityOverlay() {
    const overlay = ensureSearchUtilityOverlay();
    const panel = overlay.querySelector('.gsr-search-panel');
    if (!(panel instanceof HTMLElement)) {
        return;
    }
    populateVenueDatalistIfNeeded();
    openDialogOverlay(overlay, panel, '#gsr-venue-search-input');
    setTimeout(() => {
        const input = document.getElementById('gsr-venue-search-input');
        if (input instanceof HTMLInputElement) {
            input.select();
        }
    }, 0);
}

function createAboutSection(titleText, bodyNodes) {
    const section = document.createElement('section');
    section.className = 'gsr-about-panel__section';
    const title = document.createElement('h4');
    title.className = 'gsr-about-panel__section-title';
    title.textContent = titleText;
    section.appendChild(title);
    bodyNodes.forEach((node) => section.appendChild(node));
    return section;
}

function createAboutParagraph(text) {
    const paragraph = document.createElement('p');
    paragraph.className = 'gsr-about-panel__text';
    paragraph.textContent = text;
    return paragraph;
}

function createAboutList(items) {
    const list = document.createElement('ul');
    list.className = 'gsr-about-panel__list';
    items.forEach((item) => {
        const entry = document.createElement('li');
        entry.className = 'gsr-about-panel__list-item';
        if (typeof item === 'string') {
            entry.textContent = item;
        }
        else {
            if (item.title) {
                const strong = document.createElement('strong');
                strong.textContent = item.title;
                entry.appendChild(strong);
            }
            if (item.body) {
                entry.appendChild(document.createTextNode(item.title ? ` ${item.body}` : item.body));
            }
            if (Array.isArray(item.extraNodes)) {
                item.extraNodes.forEach((node) => entry.appendChild(node));
            }
        }
        list.appendChild(entry);
    });
    return list;
}

function ensureAboutOverlay() {
    if (gsrAboutOverlayEl && document.body.contains(gsrAboutOverlayEl)) {
        return gsrAboutOverlayEl;
    }
    // Built on the shared dialog scaffold; only the About content is bespoke.
    const scaffold = createDialogOverlay({
        overlayId: 'gsr-about-overlay',
        panelClass: 'gsr-search-panel gsr-about-panel',
        titleId: 'gsr-about-panel-title',
        titleText: 'About Google Scholar Venue Ranker',
        descriptionId: 'gsr-about-panel-description',
        descriptionText: 'Open-source ranking logic, data sources, and editorial rules used by the extension.'
    });
    const { overlay, panel, body } = scaffold;
    const content = document.createElement('div');
    content.className = 'gsr-about-panel__content';
    const intro = document.createElement('p');
    intro.className = 'gsr-about-panel__lede';
    intro.textContent = 'This is an open-source extension developed by ';
    const authorLink = document.createElement('a');
    authorLink.href = 'https://naveedanwarbhatti.github.io/';
    authorLink.target = '_blank';
    authorLink.rel = 'noopener noreferrer';
    authorLink.textContent = 'Naveed Bhatti';
    intro.appendChild(authorLink);
    intro.appendChild(document.createTextNode('. It aims to make Google Scholar publication lists more trustworthy by resolving venues against curated bibliographic sources instead of relying on profile text alone.'));
    content.appendChild(intro);
    content.appendChild(createAboutSection('Why We Trust DBLP for Venue Extraction', [
        createAboutParagraph('Google Scholar profiles are useful for discovery, but profile entries can be added or edited by users and sometimes contain noisy or incomplete venue text. When a paper can be matched to DBLP, the extension treats DBLP as the authoritative source for venue extraction because it is curated bibliographic metadata, not free-form profile text.')
    ]));
    content.appendChild(createAboutSection('Why We Use CORE and SJR', [
        createAboutList([
            {
                title: 'CORE for conferences.',
                body: 'CORE provides the conference ranking source used by the extension, so conference venues are normalized against CORE labels such as A*, A, B, and C.'
            },
            {
                title: 'SJR for journals.',
                body: 'SCImago Journal Rank data is used for journal quartiles, so journals and transactions are resolved to Q1, Q2, Q3, or Q4 when a trusted match exists.'
            },
            {
                title: 'Precision before guessing.',
                body: 'If a venue match is ambiguous or unsupported, the extension prefers to abstain and show review-needed or unranked states rather than assign a risky label.'
            }
        ])
    ]));
    content.appendChild(createAboutSection('Editorial Rules and Heuristics', [
        createAboutList([
            {
                title: 'Short papers are excluded.',
                body: 'Publications with fewer than 6 pages are treated as short papers and are not counted toward ranking. This follows the same general CSRankings-style heuristic used to avoid inflating venue quality with short-format track entries.'
            },
            {
                title: 'Workshop, demo, poster, and extended-abstract tracks are filtered.',
                body: 'The ranker uses title, venue, DBLP metadata, crossref hints, and page-count signals to identify non-main-track publications and keep them out of the ranked totals.'
            },
            {
                title: 'Conference proceedings published in journals can still map back to the conference.',
                body: 'Special venue overrides are used for cases such as proceedings-style journals so the extension can preserve conference intent when the bibliographic record is published through a journal series.'
            },
            {
                title: 'Scholar text is supporting evidence, not final authority.',
                body: 'Scholar snippets are still used to help with matching and display, but final venue decisions come from the DBLP plus CORE/SJR pipeline whenever a verified match is available.'
            }
        ])
    ]));
    content.appendChild(createAboutSection('What the Extension Optimizes For', [
        createAboutList([
            'Reduce false positives by rejecting weak or ambiguous venue matches.',
            'Reduce false negatives by canonicalizing acronyms, aliases, and proceedings variants before giving up.',
            'Show review-needed states when the data is incomplete instead of silently hiding uncertainty.'
        ])
    ]));
    body.appendChild(content);
    const actions = document.createElement('div');
    actions.className = 'gsr-search-actions gsr-dialog-actions';
    const closeAction = document.createElement('button');
    closeAction.type = 'button';
    closeAction.className = 'gsr-button gsr-button--primary';
    closeAction.textContent = 'Close';
    closeAction.addEventListener('click', () => closeDialogOverlay(overlay, panel));
    actions.appendChild(closeAction);
    body.appendChild(actions);
    // Backdrop click, the header close button, Escape, and the focus trap are
    // wired by the shared scaffold.
    gsrAboutOverlayEl = overlay;
    return overlay;
}

function openAboutOverlay() {
    const overlay = ensureAboutOverlay();
    const panel = overlay.querySelector('.gsr-about-panel');
    if (!(panel instanceof HTMLElement)) {
        return;
    }
    openDialogOverlay(overlay, panel, '.gsr-button--primary');
}
function findPublicationInfoByUrl(url) {
    const normalized = normalizeUrlForCache(url || '');
    return (currentSummaryState?.publicationRanks || []).find((info) => normalizeUrlForCache(info?.url || '') === normalized) || null;
}
function buildReportPacketMarkdown(info) {
    const payload = buildReportPayload(info);
    const lines = [
        '# GSVR Report Packet',
        '',
        `- Created At: ${payload.createdAt}`,
        `- Author: ${payload.profile.authorName || 'Unknown'}`,
        `- Scholar User ID: ${payload.profile.scholarUserId || 'N/A'}`,
        `- DBLP PID: ${payload.profile.dblpAuthorPid || 'N/A'}`,
        `- Surface: ${payload.profile.surfaceMode || 'profile'}`,
    ];
    if (payload.paper) {
        lines.push(`- Paper: ${payload.paper.title || 'Unknown'}`);
        lines.push(`- Scholar URL: ${payload.paper.scholarUrl || 'N/A'}`);
        lines.push(`- Publication Year: ${payload.paper.publicationYear || 'N/A'}`);
    }
    if (payload.decision) {
        lines.push(`- System: ${payload.decision.system}`);
        lines.push(`- Rank Outcome: ${payload.decision.rank}`);
        lines.push(`- Review Reason: ${payload.decision.reason || 'N/A'}`);
        lines.push(`- Decision Status: ${payload.decision.decisionStatus || 'N/A'}`);
        lines.push(`- Matched Venue: ${payload.decision.matchedVenue || 'N/A'}`);
        lines.push(`- Ranking Snapshot Year: ${payload.decision.sourceYear || 'N/A'}`);
        lines.push(`- Confidence: ${typeof payload.decision.confidence === 'number' ? payload.decision.confidence : 'N/A'}`);
        lines.push(`- Evidence: ${(payload.decision.decisionEvidence || []).join(', ') || 'N/A'}`);
    }
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(payload, null, 2));
    lines.push('```');
    return lines.join('\n');
}
function ensureDetailDrawer() {
    if (gsrDetailDrawerEl && document.body.contains(gsrDetailDrawerEl)) {
        return gsrDetailDrawerEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: DETAIL_DRAWER_ID,
        panelClass: 'gsr-detail-drawer',
        titleId: 'gsr-detail-drawer-title',
        titleText: 'Ranking Decision Details',
        descriptionId: 'gsr-detail-drawer-description',
        descriptionText: 'Inspect the matched venue, confidence, ambiguity candidates, and decision evidence behind this result.',
    });
    scaffold.overlay.classList.add('gsr-dialog-overlay--drawer');
    scaffold.body.classList.add('gsr-detail-drawer__body');
    gsrDetailDrawerEl = scaffold.overlay;
    return scaffold.overlay;
}
function openDetailDrawer(info) {
    const overlay = ensureDetailDrawer();
    const panel = overlay.querySelector('.gsr-detail-drawer');
    const body = panel?.querySelector('.gsr-detail-drawer__body');
    const title = panel?.querySelector('#gsr-detail-drawer-title');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    const resolvedInfo = info?.url ? (findPublicationInfoByUrl(info.url) || info) : info;
    body.innerHTML = '';
    if (title instanceof HTMLElement) {
        title.textContent = getPaperTitle(resolvedInfo) || 'Ranking Decision Details';
    }
    const headline = document.createElement('div');
    headline.className = 'gsr-detail-drawer__headline';
    const badge = createRankBadgeElement(resolvedInfo?.rank || 'N/A', resolvedInfo?.system || 'UNKNOWN', resolvedInfo?.reason || null, resolvedInfo || null);
    if (badge) {
        badge.classList.add('gsr-detail-drawer__badge');
        badge.removeAttribute('aria-describedby');
        headline.appendChild(badge);
    }
    const subtitle = document.createElement('div');
    subtitle.className = 'gsr-detail-drawer__subtitle';
    subtitle.textContent = `${resolvedInfo?.system || 'UNKNOWN'} decision · ${getReviewReason(resolvedInfo)}`;
    headline.appendChild(subtitle);
    body.appendChild(headline);
    const facts = [
        ['Publication Year', getPublicationYear(resolvedInfo) ?? 'N/A'],
        ['Author Count', resolvedInfo?.authorCount ?? 'N/A'],
        ['Authorship', formatAuthorshipSummary(resolvedInfo?.authorship)],
        ['Ranking Snapshot Year', resolvedInfo?.sourceYear ?? 'N/A'],
        ['Decision Status', resolvedInfo?.decisionStatus || 'N/A'],
        ['Matched Venue', resolvedInfo?.matchedVenue || 'N/A'],
        ['Confidence', formatConfidencePercent(resolvedInfo?.confidence ?? resolvedInfo?.venueMatchConfidence ?? resolvedInfo?.matchConfidence)],
    ];
    const factGrid = document.createElement('dl');
    factGrid.className = 'gsr-detail-drawer__facts';
    for (const [labelText, valueText] of facts) {
        const term = document.createElement('dt');
        term.textContent = labelText;
        const description = document.createElement('dd');
        description.textContent = String(valueText);
        factGrid.appendChild(term);
        factGrid.appendChild(description);
    }
    body.appendChild(factGrid);
    const evidenceItems = buildEvidenceItems(resolvedInfo);
    const evidenceSection = document.createElement('section');
    evidenceSection.className = 'gsr-detail-drawer__section';
    const evidenceTitle = document.createElement('h4');
    evidenceTitle.textContent = 'Decision Evidence';
    evidenceSection.appendChild(evidenceTitle);
    if (evidenceItems.length) {
        const list = document.createElement('ul');
        list.className = 'gsr-detail-drawer__list';
        evidenceItems.forEach((item) => {
            const entry = document.createElement('li');
            entry.textContent = `${item.label} (${item.raw})`;
            list.appendChild(entry);
        });
        evidenceSection.appendChild(list);
    }
    else {
        const empty = document.createElement('p');
        empty.className = 'gsr-detail-drawer__empty';
        empty.textContent = 'No explicit evidence tokens were recorded for this item.';
        evidenceSection.appendChild(empty);
    }
    body.appendChild(evidenceSection);
    const candidates = getTopCandidates(resolvedInfo);
    if (candidates.length) {
        const candidateSection = document.createElement('section');
        candidateSection.className = 'gsr-detail-drawer__section';
        const candidateTitle = document.createElement('h4');
        candidateTitle.textContent = 'Ambiguity Candidates';
        candidateSection.appendChild(candidateTitle);
        const candidateList = document.createElement('div');
        candidateList.className = 'gsr-detail-drawer__candidate-list';
        candidates.forEach((candidate) => {
            const item = document.createElement('div');
            item.className = 'gsr-detail-drawer__candidate';
            const label = document.createElement('strong');
            label.textContent = String(candidate.title || candidate.acronym || candidate.venue || 'Candidate');
            item.appendChild(label);
            const meta = document.createElement('span');
            meta.textContent = [candidate.acronym, candidate.rank, candidate.year].filter(Boolean).join(' · ') || 'No extra metadata';
            item.appendChild(meta);
            candidateList.appendChild(item);
        });
        candidateSection.appendChild(candidateList);
        body.appendChild(candidateSection);
    }
    const actions = document.createElement('div');
    actions.className = 'gsr-dialog-actions';
    const scholarButton = document.createElement('button');
    scholarButton.type = 'button';
    scholarButton.className = 'gsr-button gsr-button--secondary';
    scholarButton.textContent = 'Open Scholar';
    scholarButton.disabled = !resolvedInfo?.url;
    scholarButton.addEventListener('click', () => {
        if (resolvedInfo?.url) {
            window.open(resolvedInfo.url, '_blank', 'noopener,noreferrer');
        }
    });
    actions.appendChild(scholarButton);
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'gsr-button gsr-button--ghost';
    copyButton.textContent = 'Copy Evidence';
    copyButton.addEventListener('click', async () => {
        await copyTextToClipboard(JSON.stringify(buildReportPayload(resolvedInfo), null, 2));
        copyButton.textContent = 'Copied';
        window.setTimeout(() => {
            copyButton.textContent = 'Copy Evidence';
        }, 1200);
    });
    actions.appendChild(copyButton);
    const reportButton = document.createElement('button');
    reportButton.type = 'button';
    reportButton.className = 'gsr-button gsr-button--primary';
    reportButton.textContent = 'Open Report Packet';
    reportButton.addEventListener('click', () => openReportPacketOverlay(resolvedInfo));
    actions.appendChild(reportButton);
    body.appendChild(actions);
    openDialogOverlay(overlay, panel);
}
function ensureReportPacketOverlay() {
    if (gsrReportPacketOverlayEl && document.body.contains(gsrReportPacketOverlayEl)) {
        return gsrReportPacketOverlayEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: REPORT_PACKET_OVERLAY_ID,
        panelClass: 'gsr-report-packet',
        titleId: 'gsr-report-packet-title',
        titleText: 'Structured Report Packet',
        descriptionId: 'gsr-report-packet-description',
        descriptionText: 'Copy a fully structured packet with title, Scholar URL, DBLP identifiers, rank outcome, ranking snapshot year, and decision evidence.',
    });
    gsrReportPacketOverlayEl = scaffold.overlay;
    return scaffold.overlay;
}
async function openReportPacketOverlay(info = null) {
    const overlay = ensureReportPacketOverlay();
    const panel = overlay.querySelector('.gsr-report-packet');
    const body = panel?.querySelector('.gsr-dialog-panel__body');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    const payload = buildReportPayload(info);
    await saveFeatureState('reportDraft', { createdAt: payload.createdAt, payload });
    const packetMarkdown = buildReportPacketMarkdown(info);
    body.innerHTML = '';
    const summary = document.createElement('div');
    summary.className = 'gsr-report-packet__summary';
    const summaryLines = [
        ['Paper', payload.paper?.title || 'Profile-level report'],
        ['Scholar URL', payload.paper?.scholarUrl || 'N/A'],
        ['DBLP PID', payload.profile.dblpAuthorPid || 'N/A'],
        ['DBLP Key', payload.paper?.dblpKey || 'N/A'],
        ['Authorship', payload.paper ? formatAuthorshipSummary(payload.paper.authorship) : 'N/A'],
        ['Rank Outcome', payload.decision?.rank || 'N/A'],
        ['Ranking Snapshot Year', payload.decision?.sourceYear || 'N/A'],
    ];
    summaryLines.forEach(([labelText, valueText]) => {
        const line = document.createElement('div');
        line.className = 'gsr-report-packet__summary-line';
        const label = document.createElement('strong');
        label.textContent = `${labelText}: `;
        line.appendChild(label);
        line.appendChild(document.createTextNode(String(valueText)));
        summary.appendChild(line);
    });
    body.appendChild(summary);
    const textarea = document.createElement('textarea');
    textarea.className = 'gsr-report-packet__textarea';
    textarea.readOnly = true;
    textarea.value = packetMarkdown;
    body.appendChild(textarea);
    const actions = document.createElement('div');
    actions.className = 'gsr-dialog-actions';
    const copyJsonButton = document.createElement('button');
    copyJsonButton.type = 'button';
    copyJsonButton.className = 'gsr-button gsr-button--secondary';
    copyJsonButton.textContent = 'Copy JSON';
    copyJsonButton.addEventListener('click', async () => {
        await copyTextToClipboard(JSON.stringify(payload, null, 2));
        copyJsonButton.textContent = 'Copied';
        window.setTimeout(() => {
            copyJsonButton.textContent = 'Copy JSON';
        }, 1200);
    });
    actions.appendChild(copyJsonButton);
    const copyMarkdownButton = document.createElement('button');
    copyMarkdownButton.type = 'button';
    copyMarkdownButton.className = 'gsr-button gsr-button--secondary';
    copyMarkdownButton.textContent = 'Copy Packet';
    copyMarkdownButton.addEventListener('click', async () => {
        await copyTextToClipboard(packetMarkdown);
        copyMarkdownButton.textContent = 'Copied';
        window.setTimeout(() => {
            copyMarkdownButton.textContent = 'Copy Packet';
        }, 1200);
    });
    actions.appendChild(copyMarkdownButton);
    const openFormButton = document.createElement('button');
    openFormButton.type = 'button';
    openFormButton.className = 'gsr-button gsr-button--primary';
    openFormButton.textContent = 'Open Report Form';
    openFormButton.addEventListener('click', async () => {
        await copyTextToClipboard(packetMarkdown);
        window.open(REPORT_FORM_URL, '_blank', 'noopener,noreferrer');
    });
    actions.appendChild(openFormButton);
    body.appendChild(actions);
    openDialogOverlay(overlay, panel, '.gsr-report-packet__textarea');
}
function ensureExportOverlay() {
    if (gsrExportOverlayEl && document.body.contains(gsrExportOverlayEl)) {
        return gsrExportOverlayEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: EXPORT_OVERLAY_ID,
        panelClass: 'gsr-export-panel',
        titleId: 'gsr-export-title',
        titleText: 'Export report',
        descriptionId: 'gsr-export-description',
        descriptionText: 'Choose a reproducible record or a readable derived view.',
    });
    gsrExportOverlayEl = scaffold.overlay;
    return scaffold.overlay;
}
function openExportOverlay() {
    const overlay = ensureExportOverlay();
    const panel = overlay.querySelector('.gsr-export-panel');
    const body = panel?.querySelector('.gsr-dialog-panel__body');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    body.innerHTML = '';
    const countSnapshot = buildSummaryCountSnapshot(currentSummaryState);
    const totalPapers = countSnapshot.totalPapers || 0;
    const rankedCount = countSnapshot.rankedCount || 0;
    const conferenceCount = countSnapshot.conferenceCount || 0;
    const journalCount = countSnapshot.journalCount || 0;
    const hero = document.createElement('section');
    hero.className = 'gsr-export-panel__hero';
    const heroCopy = document.createElement('div');
    heroCopy.className = 'gsr-export-panel__hero-copy';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'gsr-export-panel__eyebrow';
    eyebrow.textContent = 'Ready to export';
    heroCopy.appendChild(eyebrow);
    const headline = document.createElement('h4');
    headline.className = 'gsr-export-panel__hero-title';
    headline.textContent = `${totalPapers} paper${totalPapers === 1 ? '' : 's'}`;
    heroCopy.appendChild(headline);
    const summary = document.createElement('div');
    summary.className = 'gsr-export-panel__summary';
    summary.textContent = 'Canonical JSON is the reproducibility record. PDF, HTML, Markdown, and CSV are derived views for sharing and review.';
    heroCopy.appendChild(summary);
    hero.appendChild(heroCopy);
    const statRail = document.createElement('div');
    statRail.className = 'gsr-export-panel__stat-rail gsr-export-panel__ranked-summary';
    const rankedCard = document.createElement('div');
    rankedCard.className = 'gsr-export-panel__stat gsr-export-panel__stat--ranked';
    const rankedValue = document.createElement('strong');
    rankedValue.textContent = `${rankedCount}`;
    const rankedLabel = document.createElement('span');
    rankedLabel.textContent = 'Ranked papers';
    rankedCard.appendChild(rankedValue);
    rankedCard.appendChild(rankedLabel);
    statRail.appendChild(rankedCard);
    const splitPanel = document.createElement('div');
    splitPanel.className = 'gsr-export-panel__ranked-breakdown';
    const splitTotal = Math.max(1, rankedCount, conferenceCount + journalCount);
    const bar = document.createElement('div');
    bar.className = 'gsr-export-panel__ranked-bar';
    [
        ['conference', conferenceCount],
        ['journal', journalCount],
    ].forEach(([kind, value]) => {
        const segment = document.createElement('span');
        segment.className = `gsr-export-panel__ranked-bar-segment gsr-export-panel__ranked-bar-segment--${kind}`;
        segment.style.width = `${Math.max(0, Math.min(100, (Number(value) / splitTotal) * 100))}%`;
        segment.title = `${kind === 'conference' ? 'Conference' : 'Journal'}: ${value} of ${rankedCount || splitTotal}`;
        bar.appendChild(segment);
    });
    splitPanel.appendChild(bar);
    [
        ['Conference', conferenceCount, 'conference'],
        ['Journal', journalCount, 'journal'],
    ].forEach(([labelText, value, kind]) => {
        const item = document.createElement('div');
        item.className = `gsr-export-panel__ranked-split-item gsr-export-panel__ranked-split-item--${kind}`;
        const label = document.createElement('span');
        label.textContent = labelText;
        const count = document.createElement('strong');
        count.textContent = `${value} of ${rankedCount || splitTotal}`;
        item.appendChild(label);
        item.appendChild(count);
        splitPanel.appendChild(item);
    });
    statRail.appendChild(splitPanel);
    hero.appendChild(statRail);
    body.appendChild(hero);
    const formats = [
        {
            name: 'JSON',
            badge: 'JSON',
            eyebrow: 'Canonical record',
            description: 'Schema-versioned record with model metadata, evidence, and sensitivity variants.',
            points: ['Best for reproducibility', 'Includes every scored decision'],
            actions: [
                {
                    label: 'Download JSON',
                    preparingText: 'Preparing JSON...',
                    successText: 'Downloaded',
                    download: async () => {
                        const filename = `${getCurrentReportDownloadFilenameBase()}.json`;
                        await triggerDownload(filename, 'application/json;charset=utf-8', buildJsonExport(currentSummaryState));
                    }
                }
            ]
        },
        {
            name: 'PDF',
            badge: 'PDF',
            eyebrow: 'Best for sharing',
            description: 'Shareable snapshot or full audit document.',
            points: ['Summary is compact', 'Full report includes evidence appendix'],
            actions: [
                {
                    label: 'Summary',
                    preparingText: 'Preparing Summary...',
                    successText: 'Summary Ready',
                    download: async () => {
                        const filename = `${getCurrentReportDownloadFilenameBase()}.pdf`;
                        const dataUrl = await buildPdfReportDataUrl(currentSummaryState, 'summary');
                        await triggerDataUrlDownload(filename, dataUrl);
                    }
                },
                {
                    label: 'Full Report',
                    preparingText: 'Preparing Full Report...',
                    successText: 'Full Report Ready',
                    download: async () => {
                        const filename = `${getCurrentReportDownloadFilenameBase()}.pdf`;
                        const dataUrl = await buildPdfReportDataUrl(currentSummaryState, 'full');
                        await triggerDataUrlDownload(filename, dataUrl);
                    }
                }
            ]
        },
        {
            name: 'HTML',
            badge: 'HTML',
            eyebrow: 'Best for browser review',
            description: 'Standalone browser-readable report.',
            points: ['Keeps the formatted layout', 'Easy to inspect locally'],
            actions: [
                {
                    label: 'Download HTML',
                    preparingText: 'Preparing HTML...',
                    successText: 'Downloaded',
                    download: async () => {
                        const filename = `${getCurrentReportDownloadFilenameBase()}.html`;
                        await triggerDownload(filename, 'text/html;charset=utf-8', await buildHtmlReport(currentSummaryState));
                    }
                }
            ]
        },
        {
            name: 'Markdown',
            badge: 'MD',
            eyebrow: 'Notes',
            description: 'Portable text report for review notes and issue threads.',
            points: ['Plain text', 'Includes model metadata'],
            actions: [
                {
                    label: 'Download Markdown',
                    preparingText: 'Preparing Markdown...',
                    successText: 'Downloaded',
                    download: async () => {
                        const filename = `${getCurrentReportDownloadFilenameBase()}.md`;
                        await triggerDownload(filename, 'text/markdown;charset=utf-8', buildMarkdownExport(currentSummaryState));
                    }
                }
            ]
        },
        {
            name: 'CSV',
            badge: 'CSV',
            eyebrow: 'Best for analysis',
            description: 'Flat audit rows for spreadsheets and statistical checks.',
            points: ['One row per paper', 'Includes factors and reason codes'],
            actions: [
                {
                    label: 'Download CSV',
                    preparingText: 'Preparing CSV...',
                    successText: 'Downloaded',
                    download: async () => {
                        const filename = `${getCurrentReportDownloadFilenameBase()}.csv`;
                        await triggerDownload(filename, 'text/csv;charset=utf-8', buildCsvExport(currentSummaryState));
                    }
                }
            ]
        },
    ];
    const actionGrid = document.createElement('div');
    actionGrid.className = 'gsr-export-panel__grid';
    formats.forEach((format) => {
        const card = document.createElement('article');
        card.className = 'gsr-export-panel__card';
        card.setAttribute('data-gsr-format', format.name.toLowerCase());
        const cardHead = document.createElement('div');
        cardHead.className = 'gsr-export-panel__card-head';
        const titleBlock = document.createElement('div');
        titleBlock.className = 'gsr-export-panel__card-title-block';
        const meta = document.createElement('span');
        meta.className = 'gsr-export-panel__meta';
        meta.textContent = format.eyebrow;
        titleBlock.appendChild(meta);
        const title = document.createElement('h4');
        title.className = 'gsr-export-panel__format';
        title.textContent = format.name;
        titleBlock.appendChild(title);
        cardHead.appendChild(titleBlock);
        const badge = document.createElement('span');
        badge.className = 'gsr-export-panel__badge';
        badge.textContent = format.badge || format.name;
        cardHead.appendChild(badge);
        card.appendChild(cardHead);
        const description = document.createElement('p');
        description.className = 'gsr-export-panel__card-copy';
        description.textContent = format.description;
        card.appendChild(description);
        const points = document.createElement('ul');
        points.className = 'gsr-export-panel__points';
        format.points.forEach((text) => {
            const item = document.createElement('li');
            item.textContent = text;
            points.appendChild(item);
        });
        card.appendChild(points);
        const actionRow = document.createElement('div');
        actionRow.className = `gsr-export-panel__actions${Array.isArray(format.actions) && format.actions.length > 1 ? ' gsr-export-panel__actions--split' : ''}`;
        (Array.isArray(format.actions) ? format.actions : []).forEach((action) => {
            const downloadButton = document.createElement('button');
            downloadButton.type = 'button';
            downloadButton.className = 'gsr-button gsr-button--primary gsr-export-panel__action-button';
            downloadButton.setAttribute('data-gsr-export-action', sanitizeFilenamePart(action.label));
            downloadButton.setAttribute('data-gsr-export-format', format.name.toLowerCase());
            downloadButton.textContent = action.label;
            downloadButton.addEventListener('click', async () => {
                const originalText = downloadButton.textContent;
                downloadButton.disabled = true;
                downloadButton.textContent = action.preparingText || 'Preparing...';
                try {
                    await action.download();
                    downloadButton.textContent = action.successText || 'Downloaded';
                    window.setTimeout(() => {
                        downloadButton.textContent = originalText;
                        downloadButton.disabled = false;
                    }, 1200);
                }
                catch (error) {
                    console.error(`GSR: Failed to download ${format.name} report.`, error);
                    downloadButton.textContent = 'Try Again';
                    downloadButton.disabled = false;
                }
            });
            actionRow.appendChild(downloadButton);
        });
        card.appendChild(actionRow);
        actionGrid.appendChild(card);
    });
    body.appendChild(actionGrid);
    openDialogOverlay(overlay, panel);
}
function ensureCompareOverlay() {
    if (gsrCompareOverlayEl && document.body.contains(gsrCompareOverlayEl)) {
        return gsrCompareOverlayEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: COMPARE_OVERLAY_ID,
        panelClass: 'gsr-compare-panel',
        titleId: 'gsr-compare-title',
        titleText: 'Profile Snapshot Compare',
        descriptionId: 'gsr-compare-description',
        descriptionText: 'Compare the current profile or saved snapshots on ranked share, A*/A mix, Q1 mix, review backlog, and venue drift.',
    });
    gsrCompareOverlayEl = scaffold.overlay;
    return scaffold.overlay;
}
async function openCompareOverlay() {
    const overlay = ensureCompareOverlay();
    const panel = overlay.querySelector('.gsr-compare-panel');
    const body = panel?.querySelector('.gsr-dialog-panel__body');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    const snapshots = await loadFeatureState('profileSnapshots');
    const compareState = await loadFeatureState('savedCompareSet');
    body.innerHTML = '';
    const controls = document.createElement('div');
    controls.className = 'gsr-compare-panel__controls';
    const buildOptions = () => {
        const list = [{ id: '__current__', label: 'Current profile' }];
        for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
            list.push({ id: snapshot.id, label: buildSnapshotOptionLabel(snapshot) });
        }
        return list;
    };
    const options = buildOptions();
    const createSelect = (labelText, value) => {
        const wrap = document.createElement('label');
        wrap.className = 'gsr-compare-panel__field';
        const label = document.createElement('span');
        label.textContent = labelText;
        const select = document.createElement('select');
        options.forEach((optionValue) => {
            const option = document.createElement('option');
            option.value = optionValue.id;
            option.textContent = optionValue.label;
            option.selected = optionValue.id === value;
            select.appendChild(option);
        });
        wrap.appendChild(label);
        wrap.appendChild(select);
        controls.appendChild(wrap);
        return select;
    };
    const leftValue = compareState?.leftSnapshotId || '__current__';
    const rightDefault = compareState?.rightSnapshotId || (Array.isArray(snapshots) && snapshots[0] ? snapshots[0].id : '__current__');
    const leftSelect = createSelect('Left Side', leftValue);
    const rightSelect = createSelect('Right Side', rightDefault);
    body.appendChild(controls);
    const actionRow = document.createElement('div');
    actionRow.className = 'gsr-dialog-actions';
    const saveSnapshotButton = document.createElement('button');
    saveSnapshotButton.type = 'button';
    saveSnapshotButton.className = 'gsr-button gsr-button--secondary';
    saveSnapshotButton.textContent = 'Save Current Snapshot';
    saveSnapshotButton.addEventListener('click', async () => {
        const snapshot = await saveCurrentProfileSnapshot();
        if (snapshot) {
            await saveFeatureState('savedCompareSet', {
                ...compareState,
                rightSnapshotId: snapshot.id,
            });
            openCompareOverlay();
        }
    });
    actionRow.appendChild(saveSnapshotButton);
    body.appendChild(actionRow);
    const compareHost = document.createElement('div');
    compareHost.className = 'gsr-compare-panel__results';
    body.appendChild(compareHost);
    const getSummaryForValue = (value) => {
        if (value === '__current__') {
            return currentSummaryState;
        }
        return (Array.isArray(snapshots) ? snapshots : []).find((snapshot) => snapshot.id === value) || null;
    };
    const renderComparison = async () => {
        const nextState = {
            ...(compareState || {}),
            leftSnapshotId: leftSelect.value,
            rightSnapshotId: rightSelect.value,
        };
        await saveFeatureState('savedCompareSet', nextState);
        const leftSummary = getSummaryForValue(leftSelect.value);
        const rightSummary = getSummaryForValue(rightSelect.value);
        compareHost.innerHTML = '';
        if (!leftSummary || !rightSummary) {
            const empty = document.createElement('p');
            empty.className = 'gsr-detail-drawer__empty';
            empty.textContent = 'Save at least one snapshot to compare it against the current profile.';
            compareHost.appendChild(empty);
            return;
        }
        const comparison = buildComparisonSummary(leftSummary, rightSummary);
        const metricGrid = document.createElement('div');
        metricGrid.className = 'gsr-compare-panel__metric-grid';
        comparison.metrics.forEach((metric) => {
            const card = document.createElement('div');
            card.className = 'gsr-compare-panel__metric';
            const label = document.createElement('strong');
            label.textContent = metric.label;
            card.appendChild(label);
            const values = document.createElement('span');
            const leftValue = metric.key === 'rankedShare' ? formatConfidencePercent(metric.leftValue) : String(metric.leftValue);
            const rightValue = metric.key === 'rankedShare' ? formatConfidencePercent(metric.rightValue) : String(metric.rightValue);
            const deltaValue = metric.key === 'rankedShare'
                ? `${metric.delta > 0 ? '+' : (metric.delta < 0 ? '-' : '')}${formatConfidencePercent(Math.abs(metric.delta))}`
                : `${metric.delta > 0 ? '+' : ''}${metric.delta}`;
            values.textContent = `${leftValue} → ${rightValue} (${deltaValue})`;
            card.appendChild(values);
            metricGrid.appendChild(card);
        });
        compareHost.appendChild(metricGrid);
        const venueSection = document.createElement('section');
        venueSection.className = 'gsr-detail-drawer__section';
        const venueTitle = document.createElement('h4');
        venueTitle.textContent = 'Venue Drift';
        venueSection.appendChild(venueTitle);
        if (comparison.venueDelta.length) {
            const list = document.createElement('ul');
            list.className = 'gsr-detail-drawer__list';
            comparison.venueDelta.forEach((entry) => {
                const item = document.createElement('li');
                item.textContent = `${entry.venue}: ${entry.leftCount} → ${entry.rightCount} (${entry.delta > 0 ? '+' : ''}${entry.delta})`;
                list.appendChild(item);
            });
            venueSection.appendChild(list);
        }
        else {
            const none = document.createElement('p');
            none.className = 'gsr-detail-drawer__empty';
            none.textContent = 'No venue drift was detected between these two snapshots.';
            venueSection.appendChild(none);
        }
        compareHost.appendChild(venueSection);
    };
    leftSelect.addEventListener('change', renderComparison);
    rightSelect.addEventListener('change', renderComparison);
    await renderComparison();
    openDialogOverlay(overlay, panel);
}
function ensureReviewInboxOverlay() {
    if (gsrReviewInboxOverlayEl && document.body.contains(gsrReviewInboxOverlayEl)) {
        return gsrReviewInboxOverlayEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: REVIEW_INBOX_OVERLAY_ID,
        panelClass: 'gsr-review-inbox',
        titleId: 'gsr-review-inbox-title',
        titleText: 'Review Inbox',
        descriptionId: 'gsr-review-inbox-description',
        descriptionText: 'Inspect every DBLP-missing, ambiguous, short-paper, workshop, demo/poster, or unranked item from this profile.',
    });
    gsrReviewInboxOverlayEl = scaffold.overlay;
    return scaffold.overlay;
}
async function openReviewInboxOverlay() {
    const overlay = ensureReviewInboxOverlay();
    const panel = overlay.querySelector('.gsr-review-inbox');
    const body = panel?.querySelector('.gsr-dialog-panel__body');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    const state = await loadFeatureState('reviewQueueState');
    const items = Array.isArray(currentSummaryState?.reviewItems) ? currentSummaryState.reviewItems.slice() : [];
    const sortedItems = sortReviewItems(items, state?.sortBy || 'needs-review-first');
    const groups = groupReviewItems(sortedItems, state?.groupBy || 'reason');
    body.innerHTML = '';
    const controls = document.createElement('div');
    controls.className = 'gsr-review-inbox__controls';
    const buildSelect = (labelText, values, selectedValue, onChange) => {
        const label = document.createElement('label');
        label.className = 'gsr-review-inbox__field';
        const span = document.createElement('span');
        span.textContent = labelText;
        const select = document.createElement('select');
        values.forEach((value) => {
            const option = document.createElement('option');
            option.value = value.value;
            option.textContent = value.label;
            option.selected = value.value === selectedValue;
            select.appendChild(option);
        });
        select.addEventListener('change', () => onChange(select.value));
        label.appendChild(span);
        label.appendChild(select);
        controls.appendChild(label);
    };
    buildSelect('Sort', [
        { value: 'needs-review-first', label: 'Reason' },
        { value: 'year-desc', label: 'Year' },
        { value: 'title', label: 'Title' },
        { value: 'confidence', label: 'Confidence' },
    ], state?.sortBy || 'needs-review-first', async (value) => {
        await saveFeatureState('reviewQueueState', { ...(state || {}), sortBy: value });
        openReviewInboxOverlay();
    });
    buildSelect('Group', [
        { value: 'reason', label: 'Reason' },
        { value: 'none', label: 'None' },
    ], state?.groupBy || 'reason', async (value) => {
        await saveFeatureState('reviewQueueState', { ...(state || {}), groupBy: value });
        openReviewInboxOverlay();
    });
    body.appendChild(controls);
    const summary = document.createElement('div');
    summary.className = 'gsr-review-inbox__summary';
    summary.textContent = `${items.length} review item${items.length === 1 ? '' : 's'} in the current queue.`;
    body.appendChild(summary);
    if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'gsr-detail-drawer__empty';
        empty.textContent = 'No review items are waiting right now.';
        body.appendChild(empty);
        openDialogOverlay(overlay, panel);
        return;
    }
    groups.forEach((group) => {
        const section = document.createElement('section');
        section.className = 'gsr-review-inbox__group';
        const title = document.createElement('h4');
        title.textContent = `${group.label} (${group.items.length})`;
        section.appendChild(title);
        const list = document.createElement('div');
        list.className = 'gsr-review-inbox__list';
        group.items.forEach((item) => {
            const card = document.createElement('article');
            card.className = 'gsr-review-inbox__item';
            const heading = document.createElement('div');
            heading.className = 'gsr-review-inbox__item-head';
            const titleButton = document.createElement('button');
            titleButton.type = 'button';
            titleButton.className = 'gsr-review-inbox__title';
            titleButton.textContent = getPaperTitle(item) || 'Untitled paper';
            titleButton.addEventListener('click', () => openDetailDrawer(item));
            heading.appendChild(titleButton);
            const meta = document.createElement('span');
            meta.className = 'gsr-review-inbox__meta';
            meta.textContent = [getPublicationYear(item), item.system, getReviewReason(item)].filter(Boolean).join(' · ');
            heading.appendChild(meta);
            card.appendChild(heading);
            const actionRow = document.createElement('div');
            actionRow.className = 'gsr-review-inbox__actions';
            const actions = [
                ['Explain', () => openDetailDrawer(item)],
                ['Scholar', () => item.url && window.open(item.url, '_blank', 'noopener,noreferrer')],
                ['Copy Evidence', async () => copyTextToClipboard(JSON.stringify(buildReportPayload(item), null, 2))],
                ['Report', () => openReportPacketOverlay(item)],
            ];
            actions.forEach(([labelText, handler]) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'gsr-button gsr-button--ghost';
                button.textContent = labelText;
                if (labelText === 'Scholar' && !item.url) {
                    button.disabled = true;
                }
                button.addEventListener('click', handler);
                actionRow.appendChild(button);
            });
            card.appendChild(actionRow);
            list.appendChild(card);
        });
        section.appendChild(list);
        body.appendChild(section);
    });
    openDialogOverlay(overlay, panel);
}
function getScholarSurfaceMode() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view_op') === 'view_citation') {
        return 'citation-detail';
    }
    if (params.has('q') && !params.has('user')) {
        return 'search-results';
    }
    return 'profile';
}
function teardownOffProfileSurfaceUi() {
    if (activeScanSessionId !== 0 && (isMainProcessing || activeForegroundScanSessionId !== 0 || currentSummaryState || activeCachedPublicationRanks)) {
        nextScanSessionId();
    }
    activeForegroundScanSessionId = 0;
    isMainProcessing = false;
    activeCachedPublicationRanks = null;
    rankMapForObserver = null;
    currentSummaryState = null;
    activeSummaryFilter = null;
    previewSummaryFilter = null;
    disconnectPublicationTableObserver();
    hideBadgePopover(true);
    document.getElementById(FACULTY_SCORE_PANEL_ID)?.remove();
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    document.getElementById(SCORE_DETAILS_OVERLAY_ID)?.remove();
    document.getElementById(COMPLETENESS_OVERLAY_ID)?.remove();
    document.getElementById(DETAIL_DRAWER_ID)?.remove();
    document.getElementById(REVIEW_INBOX_OVERLAY_ID)?.remove();
    document.getElementById(REPORT_PACKET_OVERLAY_ID)?.remove();
    document.getElementById(EXPORT_OVERLAY_ID)?.remove();
    document.getElementById(COMPARE_OVERLAY_ID)?.remove();
    document.getElementById(MANUAL_DBLP_OVERLAY_ID)?.remove();
    document.getElementById('gsr-search-utility-overlay')?.remove();
    document.getElementById('gsr-about-overlay')?.remove();
    removeCitationGraphRankChips();
    document.querySelectorAll('.gsr-citation-detail-badge').forEach((el) => el.remove());
    gsrSearchOverlayEl = null;
    gsrAboutOverlayEl = null;
    gsrScoreDetailsOverlayEl = null;
    gsrCompletenessOverlayEl = null;
    gsrDetailDrawerEl = null;
    gsrReviewInboxOverlayEl = null;
    gsrReportPacketOverlayEl = null;
    gsrExportOverlayEl = null;
    gsrCompareOverlayEl = null;
    gsrManualDblpOverlayEl = null;
}
function buildReviewReasonCounts(publicationRanks) {
    const counts = {};
    for (const info of publicationRanks || []) {
        if (isRankedResultInfo(info)) {
            continue;
        }
        const reason = getReviewReason(info);
        counts[reason] = (counts[reason] || 0) + 1;
    }
    return counts;
}
function renderSummaryInsightsContent(container, summaryState) {
    container.innerHTML = '';
    const insights = summaryState?.insights;
    if (!insights) {
        const empty = document.createElement('p');
        empty.className = 'gsr-detail-drawer__empty';
        empty.textContent = 'Insights will appear after ranked results are available.';
        container.appendChild(empty);
        return;
    }
    const metricGrid = document.createElement('div');
    metricGrid.className = 'gsr-summary-insights__metrics';
    [
        ['Ranked Share', formatConfidencePercent(insights.rankedShare || 0)],
        ['Conference Mix', `${insights.conferenceCount || 0}`],
        ['Journal Mix', `${insights.journalCount || 0}`],
        ['Review Queue', `${insights.reviewCount || 0}`],
        ['A*/A', `${(Number(summaryState?.coreRankCounts?.['A*']) || 0) + (Number(summaryState?.coreRankCounts?.A) || 0)}`],
        ['Q1', `${Number(summaryState?.sjrRankCounts?.Q1) || 0}`],
    ].forEach(([labelText, valueText]) => {
        const card = document.createElement('div');
        card.className = 'gsr-summary-insights__metric';
        const label = document.createElement('strong');
        label.textContent = labelText;
        const value = document.createElement('span');
        value.textContent = valueText;
        card.appendChild(label);
        card.appendChild(value);
        metricGrid.appendChild(card);
    });
    container.appendChild(metricGrid);
    const sections = [
        {
            title: 'Top Venues',
            empty: 'No ranked venues yet.',
            entries: (insights.topRankedVenues || []).map((entry) => `${entry.venue} (${entry.count})`),
        },
        {
            title: 'Review Trend',
            empty: 'No review queue right now.',
            entries: (insights.reviewReasons || []).map((entry) => `${entry.reason} (${entry.count})`),
        },
        {
            title: 'Yearly Trend',
            empty: 'No yearly trend yet.',
            entries: (insights.yearlyTrend || []).slice(-6).map((entry) => `${entry.year}: ranked ${entry.ranked}, review ${entry.review}`),
        },
    ];
    sections.forEach((sectionInfo) => {
        const section = document.createElement('section');
        section.className = 'gsr-detail-drawer__section';
        const title = document.createElement('h4');
        title.textContent = sectionInfo.title;
        section.appendChild(title);
        if (sectionInfo.entries.length) {
            const list = document.createElement('ul');
            list.className = 'gsr-detail-drawer__list';
            sectionInfo.entries.forEach((text) => {
                const item = document.createElement('li');
                item.textContent = text;
                list.appendChild(item);
            });
            section.appendChild(list);
        }
        else {
            const empty = document.createElement('p');
            empty.className = 'gsr-detail-drawer__empty';
            empty.textContent = sectionInfo.empty;
            section.appendChild(empty);
        }
        container.appendChild(section);
    });
}
function renderSummaryFreshnessContent(container, freshnessState) {
    container.innerHTML = '';
    if (!freshnessState) {
        const loading = document.createElement('p');
        loading.className = 'gsr-detail-drawer__empty';
        loading.textContent = 'Loading freshness metadata...';
        container.appendChild(loading);
        return;
    }
    const facts = document.createElement('dl');
    facts.className = 'gsr-detail-drawer__facts';
    [
        ['Extension Version', freshnessState.extensionVersion || 'unknown'],
        ['CORE Coverage', freshnessState.coreCoverageStart && freshnessState.coreCoverageEnd
                ? `${freshnessState.coreCoverageStart}-${freshnessState.coreCoverageEnd}`
                : 'Unknown'],
        ['SJR Coverage', freshnessState.sjrCoverageStart && freshnessState.sjrCoverageEnd
                ? `${freshnessState.sjrCoverageStart}-${freshnessState.sjrCoverageEnd}`
                : 'Unknown'],
        ['Last Profile Run', formatTimestamp(freshnessState.lastProfileRunAt || freshnessState.generatedAt)],
        ['Cache Updated', formatTimestamp(freshnessState.cacheTimestamp)],
        ['Active Ranking Packs', (freshnessState.activePacks || []).map((value) => value.toUpperCase()).join(', ') || 'CORE, SJR'],
    ].forEach(([labelText, valueText]) => {
        const term = document.createElement('dt');
        term.textContent = labelText;
        const description = document.createElement('dd');
        description.textContent = String(valueText);
        facts.appendChild(term);
        facts.appendChild(description);
    });
    container.appendChild(facts);
    const explainer = document.createElement('section');
    explainer.className = 'gsr-detail-drawer__section';
    const title = document.createElement('h4');
    title.textContent = 'How to Read Missing Ranks';
    explainer.appendChild(title);
    const list = document.createElement('ul');
    list.className = 'gsr-detail-drawer__list';
    [
        'A missing rank can mean the venue is absent from the bundled dataset.',
        'It can also mean the venue exists but the extension abstained because the evidence was ambiguous or filtered.',
        'Cached results can lag behind a newly updated extension until the profile is rescanned.',
    ].forEach((text) => {
        const item = document.createElement('li');
        item.textContent = text;
        list.appendChild(item);
    });
    explainer.appendChild(list);
    container.appendChild(explainer);
    const changelog = document.createElement('section');
    changelog.className = 'gsr-detail-drawer__section';
    const changelogTitle = document.createElement('h4');
    changelogTitle.textContent = 'What Changed';
    changelog.appendChild(changelogTitle);
    const changelogList = document.createElement('ul');
    changelogList.className = 'gsr-detail-drawer__list';
    (freshnessState.changelogNotes || CHANGELOG_NOTES).forEach((note) => {
        const item = document.createElement('li');
        item.textContent = note;
        changelogList.appendChild(item);
    });
    changelog.appendChild(changelogList);
    container.appendChild(changelog);
}
function ensureScoreDetailsOverlay() {
    if (gsrScoreDetailsOverlayEl && document.body.contains(gsrScoreDetailsOverlayEl)) {
        return gsrScoreDetailsOverlayEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: SCORE_DETAILS_OVERLAY_ID,
        panelClass: 'gsr-score-details-panel',
        titleId: 'gsr-score-details-title',
        titleText: 'Fractional Venue Score Model',
        descriptionId: 'gsr-score-details-description',
        descriptionText: 'Formula, venue values, eligibility rules, and publication-level evidence.'
    });
    gsrScoreDetailsOverlayEl = scaffold.overlay;
    return scaffold.overlay;
}
function openScoreDetailsOverlay() {
    const overlay = ensureScoreDetailsOverlay();
    const panel = overlay.querySelector('.gsr-score-details-panel');
    const body = panel?.querySelector('.gsr-dialog-panel__body');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    const facultyScore = currentSummaryState?.venueProfileIndex || currentSummaryState?.facultyScore || buildFacultyScoreState(currentSummaryState?.publicationRanks || []);
    const conferenceCredit = Number(facultyScore.coreContribution || 0);
    const journalCredit = Number(facultyScore.sjrContribution || 0);
    const diagnostics = facultyScore.diagnostics || facultyScore.coverage || {};
    const activeScoreConfig = DEFAULT_SCORE_CONFIG || {};
    const formatModelNumber = (value, digits = 3) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
            return '0';
        }
        return numeric.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
    };
    const formatNullableFactor = (value) => {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? formatModelNumber(numeric, 3) : 'N/A';
    };
    const getScaleValue = (source, rank) => {
        const values = activeScoreConfig.venueValues || {};
        return Number(values?.[source]?.[rank] ?? VENUE_PROFILE_INDEX_WEIGHTS[rank] ?? 0);
    };
    const createMetricCard = (labelText, valueText, extraClass = '') => {
        const card = document.createElement('div');
        card.className = `gsr-score-details__metric${extraClass ? ` ${extraClass}` : ''}`;
        const label = document.createElement('span');
        label.className = 'gsr-score-details__metric-label';
        label.textContent = labelText;
        const value = document.createElement('strong');
        value.className = 'gsr-score-details__metric-value';
        value.textContent = valueText;
        card.appendChild(label);
        card.appendChild(value);
        return card;
    };
    const createStaticRankBadge = (rank, system) => {
        const badge = createRankBadgeElement(rank, system, null, null);
        if (badge) {
            badge.removeAttribute('tabindex');
            badge.removeAttribute('aria-describedby');
            badge.removeAttribute('title');
            badge.classList.add('gsr-score-details__weight-badge');
            return badge;
        }
        const fallback = document.createElement('span');
        fallback.className = 'gsr-rank-badge gsr-rank-badge--ranked gsr-rank-badge--neutral gsr-score-details__weight-badge';
        fallback.textContent = rank;
        return fallback;
    };
    const appendMathSymbol = (parent, text, className = '') => {
        const element = document.createElement('span');
        element.className = className;
        element.textContent = text;
        parent.appendChild(element);
        return element;
    };
    body.innerHTML = '';
    const hero = document.createElement('section');
    hero.className = 'gsr-score-details__hero';
    const heroPrimary = document.createElement('div');
    heroPrimary.className = 'gsr-score-details__hero-primary';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'gsr-score-details__eyebrow';
    eyebrow.textContent = 'Current GSVR Score';
    heroPrimary.appendChild(eyebrow);
    const scoreValue = document.createElement('div');
    scoreValue.className = 'gsr-score-details__hero-score';
    scoreValue.textContent = Number(facultyScore.gsvrScore || 0).toFixed(4);
    heroPrimary.appendChild(scoreValue);
    const heroNote = document.createElement('p');
    heroNote.className = 'gsr-score-details__hero-note';
    heroNote.textContent = 'Fractional venue-ranked contribution from eligible ranked publications.';
    heroPrimary.appendChild(heroNote);
    hero.appendChild(heroPrimary);
    const heroStats = document.createElement('div');
    heroStats.className = 'gsr-score-details__hero-stats';
    heroStats.appendChild(createMetricCard('Eligible Ranked Publications', String(facultyScore.eligibleRankedPublications || 0), 'gsr-score-details__metric--compact'));
    heroStats.appendChild(createMetricCard('Fractional Publication Weight', Number(facultyScore.fractionalPublicationWeight || 0).toFixed(4), 'gsr-score-details__metric--compact'));
    heroStats.appendChild(createMetricCard('CORE Contribution', conferenceCredit.toFixed(4), 'gsr-score-details__metric--compact'));
    heroStats.appendChild(createMetricCard('SJR Contribution', journalCredit.toFixed(4), 'gsr-score-details__metric--compact'));
    hero.appendChild(heroStats);
    body.appendChild(hero);
    const methodSection = document.createElement('section');
    methodSection.className = 'gsr-score-details__section';
    const methodHead = document.createElement('div');
    methodHead.className = 'gsr-score-details__section-head';
    const methodTitle = document.createElement('h4');
    methodTitle.textContent = 'Score Model';
    methodHead.appendChild(methodTitle);
    const methodSubtitle = document.createElement('p');
    methodSubtitle.className = 'gsr-score-details__section-subtitle';
    methodSubtitle.textContent = 'Raw fractional venue score over eligible ranked publications.';
    methodHead.appendChild(methodSubtitle);
    methodSection.appendChild(methodHead);
    const formulaBoard = document.createElement('div');
    formulaBoard.className = 'gsr-score-details__formula-board';
    const equationPanel = document.createElement('div');
    equationPanel.className = 'gsr-score-details__math-panel';
    const equationLabel = document.createElement('span');
    equationLabel.className = 'gsr-score-details__equation-label';
    equationLabel.textContent = 'Primary score formula';
    equationPanel.appendChild(equationLabel);
    const equationFlow = document.createElement('div');
    equationFlow.className = 'gsr-score-details__math';
    equationFlow.setAttribute('aria-label', 'GSVR equals the sum over eligible publications of venue value divided by author count.');
    appendMathSymbol(equationFlow, 'GSVR', 'gsr-score-details__math-name');
    appendMathSymbol(equationFlow, '=', 'gsr-score-details__math-op');
    const summation = document.createElement('span');
    summation.className = 'gsr-score-details__math-sum';
    const sigma = document.createElement('span');
    sigma.className = 'gsr-score-details__math-sigma';
    sigma.textContent = '\u03A3';
    const subscript = document.createElement('sub');
    subscript.textContent = 'i \u2208 E';
    summation.appendChild(sigma);
    summation.appendChild(subscript);
    equationFlow.appendChild(summation);
    const fraction = document.createElement('span');
    fraction.className = 'gsr-score-details__math-fraction';
    const numerator = document.createElement('span');
    numerator.className = 'gsr-score-details__math-numerator';
    numerator.appendChild(document.createTextNode('v'));
    const numeratorSub = document.createElement('sub');
    numeratorSub.textContent = 'i';
    numerator.appendChild(numeratorSub);
    const denominator = document.createElement('span');
    denominator.className = 'gsr-score-details__math-denominator';
    denominator.appendChild(document.createTextNode('a'));
    const denominatorSub = document.createElement('sub');
    denominatorSub.textContent = 'i';
    denominator.appendChild(denominatorSub);
    fraction.appendChild(numerator);
    fraction.appendChild(denominator);
    equationFlow.appendChild(fraction);
    equationPanel.appendChild(equationFlow);
    const equationCaption = document.createElement('p');
    equationCaption.className = 'gsr-score-details__math-caption';
    equationCaption.textContent = 'Each paper contributes its CORE/SJR venue value divided by the DBLP author count. The score is raw and unbounded.';
    equationPanel.appendChild(equationCaption);
    formulaBoard.appendChild(equationPanel);
    const modelNotes = document.createElement('div');
    modelNotes.className = 'gsr-score-details__model-notes';
    [
        ['Eligibility set E', 'Full publication type, ranked by CORE/SJR, and valid author count.'],
        ['Paper contribution', 'venueValue / authorCount. No match-confidence, temporal, coverage, or reliability multipliers are applied.'],
    ].forEach(([labelText, valueText]) => {
        const item = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = labelText;
        const text = document.createElement('p');
        text.textContent = valueText;
        item.appendChild(label);
        item.appendChild(text);
        modelNotes.appendChild(item);
    });
    formulaBoard.appendChild(modelNotes);
    methodSection.appendChild(formulaBoard);
    const methodGrid = document.createElement('div');
    methodGrid.className = 'gsr-score-details__factor-grid';
    [
        ['V_i', 'Venue value', 'CORE and SJR use separate rank-value scales.'],
        ['a_i', 'DBLP author count', 'Fractional credit is 1 divided by the number of authors on the DBLP record.'],
        ['E', 'Eligibility', 'Only eligible ranked full papers with valid author counts are scored.'],
        ['S_i', 'Contribution', 'Each scored publication contributes venueValue / authorCount.'],
    ].forEach(([symbolText, labelText, valueText]) => {
        const item = document.createElement('div');
        item.className = 'gsr-score-details__factor-card';
        const symbol = document.createElement('span');
        symbol.className = 'gsr-score-details__factor-symbol';
        symbol.textContent = symbolText;
        const copy = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = labelText;
        const text = document.createElement('p');
        text.textContent = valueText;
        copy.appendChild(label);
        copy.appendChild(text);
        item.appendChild(symbol);
        item.appendChild(copy);
        methodGrid.appendChild(item);
    });
    methodSection.appendChild(methodGrid);
    body.appendChild(methodSection);
    const weightSection = document.createElement('section');
    weightSection.className = 'gsr-score-details__section';
    const weightHead = document.createElement('div');
    weightHead.className = 'gsr-score-details__section-head';
    const weightTitle = document.createElement('h4');
    weightTitle.textContent = 'Venue Values';
    weightHead.appendChild(weightTitle);
    const weightSubtitle = document.createElement('p');
    weightSubtitle.className = 'gsr-score-details__section-subtitle';
    weightSubtitle.textContent = 'Default values used by the raw fractional venue score.';
    weightHead.appendChild(weightSubtitle);
    weightSection.appendChild(weightHead);
    const weightRows = document.createElement('div');
    weightRows.className = 'gsr-score-details__weight-rows';
    [
        [
            ['A*', 'CORE'],
            ['A', 'CORE'],
            ['B', 'CORE'],
            ['C', 'CORE'],
        ],
        [
            ['Q1', 'SJR'],
            ['Q2', 'SJR'],
            ['Q3', 'SJR'],
            ['Q4', 'SJR'],
        ],
    ].forEach((rowItems) => {
        const weightGrid = document.createElement('div');
        weightGrid.className = 'gsr-score-details__weight-grid';
        rowItems.forEach(([rank, system]) => {
            const scaleValue = getScaleValue(system, rank);
            const card = document.createElement('div');
            card.className = 'gsr-score-details__weight-card';
            card.appendChild(createStaticRankBadge(rank, system));
            const value = document.createElement('strong');
            value.className = 'gsr-score-details__weight-value';
            value.textContent = formatModelNumber(scaleValue, 3);
            const note = document.createElement('span');
            note.className = 'gsr-score-details__weight-note';
            note.textContent = system;
            card.appendChild(value);
            card.appendChild(note);
            weightGrid.appendChild(card);
        });
        weightRows.appendChild(weightGrid);
    });
    weightSection.appendChild(weightRows);
    body.appendChild(weightSection);
    const breakdownSection = document.createElement('section');
    breakdownSection.className = 'gsr-score-details__section';
    const breakdownHead = document.createElement('div');
    breakdownHead.className = 'gsr-score-details__section-head';
    const breakdownTitle = document.createElement('h4');
    breakdownTitle.textContent = 'Contribution Breakdown';
    breakdownHead.appendChild(breakdownTitle);
    const breakdownSubtitle = document.createElement('p');
    breakdownSubtitle.className = 'gsr-score-details__section-subtitle';
    breakdownSubtitle.textContent = 'Where the current score is coming from.';
    breakdownHead.appendChild(breakdownSubtitle);
    breakdownSection.appendChild(breakdownHead);
    const breakdownGrid = document.createElement('div');
    breakdownGrid.className = 'gsr-score-details__metric-grid';
    [
        ['GSVR Score', Number(facultyScore.gsvrScore || 0).toFixed(4), 'gsr-score-details__metric--primary'],
        ['Eligible Ranked Publications', String(facultyScore.eligibleRankedPublications || 0), ''],
        ['Fractional Publication Weight', Number(facultyScore.fractionalPublicationWeight || 0).toFixed(4), ''],
        ['Average Venue Value', Number(facultyScore.averageVenueValue || 0).toFixed(4), ''],
        ['CORE Contribution', conferenceCredit.toFixed(4), ''],
        ['SJR Contribution', journalCredit.toFixed(4), ''],
        ['Excluded Short Papers', String(diagnostics.excludedShortPapers || 0), ''],
        ['Excluded Workshops', String(diagnostics.excludedWorkshops || 0), ''],
        ['Excluded Demos/Posters', String(diagnostics.excludedDemosPosters || 0), ''],
        ['Excluded Extended Abstracts', String(diagnostics.excludedExtendedAbstracts || 0), ''],
        ['Excluded Preprints', String(diagnostics.excludedPreprints || 0), ''],
        ['DBLP Missing', String(diagnostics.dblpMissing || 0), ''],
        ['Ambiguous Matches', String(diagnostics.ambiguousMatches || 0), ''],
        ['Unranked Venues', String(diagnostics.unrankedVenues || 0), ''],
        ['Missing Author Count', String(diagnostics.missingAuthorCount || 0), ''],
    ].forEach(([labelText, valueText, className]) => {
        breakdownGrid.appendChild(createMetricCard(labelText, valueText, className));
    });
    breakdownSection.appendChild(breakdownGrid);
    body.appendChild(breakdownSection);
    const countedSection = document.createElement('section');
    countedSection.className = 'gsr-score-details__section';
    const countedHead = document.createElement('div');
    countedHead.className = 'gsr-score-details__section-head';
    const countedTitle = document.createElement('h4');
    countedTitle.textContent = 'Counted Publications';
    countedHead.appendChild(countedTitle);
    const countedSubtitle = document.createElement('p');
    countedSubtitle.className = 'gsr-score-details__section-subtitle';
    countedSubtitle.textContent = `${facultyScore.countedPublications.length} ranked paper${facultyScore.countedPublications.length === 1 ? '' : 's'} contributing to the score.`;
    countedHead.appendChild(countedSubtitle);
    countedSection.appendChild(countedHead);
    if (facultyScore.countedPublications.length) {
        const countedList = document.createElement('ul');
        countedList.className = 'gsr-score-details__pub-list';
        facultyScore.countedPublications.forEach((entry) => {
            const item = document.createElement('li');
            item.className = 'gsr-score-details__pub-item';
            const head = document.createElement('div');
            head.className = 'gsr-score-details__pub-head';
            const titleWrap = document.createElement('div');
            titleWrap.className = 'gsr-score-details__pub-title-wrap';
            const title = document.createElement('h5');
            title.className = 'gsr-score-details__pub-title';
            title.textContent = entry.title;
            titleWrap.appendChild(title);
            const subtitle = document.createElement('p');
            subtitle.className = 'gsr-score-details__pub-subtitle';
            subtitle.textContent = `${entry.venue || 'Matched venue unavailable'}${entry.year ? ` • ${entry.year}` : ''}`;
            titleWrap.appendChild(subtitle);
            head.appendChild(titleWrap);
            head.appendChild(createStaticRankBadge(entry.rank, entry.system));
            item.appendChild(head);
            const meta = document.createElement('div');
            meta.className = 'gsr-score-details__pub-meta';
            [
                `venue value ${formatNullableFactor(entry.weight)}`,
                `fractional credit ${formatNullableFactor(entry.fractionalCredit)}`,
                entry.publicationType ? `type ${entry.publicationType}` : null,
                `contribution ${formatNullableFactor(entry.credit)}`,
                `${entry.authorCount} author${entry.authorCount === 1 ? '' : 's'}`,
                entry.rankingSnapshotYear ? `snapshot ${entry.rankingSnapshotYear}` : null,
                entry.system,
            ].filter(Boolean).forEach((text) => {
                const pill = document.createElement('span');
                pill.className = 'gsr-score-details__pill';
                pill.textContent = text;
                meta.appendChild(pill);
            });
            item.appendChild(meta);
            if (Array.isArray(entry.decisionEvidence) && entry.decisionEvidence.length) {
                const evidence = document.createElement('p');
                evidence.className = 'gsr-score-details__pub-evidence';
                evidence.textContent = `Evidence: ${entry.decisionEvidence.join(', ')}`;
                item.appendChild(evidence);
            }
            countedList.appendChild(item);
        });
        countedSection.appendChild(countedList);
    }
    else {
        const empty = document.createElement('p');
        empty.className = 'gsr-detail-drawer__empty';
        empty.textContent = 'No ranked conference or journal venues contributed to the score on this profile.';
        countedSection.appendChild(empty);
    }
    body.appendChild(countedSection);
    openDialogOverlay(overlay, panel);
}
function ensureCompletenessBreakdownOverlay() {
    if (gsrCompletenessOverlayEl && document.body.contains(gsrCompletenessOverlayEl)) {
        return gsrCompletenessOverlayEl;
    }
    const scaffold = createDialogOverlay({
        overlayId: COMPLETENESS_OVERLAY_ID,
        panelClass: 'gsr-completeness-panel',
        titleId: 'gsr-completeness-title',
        titleText: 'Scoring Completeness',
        descriptionId: 'gsr-completeness-description',
        descriptionText: 'How much of this Scholar profile could be used in the GSVR Score.'
    });
    scaffold.overlay.classList.add('gsr-dialog-overlay--drawer');
    gsrCompletenessOverlayEl = scaffold.overlay;
    return scaffold.overlay;
}
function openCompletenessBreakdownOverlay() {
    const overlay = ensureCompletenessBreakdownOverlay();
    const panel = overlay.querySelector('.gsr-completeness-panel');
    const body = panel?.querySelector('.gsr-dialog-panel__body');
    if (!(panel instanceof HTMLElement) || !(body instanceof HTMLElement)) {
        return;
    }
    const facultyScore = currentSummaryState?.venueProfileIndex || currentSummaryState?.facultyScore || buildFacultyScoreState(currentSummaryState?.publicationRanks || []);
    const completeness = normalizeScoringCompleteness(facultyScore.completeness, facultyScore.diagnostics || facultyScore.coverage, facultyScore.combinedIndex || facultyScore.rawProfileScore?.scores, currentSummaryState?.publicationRanks || []);
    body.innerHTML = '';
    const total = Math.max(0, Number(completeness.total) || 0);
    const scored = Math.max(0, Number(completeness.scored) || 0);
    const notScored = Math.max(0, total - scored);
    const details = [
        ['scored', 'Scored', completeness.scored, 'eligible, ranked, with author counts.'],
        ['dblpMissing', 'DBLP missing', completeness.dblpMissing, 'Scholar items not found in the matched DBLP profile.'],
        ['ambiguous', 'Ambiguous', completeness.ambiguous, 'Multiple plausible DBLP matches; not scored.'],
        ['rankNotFound', 'Venue unranked', completeness.rankNotFound, 'Verified items whose venue has no CORE/SJR rank.'],
        ['excludedType', 'Excluded type', completeness.excludedType, 'Policy exclusions such as workshops, demos, posters, preprints, or short papers.'],
        ['missingAuthorCount', 'Missing author count', completeness.missingAuthorCount, 'Verified/ranked items without usable DBLP author-count metadata.'],
        ['lookupUnavailable', 'Lookup unavailable', completeness.lookupUnavailable, 'Items skipped because DBLP lookup was unavailable or rate-limited.'],
    ];
    const hero = document.createElement('section');
    hero.className = 'gsr-completeness-panel__dashboard';
    const heroTop = document.createElement('div');
    heroTop.className = 'gsr-completeness-panel__topline';
    const primary = document.createElement('div');
    primary.className = 'gsr-completeness-panel__primary';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'gsr-completeness-panel__eyebrow';
    eyebrow.textContent = 'Scoring Completeness';
    const percent = document.createElement('strong');
    percent.className = 'gsr-completeness-panel__percent';
    percent.textContent = formatCompletenessPercent(completeness);
    const summary = document.createElement('p');
    summary.className = 'gsr-completeness-panel__summary';
    summary.textContent = `${scored} of ${total} Scholar publications were usable for GSVR scoring.`;
    primary.appendChild(eyebrow);
    primary.appendChild(percent);
    primary.appendChild(summary);
    heroTop.appendChild(primary);
    const totals = document.createElement('div');
    totals.className = 'gsr-completeness-panel__totals';
    [
        ['Scored', scored],
        ['Not scored', notScored],
        ['Total', total],
    ].forEach(([labelText, valueText]) => {
        const item = document.createElement('div');
        const value = document.createElement('strong');
        value.textContent = String(valueText);
        const label = document.createElement('span');
        label.textContent = labelText;
        item.appendChild(value);
        item.appendChild(label);
        totals.appendChild(item);
    });
    heroTop.appendChild(totals);
    hero.appendChild(heroTop);
    hero.appendChild(createScoringCompletenessBar(completeness, 'gsr-completeness-bar--large'));
    const legend = document.createElement('div');
    legend.className = 'gsr-completeness-panel__legend';
    details.filter(([key, , count]) => key === 'scored' || Number(count) > 0).forEach(([key, labelText, count]) => {
        const chip = document.createElement('span');
        chip.className = 'gsr-completeness-panel__legend-chip';
        const swatch = document.createElement('i');
        swatch.className = `gsr-completeness-panel__swatch gsr-completeness-panel__swatch--${key}`;
        swatch.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.textContent = `${labelText} ${count}`;
        chip.appendChild(swatch);
        chip.appendChild(text);
        legend.appendChild(chip);
    });
    hero.appendChild(legend);
    const note = document.createElement('p');
    note.className = 'gsr-completeness-panel__copy';
    note.textContent = 'This diagnostic is separate from the GSVR Score. Low completeness means the visible Scholar profile is only partially represented in the score.';
    hero.appendChild(note);
    body.appendChild(hero);

    const reasons = document.createElement('section');
    reasons.className = 'gsr-completeness-panel__section';
    const reasonsHead = document.createElement('div');
    reasonsHead.className = 'gsr-completeness-panel__section-head';
    const reasonsTitle = document.createElement('h4');
    reasonsTitle.textContent = 'Publication Status';
    const reasonsMeta = document.createElement('span');
    reasonsMeta.textContent = `${notScored} not scored`;
    reasonsHead.appendChild(reasonsTitle);
    reasonsHead.appendChild(reasonsMeta);
    reasons.appendChild(reasonsHead);
    const rows = document.createElement('div');
    rows.className = 'gsr-completeness-panel__rows';
    details.forEach(([key, labelText, count, copy]) => {
        const numericCount = Math.max(0, Number(count) || 0);
        const row = document.createElement('div');
        row.className = `gsr-completeness-panel__row${numericCount === 0 ? ' gsr-completeness-panel__row--empty' : ''}`;
        const marker = document.createElement('span');
        marker.className = `gsr-completeness-panel__marker gsr-completeness-panel__marker--${key}`;
        marker.setAttribute('aria-hidden', 'true');
        const copyWrap = document.createElement('div');
        copyWrap.className = 'gsr-completeness-panel__row-copy';
        const label = document.createElement('strong');
        label.textContent = labelText;
        const text = document.createElement('span');
        text.textContent = copy;
        copyWrap.appendChild(label);
        copyWrap.appendChild(text);
        const metric = document.createElement('div');
        metric.className = 'gsr-completeness-panel__row-metric';
        const value = document.createElement('strong');
        value.textContent = String(numericCount);
        const share = document.createElement('span');
        share.textContent = total > 0 ? `${Math.round((numericCount / total) * 100)}%` : '0%';
        metric.appendChild(value);
        metric.appendChild(share);
        row.appendChild(marker);
        row.appendChild(copyWrap);
        row.appendChild(metric);
        rows.appendChild(row);
    });
    reasons.appendChild(rows);
    body.appendChild(reasons);

    const formula = document.createElement('section');
    formula.className = 'gsr-completeness-panel__formula-strip';
    const formulaText = document.createElement('code');
    formulaText.textContent = 'Completeness = N_scored / N_total';
    const identity = document.createElement('p');
    identity.textContent = 'N_total = scored + DBLP missing + ambiguous + rank not found + excluded type + missing author count + lookup unavailable.';
    formula.appendChild(formulaText);
    formula.appendChild(identity);
    body.appendChild(formula);
    openDialogOverlay(overlay, panel);
}
function displayFacultyScorePanel(summaryState) {
    document.getElementById(FACULTY_SCORE_PANEL_ID)?.remove();
    if (!summaryState) {
        return;
    }
    const facultyScore = summaryState.venueProfileIndex || summaryState.facultyScore || buildFacultyScoreState(summaryState.publicationRanks || []);
    const panel = document.createElement('div');
    panel.id = FACULTY_SCORE_PANEL_ID;
    panel.className = 'gsc_rsb_s gsc_prf_pnl gsr-card gsr-faculty-score-card';
    const header = document.createElement('div');
    header.className = 'gsr-card__header';
    const titleGroup = document.createElement('div');
    titleGroup.className = 'gsr-card__title-group';
    const title = document.createElement('div');
    title.className = 'gsr-card__title';
    title.textContent = 'GSVR Score';
    titleGroup.appendChild(title);
    header.appendChild(titleGroup);
    const detailsButton = document.createElement('button');
    detailsButton.type = 'button';
    detailsButton.className = 'gsr-button gsr-button--secondary gsr-button--compact gsr-faculty-score-card__evidence';
    detailsButton.textContent = 'Evidence';
    detailsButton.title = 'View publication-level scoring evidence';
    detailsButton.addEventListener('click', () => openScoreDetailsOverlay());
    header.appendChild(detailsButton);
    panel.appendChild(header);
    const hero = document.createElement('div');
    hero.className = 'gsr-faculty-score-card__hero';
    const scoreValue = document.createElement('span');
    scoreValue.className = 'gsr-faculty-score-card__value';
    scoreValue.textContent = Number(facultyScore.gsvrScore || 0).toFixed(4);
    hero.appendChild(scoreValue);
    panel.appendChild(hero);
    const completeness = normalizeScoringCompleteness(facultyScore.completeness, facultyScore.diagnostics || facultyScore.coverage, facultyScore.combinedIndex || facultyScore.rawProfileScore?.scores, summaryState.publicationRanks || []);
    const completenessCard = document.createElement('div');
    completenessCard.setAttribute('role', 'button');
    completenessCard.tabIndex = 0;
    completenessCard.className = 'gsr-completeness-card';
    completenessCard.title = 'Scoring Completeness shows how much of this Scholar profile could be used in the GSVR Score. Publications may be unscored because they are missing from DBLP, ambiguous, unranked, excluded publication types, or missing author-count metadata.';
    completenessCard.setAttribute('aria-label', `Scoring Completeness ${formatCompletenessPercent(completeness)}. Open breakdown.`);
    const completenessHead = document.createElement('div');
    completenessHead.className = 'gsr-completeness-card__head';
    const completenessLabel = document.createElement('span');
    completenessLabel.className = 'gsr-completeness-card__label';
    completenessLabel.textContent = 'Scoring Completeness';
    const infoIcon = document.createElement('span');
    infoIcon.className = 'gsr-completeness-card__info';
    infoIcon.textContent = 'i';
    infoIcon.setAttribute('aria-hidden', 'true');
    completenessLabel.appendChild(infoIcon);
    const completenessPercent = document.createElement('strong');
    completenessPercent.className = 'gsr-completeness-card__percent';
    completenessPercent.textContent = formatCompletenessPercent(completeness);
    completenessHead.appendChild(completenessLabel);
    completenessHead.appendChild(completenessPercent);
    completenessCard.appendChild(completenessHead);
    completenessCard.appendChild(createScoringCompletenessBar(completeness));
    const completenessSummary = document.createElement('div');
    completenessSummary.className = 'gsr-completeness-card__summary';
    completenessSummary.textContent = `${completeness.scored}/${completeness.total} scored · ${formatCompletenessPercent(completeness)} completeness`;
    completenessCard.appendChild(completenessSummary);
    completenessCard.addEventListener('click', () => openCompletenessBreakdownOverlay());
    completenessCard.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openCompletenessBreakdownOverlay();
        }
    });
    panel.appendChild(completenessCard);
    const summaryPanel = document.getElementById(SUMMARY_PANEL_ID);
    const gsBdy = document.getElementById('gs_bdy');
    const rightSidebarContainer = gsBdy?.querySelector('div.gsc_rsb');
    if (rightSidebarContainer) {
        if (summaryPanel) {
            rightSidebarContainer.insertBefore(panel, summaryPanel);
        }
        else {
            rightSidebarContainer.prepend(panel);
        }
    }
    else if (summaryPanel?.parentNode) {
        summaryPanel.parentNode.insertBefore(panel, summaryPanel);
    }
    else {
        document.body.prepend(panel);
    }
}
// --- END: Manual Rank/Quartile Search Utility (Phase 2) ---
function createStatusElement(initialMessage = "Initializing...") {
    disconnectPublicationTableObserver();
    activeCachedPublicationRanks = null;
    rankMapForObserver = null;
    activeSummaryFilter = null;
    previewSummaryFilter = null;
    document.getElementById(FACULTY_SCORE_PANEL_ID)?.remove();
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    removeCitationGraphRankChips();
    const container = document.createElement('div');
    container.id = STATUS_ELEMENT_ID;
    container.className = 'gsc_rsb_s gsc_prf_pnl gsr-card gsr-status-card';
    const titleRow = document.createElement('div');
    titleRow.className = 'gsr-status-card__title-row';
    const spinner = document.createElement('span');
    spinner.className = 'gsr-spinner gsr-spinner--status';
    spinner.setAttribute('aria-hidden', 'true');
    for (let index = 1; index <= 5; index += 1) {
        const square = document.createElement('span');
        square.className = `gsr-status-loader-square gsr-status-loader-square--${index}`;
        spinner.appendChild(square);
    }
    titleRow.appendChild(spinner);
    const title = document.createElement('div');
    title.className = 'gsr-card__title gsr-status-card__title-text';
    title.textContent = "Rank Processing";
    titleRow.appendChild(title);
    container.appendChild(titleRow);
    const progressBarOuter = document.createElement('div');
    progressBarOuter.className = 'gsr-progress';
    container.appendChild(progressBarOuter);
    const progressBarInner = document.createElement('div');
    progressBarInner.classList.add('gsr-progress-bar-inner');
    progressBarInner.style.width = '0%';
    progressBarOuter.appendChild(progressBarInner);
    const statusText = document.createElement('div');
    statusText.classList.add('gsr-status-text');
    statusText.setAttribute('aria-live', 'polite');
    statusText.textContent = initialMessage;
    container.appendChild(statusText);
    const gsBdy = document.getElementById('gs_bdy');
    if (!gsBdy) {
        document.body.prepend(container);
        return container;
    }
    const rightSidebarContainer = gsBdy.querySelector('div.gsc_rsb');
    if (rightSidebarContainer) {
        const citedByElement = rightSidebarContainer.querySelector('#gsc_rsb_cit');
        const publicAccessElement = rightSidebarContainer.querySelector('#gsc_rsb_mnd');
        const coauthorsElement = rightSidebarContainer.querySelector('#gsc_rsb_co');
        if (publicAccessElement)
            rightSidebarContainer.insertBefore(container, publicAccessElement);
        else if (coauthorsElement)
            rightSidebarContainer.insertBefore(container, coauthorsElement);
        else if (citedByElement?.nextSibling)
            rightSidebarContainer.insertBefore(container, citedByElement.nextSibling);
        else if (citedByElement)
            citedByElement.parentNode?.appendChild(container);
        else
            rightSidebarContainer.prepend(container);
    }
    else {
        const profileTableContainer = document.getElementById('gsc_a_c');
        if (profileTableContainer)
            profileTableContainer.before(container);
        else
            document.body.prepend(container);
    }
    return container;
}
function setStatusCardTitle(statusElement, titleText) {
    const title = statusElement?.querySelector('.gsr-status-card__title-text');
    if (title) {
        title.textContent = titleText;
    }
}
function setStatusCardSpinnerVisible(statusElement, visible) {
    const spinner = statusElement?.querySelector('.gsr-status-card__title-row .gsr-spinner');
    if (spinner instanceof HTMLElement) {
        spinner.style.display = visible ? '' : 'none';
    }
}
function updateStatusElement(statusContainer, processed, total, messagePrefix) {
    if (!statusContainer) {
        return;
    }
    const progressBarInner = statusContainer.querySelector('.gsr-progress-bar-inner');
    const statusText = statusContainer.querySelector('.gsr-status-text');
    const percentage = total > 0 ? (processed / total) * 100 : 0;
    if (progressBarInner)
        progressBarInner.style.width = `${percentage}%`;
    const prefix = messagePrefix ? messagePrefix + ": " : "";
    if (statusText)
        statusText.textContent = `${prefix}Processing ${processed} of ${total} publications…`;
}
function displayDormantStatus() {
    const statusElement = createStatusElement("Auto-run is off for this Scholar profile.");
    statusElement.querySelector('.gsr-progress')?.remove();
    const statusText = statusElement.querySelector('.gsr-status-text');
    if (statusText) {
        statusText.textContent = 'Turn on auto-run in the extension popup or start analysis manually here.';
    }
    const actions = document.createElement('div');
    actions.className = 'gsr-card__actions gsr-card__actions--stack';
    const runButton = document.createElement('button');
    runButton.type = 'button';
    runButton.className = 'gsr-button gsr-button--primary';
    runButton.textContent = 'Run Analysis';
    runButton.addEventListener('click', () => {
        document.getElementById(STATUS_ELEMENT_ID)?.remove();
        warmRankingsData('manual-run');
        main().catch(error => console.error('GSR: Error while manually starting analysis.', error));
    });
    actions.appendChild(runButton);
    const searchButton = document.createElement('button');
    searchButton.type = 'button';
    searchButton.className = 'gsr-button gsr-button--ghost';
    searchButton.textContent = 'Open Search Utility';
    searchButton.addEventListener('click', () => openSearchUtilityOverlay());
    actions.appendChild(searchButton);
    statusElement.appendChild(actions);
    return statusElement;
}
// --- Sparse-profile citation-graph chips ------------------------------------
// Profiles with only a handful of ranked papers get per-year rank chips
// stacked above Scholar's own citations-per-year bars (richer than the nearly
// empty aggregate histograms). Dense profiles keep the timeline view instead.
const CITATION_GRAPH_BADGES_ID = 'gsr-citation-graph-badges';
const SPARSE_PROFILE_RANKED_LIMIT = 25;
const SPARSE_CHIP_WINDOW_YEARS = 8;
const MAX_CITATION_CHIPS_PER_YEAR = 4;
const CITATION_CHIP_HEIGHT = 15;
const CITATION_CHIP_GAP = 2;
const CITATION_CHIP_BAR_GAP = 3;
const CITATION_GRAPH_RETRY_LIMIT = 2;
const CITATION_CHIP_EDGE_PADDING = 15;
const CITATION_GRAPH_GUTTER_CLASS = 'gsr-citation-graph-gutter';
function removeCitationGraphRankChips() {
    document.getElementById(CITATION_GRAPH_BADGES_ID)?.remove();
    document.querySelectorAll('.gsr-citation-graph--with-badges').forEach((graph) => {
        graph.classList.remove('gsr-citation-graph--with-badges');
        if (graph instanceof HTMLElement) {
            graph.querySelector(`:scope > .${CITATION_GRAPH_GUTTER_CLASS}`)?.remove();
        }
    });
}
function getSparseRankChipState(summaryState) {
    if (!TIMELINE_STATS_API?.buildSparseRankChips) {
        return null;
    }
    const publications = summaryState?.allPublicationRanks || summaryState?.publicationRanks || [];
    return TIMELINE_STATS_API.buildSparseRankChips(publications, {
        currentYear: summaryState?.timeline?.currentYear || getTimelineCurrentYear(),
        windowYears: SPARSE_CHIP_WINDOW_YEARS,
        sparseLimit: SPARSE_PROFILE_RANKED_LIMIT
    });
}
function findScholarCitationGraphElement() {
    return document.getElementById('gsc_g')
        || document.querySelector('#gsc_rsb_cit .gsc_g_hist_wrp')
        || document.querySelector('.gsc_g_hist_wrp');
}
function getCitationGraphStackDepth(chipState) {
    let maxDepth = 0;
    const chipsByYear = chipState?.chipsByYear || {};
    for (const chips of Object.values(chipsByYear)) {
        if (!Array.isArray(chips) || !chips.length) {
            continue;
        }
        maxDepth = Math.max(maxDepth, Math.min(chips.length, MAX_CITATION_CHIPS_PER_YEAR));
    }
    return maxDepth;
}
function getCitationChipStackHeight(chipCount) {
    const count = Math.max(0, Math.round(Number(chipCount) || 0));
    if (count <= 0) {
        return 0;
    }
    return CITATION_CHIP_HEIGHT + ((count - 1) * (CITATION_CHIP_HEIGHT + CITATION_CHIP_GAP));
}
function getCitationGraphYearLayout(label, bars, graphRect) {
    const labelRect = label.getBoundingClientRect();
    const labelCenterX = labelRect.left - graphRect.left + (labelRect.width / 2);
    let chipCenterX = labelCenterX;
    let barTop = graphRect.height - labelRect.height - CITATION_CHIP_HEIGHT - 8;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const bar of bars) {
        const barRect = bar.getBoundingClientRect();
        const barCenter = barRect.left - graphRect.left + (barRect.width / 2);
        const distance = Math.abs(barCenter - labelCenterX);
        if (distance < bestDistance && distance <= Math.max(12, barRect.width * 1.5)) {
            bestDistance = distance;
            barTop = barRect.top - graphRect.top;
            chipCenterX = barCenter;
        }
    }
    return { barTop, chipCenterX };
}
function reserveCitationGraphTopGutter(graph, chipState, yearLabels, bars, graphRect) {
    if (!(graph instanceof HTMLElement)) {
        return;
    }
    const stackDepth = getCitationGraphStackDepth(chipState);
    if (stackDepth <= 0) {
        return;
    }
    let gutter = 0;
    for (const label of yearLabels) {
        const year = parseInt(label.textContent || '', 10);
        const chips = chipState?.chipsByYear?.[year];
        if (!Number.isFinite(year) || !Array.isArray(chips) || !chips.length) {
            continue;
        }
        const layout = getCitationGraphYearLayout(label, bars, graphRect);
        const stackHeight = getCitationChipStackHeight(Math.min(chips.length, MAX_CITATION_CHIPS_PER_YEAR));
        gutter = Math.max(gutter, stackHeight + CITATION_CHIP_BAR_GAP - layout.barTop);
    }
    gutter = Math.max(0, Math.ceil(gutter));
    let spacer = graph.querySelector(`:scope > .${CITATION_GRAPH_GUTTER_CLASS}`);
    if (gutter <= 0) {
        spacer?.remove();
        graph.classList.remove('gsr-citation-graph--with-badges');
        return;
    }
    if (!(spacer instanceof HTMLElement)) {
        spacer = document.createElement('div');
        spacer.className = CITATION_GRAPH_GUTTER_CLASS;
        spacer.setAttribute('aria-hidden', 'true');
        graph.insertBefore(spacer, graph.firstChild);
    }
    graph.classList.add('gsr-citation-graph--with-badges');
    spacer.style.height = `${gutter}px`;
}
function scheduleCitationGraphRankChips(chipState) {
    if (!chipState?.isSparse) {
        removeCitationGraphRankChips();
        return;
    }
    const run = () => annotateScholarCitationGraph(chipState, 0);
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run);
    }
    else {
        run();
    }
}
function retryCitationGraphAnnotation(chipState, attempt) {
    if (attempt >= CITATION_GRAPH_RETRY_LIMIT || !chipState?.isSparse) {
        return;
    }
    const run = () => annotateScholarCitationGraph(chipState, attempt + 1);
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(run);
    }
    else if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
        window.setTimeout(run, 0);
    }
    else {
        run();
    }
}
function annotateScholarCitationGraph(chipState, attempt = 0) {
    removeCitationGraphRankChips();
    if (!chipState?.isSparse) {
        return;
    }
    const graph = findScholarCitationGraphElement();
    if (!graph) {
        retryCitationGraphAnnotation(chipState, attempt);
        return;
    }
    if (getComputedStyle(graph).position === 'static') {
        graph.style.position = 'relative';
    }
    const yearLabels = Array.from(graph.querySelectorAll('.gsc_g_t'));
    if (!yearLabels.length) {
        retryCitationGraphAnnotation(chipState, attempt);
        return;
    }
    let graphRect = graph.getBoundingClientRect();
    if (!graphRect.width || !graphRect.height) {
        retryCitationGraphAnnotation(chipState, attempt);
        return;
    }
    const bars = Array.from(graph.querySelectorAll('a.gsc_g_a, .gsc_g_a'));
    reserveCitationGraphTopGutter(graph, chipState, yearLabels, bars, graphRect);
    graphRect = graph.getBoundingClientRect();
    const container = document.createElement('div');
    container.id = CITATION_GRAPH_BADGES_ID;
    container.className = 'gsr-citation-chips';
    container.setAttribute('aria-hidden', 'false');
    const chipStep = CITATION_CHIP_HEIGHT + CITATION_CHIP_GAP;
    for (const label of yearLabels) {
        const year = parseInt(label.textContent || '', 10);
        const chips = chipState.chipsByYear?.[year];
        if (!Number.isFinite(year) || !chips?.length) {
            continue;
        }
        const { barTop, chipCenterX } = getCitationGraphYearLayout(label, bars, graphRect);
        // chips[] is sorted ascending by prestige; keep the TOP of the stack
        // (the strongest ranks) and fold the rest into a "+N" chip.
        let visibleChips = chips;
        let hiddenCount = 0;
        if (chips.length > MAX_CITATION_CHIPS_PER_YEAR) {
            hiddenCount = chips.length - (MAX_CITATION_CHIPS_PER_YEAR - 1);
            visibleChips = chips.slice(-(MAX_CITATION_CHIPS_PER_YEAR - 1));
        }
        const chipEntries = [];
        if (hiddenCount > 0) {
            chipEntries.push({
                text: `+${hiddenCount}`,
                rankClass: null,
                titleText: `${hiddenCount} more ranked paper${hiddenCount === 1 ? '' : 's'} in ${year}`
            });
        }
        visibleChips.forEach((rank) => {
            chipEntries.push({
                text: rank,
                rankClass: normalizeRankKey(rank),
                titleText: `${rank} paper published in ${year}`
            });
        });
        const stackTop = Math.max(0, Math.round(barTop - getCitationChipStackHeight(chipEntries.length) - CITATION_CHIP_BAR_GAP));
        const boundedChipCenterX = Math.max(
            CITATION_CHIP_EDGE_PADDING,
            Math.min(graphRect.width - CITATION_CHIP_EDGE_PADDING, chipCenterX)
        );
        chipEntries.forEach((entry, stackIndex) => {
            const chip = document.createElement('span');
            chip.className = `gsr-citation-chip${entry.rankClass ? ` gsr-citation-chip--${entry.rankClass}` : ' gsr-citation-chip--more'}`;
            chip.textContent = entry.text;
            chip.setAttribute('title', entry.titleText);
            chip.setAttribute('aria-label', entry.titleText);
            chip.style.left = `${Math.round(boundedChipCenterX)}px`;
            chip.style.top = `${stackTop + ((chipEntries.length - stackIndex - 1) * chipStep)}px`;
            container.appendChild(chip);
        });
    }
    if (container.childNodes.length) {
        graph.appendChild(container);
    }
}
function createAuthorshipSettingsControl() {
    const wrapper = document.createElement('div');
    wrapper.className = 'gsr-authorship-setting';
    const label = document.createElement('label');
    label.className = 'gsr-authorship-setting__label';
    const title = document.createElement('span');
    title.className = 'gsr-authorship-setting__title';
    title.textContent = 'Highlight first- and last-author publications';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'gsr-authorship-setting__input';
    input.dataset.gsrAuthorshipToggleInput = 'true';
    input.checked = currentSettings.showAuthorshipHighlights === true;
    input.setAttribute('aria-label', 'Highlight first and last authorship');
    input.addEventListener('change', () => {
        setAuthorshipHighlightsEnabled(input.checked).catch((error) => {
            console.error('GSR: Failed to update authorship highlight setting.', error);
            input.checked = currentSettings.showAuthorshipHighlights === true;
            syncAuthorshipSettingControls();
        });
    });
    const switchVisual = document.createElement('span');
    switchVisual.className = 'gsr-authorship-setting__switch';
    switchVisual.setAttribute('aria-hidden', 'true');
    label.appendChild(title);
    label.appendChild(input);
    label.appendChild(switchVisual);
    wrapper.appendChild(label);
    return wrapper;
}
function displaySummaryPanel(coreRankCounts, sjrRankCounts, currentUserId, initialCachedPubRanks, cacheTimestamp, dblpAuthorPid, scanLifecycle = null, profileContextOverrides = null) {
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    disconnectPublicationTableObserver();
    hideBadgePopover(true);
    currentProfileContext = {
        userId: currentUserId || null,
        authorName: profileContextOverrides?.authorName || getScholarAuthorName(),
        dblpAuthorPid: dblpAuthorPid || null,
        dblpPidSource: profileContextOverrides?.dblpPidSource || null,
        surfaceMode: getScholarSurfaceMode(),
        scholarProfileUrl: window.location?.href || null,
    };
    currentSummaryState = buildSummaryState(coreRankCounts, sjrRankCounts, initialCachedPubRanks || [], cacheTimestamp, scanLifecycle);
    const countSnapshot = buildSummaryCountSnapshot(currentSummaryState);
    const totalRankedPapers = countSnapshot.rankedCount;
    const panel = document.createElement('div');
    panel.id = SUMMARY_PANEL_ID;
    panel.className = 'gsc_rsb_s gsc_prf_pnl gsr-card gsr-summary-card';
    const headerDiv = document.createElement('div');
    headerDiv.className = 'gsr-card__header';
    const titleGroup = document.createElement('div');
    titleGroup.className = 'gsr-card__title-group';
    const titleLine = document.createElement('div');
    titleLine.className = 'gsr-card__title-line';
    const summaryTitle = document.createElement('span');
    summaryTitle.className = 'gsr-card__title';
    summaryTitle.textContent = 'Venue Profile Report';
    titleLine.appendChild(summaryTitle);
    const summaryCount = document.createElement('span');
    summaryCount.className = 'gsr-pill gsr-pill--accent gsr-summary-total';
    summaryCount.textContent = `${totalRankedPapers} ranked`;
    titleLine.appendChild(summaryCount);
    if (currentProfileContext.dblpPidSource === 'manual') {
        const sourceBadge = document.createElement('span');
        sourceBadge.className = 'gsr-pill gsr-pill--neutral gsr-summary-source-pill';
        sourceBadge.textContent = 'Manual DBLP';
        titleLine.appendChild(sourceBadge);
    }
    titleGroup.appendChild(titleLine);
    headerDiv.appendChild(titleGroup);
    headerDiv.appendChild(createDateRangeToggle(currentSummaryState));
    if (currentUserId) {
        const headerActions = document.createElement('div');
        headerActions.className = 'gsr-summary-header__actions';
        const createHeaderActionButton = ({ label, ariaLabel = label, iconText, title, variant = 'neutral', onClick }) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `gsr-summary-header__action gsr-summary-header__action--${variant}`;
            button.setAttribute('title', title);
            button.setAttribute('aria-label', ariaLabel);
            if (iconText) {
                const icon = document.createElement('span');
                icon.className = 'gsr-summary-header__action-icon';
                icon.setAttribute('aria-hidden', 'true');
                const iconGlyph = document.createElement('span');
                iconGlyph.className = 'gsr-summary-header__action-icon-glyph';
                iconGlyph.textContent = iconText;
                icon.appendChild(iconGlyph);
                button.appendChild(icon);
            }
            const actionLabel = document.createElement('span');
            actionLabel.className = 'gsr-summary-header__action-label';
            actionLabel.textContent = label;
            button.appendChild(actionLabel);
            if (typeof onClick === 'function') {
                button.addEventListener('click', onClick);
            }
            return button;
        };
        headerActions.appendChild(createHeaderActionButton({
            label: 'Rescan',
            title: 'Clear cached results and rescan this Scholar profile',
            variant: 'rescan',
            onClick: () => {
                rescanCurrentProfile().catch((error) => console.error('GSR: Failed to start rescan.', error));
            }
        }));
        headerActions.appendChild(createHeaderActionButton({
            label: 'Find Venues',
            title: 'Find venues across the bundled CORE and SJR datasets',
            variant: 'explore',
            onClick: () => openSearchUtilityOverlay()
        }));
        headerActions.appendChild(createHeaderActionButton({
            label: 'Download Report',
            iconText: '⇩',
            title: 'Download the current venue profile report',
            variant: 'download',
            onClick: () => openExportOverlay()
        }));
        headerDiv.appendChild(headerActions);
    }
    panel.appendChild(headerDiv);
    if (scanLifecycle?.message) {
        const lifecyclePresentation = getScanLifecyclePresentation(scanLifecycle);
        const lifecycleBanner = document.createElement('div');
        lifecycleBanner.className = `gsr-summary-lifecycle gsr-summary-lifecycle--${scanLifecycle.status || 'info'}`;
        const lifecycleBadge = document.createElement('span');
        lifecycleBadge.className = 'gsr-summary-lifecycle__badge';
        if (scanLifecycle.status === 'running') {
            const lifecycleSpinner = document.createElement('span');
            lifecycleSpinner.className = 'gsr-spinner gsr-spinner--inline';
            lifecycleSpinner.setAttribute('aria-hidden', 'true');
            lifecycleBadge.appendChild(lifecycleSpinner);
        }
        const lifecycleLabel = document.createElement('span');
        lifecycleLabel.textContent = lifecyclePresentation?.chip || 'STATUS';
        lifecycleBadge.appendChild(lifecycleLabel);
        const lifecycleBody = document.createElement('div');
        lifecycleBody.className = 'gsr-summary-lifecycle__body';
        const lifecycleTitle = document.createElement('div');
        lifecycleTitle.className = 'gsr-summary-lifecycle__title';
        lifecycleTitle.textContent = lifecyclePresentation?.title || 'Scan update';
        const lifecycleText = document.createElement('div');
        lifecycleText.className = 'gsr-summary-lifecycle__message';
        lifecycleText.textContent = lifecyclePresentation?.message || scanLifecycle.message;
        lifecycleBody.appendChild(lifecycleTitle);
        lifecycleBody.appendChild(lifecycleText);
        lifecycleBanner.appendChild(lifecycleBadge);
        lifecycleBanner.appendChild(lifecycleBody);
        if (scanLifecycle.status === 'completed') {
            const dismissButton = document.createElement('button');
            dismissButton.type = 'button';
            dismissButton.className = 'gsr-summary-lifecycle__dismiss';
            dismissButton.setAttribute('aria-label', 'Dismiss depth completion message');
            dismissButton.setAttribute('title', 'Dismiss this message');
            dismissButton.textContent = '×';
            dismissButton.addEventListener('click', () => {
                lifecycleBanner.remove();
                if (currentSummaryState?.scanLifecycle?.status === 'completed') {
                    currentSummaryState.scanLifecycle = null;
                }
                const currentUserIdForDismissal = currentSummaryState?.context?.userId || currentProfileContext.userId;
                void setCachedDepthCompletionDismissed(currentUserIdForDismissal, true);
            });
            lifecycleBanner.appendChild(dismissButton);
        }
        panel.appendChild(lifecycleBanner);
    }
    const attachSummaryFilterInteractions = (element, filter, { preview = true } = {}) => {
        element.addEventListener('click', () => toggleSummaryFilter(filter));
        if (!preview) {
            return;
        }
        element.addEventListener('mouseenter', () => setSummaryFilterPreview(filter));
        element.addEventListener('focus', () => setSummaryFilterPreview(filter));
        element.addEventListener('mouseleave', () => clearSummaryFilterPreview(filter));
        element.addEventListener('blur', () => clearSummaryFilterPreview(filter));
    };
    const summarySectionsContainer = document.createElement('div');
    summarySectionsContainer.className = 'gsr-summary-sections';
    const createSummaryBadge = (rank, system, chipText = null) => {
        if (chipText) {
            const chip = document.createElement('span');
            chip.className = 'gsr-rank-badge gsr-rank-badge--ranked gsr-rank-badge--neutral gsr-summary-row__badge gsr-summary-row__status-chip';
            chip.dataset.gsrStatusChip = normalizeRankKey(rank);
            chip.textContent = chipText;
            return chip;
        }
        const badge = createRankBadgeElement(rank, system, null, null);
        if (!badge) {
            const fallback = document.createElement('span');
            fallback.className = 'gsr-rank-badge gsr-rank-badge--ranked gsr-rank-badge--neutral gsr-summary-row__badge';
            fallback.textContent = rank;
            return fallback;
        }
        badge.classList.add('gsr-summary-row__badge');
        badge.removeAttribute('tabindex');
        badge.removeAttribute('aria-describedby');
        return badge;
    };
    const createSummarySection = ({ titleText, metaText = '', counts, orderedRanks, system, getFilter, getLabel, getInlineLabel = () => '', getChipText = () => null, showBadge = true }) => {
        const sectionWrapper = document.createElement('div');
        sectionWrapper.className = 'gsr-summary-section';
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'gsr-summary-section__header';
        const sectionTitle = document.createElement('div');
        sectionTitle.className = 'gsr-summary-section__title';
        sectionTitle.textContent = titleText;
        sectionHeader.appendChild(sectionTitle);
        const sectionMeta = document.createElement('span');
        sectionMeta.className = 'gsr-summary-section__meta';
        const sectionTotal = orderedRanks.reduce((total, rank) => total + (counts[rank] || 0), 0);
        sectionMeta.textContent = metaText ? `${metaText} ${sectionTotal}` : `${sectionTotal}`;
        sectionHeader.appendChild(sectionMeta);
        sectionWrapper.appendChild(sectionHeader);
        const list = document.createElement('div');
        list.className = 'gsr-summary-section__list';
        const displayRanks = orderedRanks.slice();
        let maxCountForScale = Math.max(1, ...displayRanks.map(rank => counts[rank] || 0));
        if (!Number.isFinite(maxCountForScale) || maxCountForScale <= 0)
            maxCountForScale = 1;
        for (const rank of displayRanks) {
            const count = counts[rank] || 0;
            const itemButton = document.createElement('button');
            itemButton.type = 'button';
            itemButton.className = 'gsr-summary-row';
            const filter = getFilter(rank);
            if (filter.type === 'rank') {
                itemButton.setAttribute('data-gsr-filter-type', 'rank');
                itemButton.setAttribute('data-gsr-system', filter.system);
                itemButton.setAttribute('data-gsr-rank', filter.rank);
            }
            else if (filter.type === 'status') {
                itemButton.setAttribute('data-gsr-filter-type', 'status');
                itemButton.setAttribute('data-gsr-status', filter.status);
            }
            else if (filter.type === 'authorship') {
                itemButton.setAttribute('data-gsr-filter-type', 'authorship');
                itemButton.setAttribute('data-gsr-author-role', filter.role);
            }
            attachSummaryFilterInteractions(itemButton, filter);
            itemButton.setAttribute('aria-label', `${titleText} ${getLabel(rank)} ${count} paper${count === 1 ? '' : 's'}`);
            if (showBadge !== false) {
                const summaryBadge = createSummaryBadge(rank, system, getChipText(rank));
                if (summaryBadge) {
                    itemButton.appendChild(summaryBadge);
                }
            }
            const mainContent = document.createElement('div');
            mainContent.className = 'gsr-summary-row__main';
            const inlineLabelText = getInlineLabel(rank);
            if (inlineLabelText) {
                const textLabel = document.createElement('span');
                textLabel.className = 'gsr-summary-row__label';
                textLabel.textContent = inlineLabelText;
                mainContent.appendChild(textLabel);
            }
            const barContainer = document.createElement('div');
            barContainer.className = 'gsr-summary-row__bar';
            const barFill = document.createElement('div');
            const percentageWidth = maxCountForScale > 0 ? (count / maxCountForScale) * 100 : 0;
            barFill.className = 'gsr-summary-row__bar-fill';
            barFill.style.width = `${Math.min(percentageWidth, 100)}%`;
            if (rank) {
                barFill.dataset.gsrRank = normalizeRankKey(rank);
            }
            barContainer.appendChild(barFill);
            mainContent.appendChild(barContainer);
            mainContent.classList.toggle('is-bar-only', !inlineLabelText);
            itemButton.appendChild(mainContent);
            const countTextSpan = document.createElement('span');
            countTextSpan.className = 'gsr-summary-row__count';
            countTextSpan.textContent = `${count}`;
            countTextSpan.setAttribute('aria-label', `${count} paper${count === 1 ? '' : 's'}`);
            countTextSpan.setAttribute('title', `${count} paper${count === 1 ? '' : 's'}`);
            itemButton.appendChild(countTextSpan);
            list.appendChild(itemButton);
        }
        sectionWrapper.appendChild(list);
        return sectionWrapper;
    };
    summarySectionsContainer.appendChild(createSummarySection({
        titleText: 'CORE Conference Profile',
        metaText: '',
        counts: currentSummaryState.coreRankCounts || createEmptyCoreRankCounts(),
        orderedRanks: ['A*', 'A', 'B', 'C'],
        system: 'CORE',
        getFilter: (rank) => ({ type: 'rank', system: 'core', rank: normalizeRankKey(rank) }),
        getLabel: (rank) => rank
    }));
    summarySectionsContainer.appendChild(createSummarySection({
        titleText: 'SJR Journal Profile',
        metaText: '',
        counts: currentSummaryState.sjrRankCounts || createEmptySjrRankCounts(),
        orderedRanks: ['Q1', 'Q2', 'Q3', 'Q4'],
        system: 'SJR',
        getFilter: (rank) => ({ type: 'rank', system: 'sjr', rank: normalizeRankKey(rank) }),
        getLabel: (rank) => rank
    }));
    const authorshipSummarySection = createSummarySection({
        titleText: 'Authorship Position',
        metaText: 'matches',
        counts: currentSummaryState.authorshipCounts || { first: 0, last: 0 },
        orderedRanks: ['first', 'last'],
        system: 'DBLP',
        getFilter: (role) => ({ type: 'authorship', role }),
        getLabel: (role) => role === 'first' ? 'First author' : 'Last author',
        getInlineLabel: (role) => role === 'first' ? 'First author' : 'Last author',
        showBadge: false
    });
    authorshipSummarySection.classList.add('gsr-authorship-summary-section');
    panel.appendChild(summarySectionsContainer);
    const timelineYear = currentSummaryState.timeline?.currentYear || getTimelineCurrentYear();
    const recentFocusedHistograms = getTimelineFocusedHistograms(currentSummaryState.timeline, 'recent');
    // Sparse profiles (<25 ranked papers in the recent window) replace the
    // timeline charts with per-year rank chips on Scholar's citation graph.
    const citationChipState = getSparseRankChipState(currentSummaryState);
    if (!citationChipState?.isSparse) {
        // Tier-3 "Explore": the tall timeline charts are secondary to the verdict
        // (score) and distribution tiers, so they collapse by default. Native
        // <details> keeps this keyboard-accessible for free; the open state
        // persists per browser.
        const EXPLORE_OPEN_STORAGE_KEY = 'gsvrExploreTimelinesOpen';
        const exploreSection = document.createElement('details');
        exploreSection.className = 'gsr-explore-section';
        try {
            exploreSection.open = window.localStorage?.getItem(EXPLORE_OPEN_STORAGE_KEY) === '1';
        }
        catch {
            exploreSection.open = false;
        }
        exploreSection.addEventListener('toggle', () => {
            try {
                window.localStorage?.setItem(EXPLORE_OPEN_STORAGE_KEY, exploreSection.open ? '1' : '0');
            }
            catch {
                // Storage may be unavailable; the toggle still works for this view.
            }
        });
        const exploreSummary = document.createElement('summary');
        exploreSummary.className = 'gsr-explore-section__summary';
        const exploreTitle = document.createElement('span');
        exploreTitle.className = 'gsr-explore-section__title';
        exploreTitle.textContent = 'Timelines';
        const exploreMeta = document.createElement('span');
        exploreMeta.className = 'gsr-explore-section__meta';
        exploreMeta.textContent = `A*/A and Q1 per year, ${timelineYear - 7}-${timelineYear}`;
        const exploreChevron = document.createElement('span');
        exploreChevron.className = 'gsr-explore-section__chevron';
        exploreChevron.setAttribute('aria-hidden', 'true');
        exploreChevron.textContent = '▸';
        exploreSummary.appendChild(exploreChevron);
        exploreSummary.appendChild(exploreTitle);
        exploreSummary.appendChild(exploreMeta);
        exploreSection.appendChild(exploreSummary);
        exploreSection.appendChild(createTimelineHistogramSection(recentFocusedHistograms.topCoreHistogram || [], {
            titleText: 'Top CORE Timeline',
            subtitleText: `A*/A papers, recent 8 years (${timelineYear - 7}-${timelineYear})`,
            rankOrder: getTopCoreHistogramRankOrder(),
            variant: 'top-core'
        }));
        exploreSection.appendChild(createTimelineHistogramSection(recentFocusedHistograms.q1Histogram || [], {
            titleText: 'Q1 Journal Timeline',
            subtitleText: `Q1 papers, recent 8 years (${timelineYear - 7}-${timelineYear})`,
            rankOrder: getQ1HistogramRankOrder(),
            variant: 'q1'
        }));
        panel.appendChild(exploreSection);
    }
    const authorshipControls = document.createElement('div');
    authorshipControls.className = 'gsr-authorship-controls';
    authorshipControls.appendChild(createAuthorshipSettingsControl());
    authorshipControls.appendChild(authorshipSummarySection);
    panel.appendChild(authorshipControls);
    const finalFooterDiv = document.createElement('div');
    finalFooterDiv.className = 'gsr-card__footer gsr-summary-footer';
    const footerMeta = document.createElement('div');
    footerMeta.className = 'gsr-summary-footer__meta';
    if (cacheTimestamp) {
        const timestampTextElement = document.createElement('span');
        timestampTextElement.className = 'gsr-summary-footer__stamp';
        const lastRankingTime = new Date(cacheTimestamp);
        const formattedDate = lastRankingTime.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const formattedTime = lastRankingTime.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        timestampTextElement.textContent = `Updated ${formattedDate} ${formattedTime}`;
        footerMeta.appendChild(timestampTextElement);
    }
    if (footerMeta.childNodes.length > 0) {
        finalFooterDiv.appendChild(footerMeta);
    }
    const footerActions = document.createElement('div');
    footerActions.className = 'gsr-summary-footer__actions';
    const createFooterAction = ({ label, badgeText, title, href = null, variant = 'neutral', onClick = null }) => {
        const element = href ? document.createElement('a') : document.createElement('button');
        if (href) {
            element.href = href;
            element.target = '_blank';
            element.rel = 'noopener noreferrer';
        }
        else {
            element.type = 'button';
        }
        element.className = `gsr-summary-footer__action gsr-summary-footer__action--${variant}`;
        element.setAttribute('title', title);
        if (typeof onClick === 'function') {
            element.addEventListener('click', onClick);
        }
        const icon = document.createElement('span');
        icon.className = 'gsr-summary-footer__action-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = badgeText;
        const text = document.createElement('span');
        text.className = 'gsr-summary-footer__action-label';
        text.textContent = label;
        element.appendChild(icon);
        element.appendChild(text);
        return element;
    };
    footerActions.appendChild(createFooterAction({
        label: 'Report Issue',
        badgeText: '!',
        title: 'Open the issue report form in a new tab',
        variant: 'report',
        onClick: () => window.open(REPORT_FORM_URL, '_blank', 'noopener,noreferrer')
    }));
    footerActions.appendChild(createFooterAction({
        label: 'About',
        badgeText: 'i',
        title: 'About the extension, ranking sources, and editorial rules',
        variant: 'about',
        onClick: () => openAboutOverlay()
    }));
    if (footerActions.childNodes.length > 0) {
        finalFooterDiv.appendChild(footerActions);
    }
    panel.appendChild(finalFooterDiv);
    const gsBdy = document.getElementById('gs_bdy');
    const rightSidebarContainer = gsBdy?.querySelector('div.gsc_rsb');
    if (rightSidebarContainer) {
        const publicAccessElement = rightSidebarContainer.querySelector('#gsc_rsb_mnd');
        const coauthorsElement = rightSidebarContainer.querySelector('#gsc_rsb_co');
        const citedByElement = rightSidebarContainer.querySelector('#gsc_rsb_cit');
        if (publicAccessElement)
            rightSidebarContainer.insertBefore(panel, publicAccessElement);
        else if (coauthorsElement)
            rightSidebarContainer.insertBefore(panel, coauthorsElement);
        else if (citedByElement?.nextSibling)
            rightSidebarContainer.insertBefore(panel, citedByElement.nextSibling);
        else if (citedByElement)
            citedByElement.parentNode?.appendChild(panel);
        else
            rightSidebarContainer.prepend(panel);
    }
    else {
        const profileTableContainer = document.getElementById('gsc_a_c');
        if (profileTableContainer)
            profileTableContainer.before(panel);
        else
            document.body.prepend(panel);
    }
    scheduleScholarCitationYearChartAnnotation(currentSummaryState);
    displayFacultyScorePanel(currentSummaryState);
    if (initialCachedPubRanks && initialCachedPubRanks.length > 0) {
        activeCachedPublicationRanks = initialCachedPubRanks;
        rankMapForObserver = new Map();
        activeCachedPublicationRanks.forEach(pubRank => {
            if (pubRank.url && pubRank.rank) {
                rankMapForObserver.set(pubRank.url, {
                    paperTitle: pubRank.paperTitle ?? null,
                    publicationYear: pubRank.publicationYear ?? null,
                    authorCount: pubRank.authorCount ?? null,
                    authors: normalizeDblpAuthorsForPublication(pubRank.authors),
                    authorship: normalizePublicationAuthorship(pubRank.authorship, pubRank.authorCount ?? null),
                    rank: pubRank.rank,
                    system: pubRank.system,
                    reason: pubRank.reason ?? null,
                    matchConfidence: pubRank.matchConfidence ?? null,
                    matchedVenue: pubRank.matchedVenue ?? null,
                    venueMatchConfidence: pubRank.venueMatchConfidence ?? null,
                    dblpVenue: pubRank.dblpVenue ?? null,
                    sourceYear: pubRank.sourceYear ?? null,
                    sourceYearFallback: pubRank.sourceYearFallback === true,
                    decisionVersion: pubRank.decisionVersion ?? null,
                    decisionStatus: pubRank.decisionStatus ?? null,
                    confidence: pubRank.confidence ?? null,
                    matchedKey: pubRank.matchedKey ?? null,
                    matchedSourceId: pubRank.matchedSourceId ?? null,
                    dblpKey: pubRank.dblpKey ?? null,
                    decisionEvidence: pubRank.decisionEvidence ?? null,
                    topCandidates: pubRank.topCandidates ?? null,
                    url: pubRank.url,
                });
            }
        });
        restoreVisibleInlineBadgesFromCache(activeCachedPublicationRanks);
        setupPublicationTableObserver();
    }
    else {
        activeCachedPublicationRanks = null;
        rankMapForObserver = null;
        disconnectPublicationTableObserver();
    }
    if (!activeSummaryFilter && currentSettings.defaultHighlightMode !== 'none') {
        activeSummaryFilter = { type: 'preset', mode: currentSettings.defaultHighlightMode };
    }
    applyActiveSummaryFilter();
    scheduleCitationGraphRankChips(citationChipState);
    logE2eMilestoneOnce('visible ranks rendered');
}
// --- NEW: Function to display the specific DBLP rate limit error ---
// Issue 4: Friendly message when DBLP is down/unreachable
function setupPublicationTableObserver(retryCount = 0) {
    disconnectPublicationTableObserver(); // Ensure any old one is gone
    const MAX_RETRIES = 5; // Try up to 5 times
    const RETRY_DELAY = 250; // Wait 250ms between retries
    const tableContainer = document.getElementById('gsc_a_b');
    if (!tableContainer) {
        if (retryCount < MAX_RETRIES) {
            setTimeout(() => setupPublicationTableObserver(retryCount + 1), RETRY_DELAY);
        }
        else {
            console.error("GSR OBSERVER: Max retries reached for finding #gsc_a_b. Observer not set up. 'Show more' may not work.");
        }
        return;
    }
    if (!activeCachedPublicationRanks || !rankMapForObserver || rankMapForObserver.size === 0) {
        console.warn("GSR OBSERVER: Setup aborted, missing cached rank data or rank map is empty.");
        return;
    }
    let reapplyDebounceTimeout = null;
    publicationTableObserver = new MutationObserver((mutationsList, observerInstance) => {
        if (!document.body.contains(tableContainer) || publicationTableObserver !== observerInstance) {
            observerInstance.disconnect();
            if (publicationTableObserver === observerInstance) {
                publicationTableObserver = null;
            }
            return;
        }
        if (!activeCachedPublicationRanks || !rankMapForObserver || rankMapForObserver.size === 0) {
            console.warn("GSR OBSERVER: Observer callback aborted, cached rank data became unavailable or empty.");
            return;
        }
        let newPubRowsAdded = false;
        for (const mutation of mutationsList) {
            if (mutation.type === 'childList') {
                for (const node of Array.from(mutation.addedNodes)) {
                    if (node.nodeName === 'TR' && node.classList.contains('gsc_a_tr')) {
                        newPubRowsAdded = true;
                        break;
                    }
                }
            }
            if (newPubRowsAdded)
                break;
        }
        if (!newPubRowsAdded) {
            return;
        }
        const addedRows = [];
        for (const mutation of mutationsList) {
            if (mutation.type !== 'childList')
                continue;
            for (const node of Array.from(mutation.addedNodes)) {
                if (node.nodeName === 'TR' && node.classList.contains('gsc_a_tr')) {
                    addedRows.push(node);
                }
                else if (node instanceof HTMLElement) {
                    addedRows.push(...Array.from(node.querySelectorAll('tr.gsc_a_tr')));
                }
            }
        }
        if (reapplyDebounceTimeout) {
            clearTimeout(reapplyDebounceTimeout);
        }
        reapplyDebounceTimeout = window.setTimeout(() => {
            if (activeCachedPublicationRanks && rankMapForObserver && rankMapForObserver.size > 0) {
                restoreVisibleInlineBadgesFromCache(activeCachedPublicationRanks, addedRows);
            }
            else {
                console.warn("GSR OBSERVER: Debounced re-scan aborted at execution, cached rank data is unavailable or empty.");
            }
        }, 300);
    });
    try {
        publicationTableObserver.observe(tableContainer, { childList: true, subtree: true });
    }
    catch (e) {
        console.error("GSR ERROR: Failed to attach publication table container observer:", e);
    }
}
function disconnectPublicationTableObserver() {
    if (publicationTableObserver) {
        publicationTableObserver.disconnect();
        publicationTableObserver = null;
    }
}
function restoreVisibleInlineBadgesFromCache(cachedRanks, targetRows = null) {
    const allVisibleRows = targetRows && targetRows.length ? targetRows : document.querySelectorAll('tr.gsc_a_tr');
    const currentRankMap = rankMapForObserver;
    if (allVisibleRows.length === 0 || !cachedRanks || cachedRanks.length === 0 || !currentRankMap || currentRankMap.size === 0) {
        return;
    }
    let badgesAppliedCount = 0;
    allVisibleRows.forEach((row) => {
        const rowElement = row;
        const linkEl = rowElement.querySelector('td.gsc_a_t a.gsc_a_at');
        const titleCell = rowElement.querySelector('td.gsc_a_t');
        if (titleCell) {
            const oldBadge = titleCell.querySelector('span.gsr-rank-badge-inline');
            oldBadge?.remove();
        }
        if (linkEl instanceof HTMLAnchorElement && linkEl.href) {
            const currentDomUrl = linkEl.href;
            const normalizedCurrentUrl = normalizeUrlForCache(currentDomUrl);
            const cachedRank = currentRankMap.get(normalizedCurrentUrl);
            if (cachedRank) {
                displayRankBadgeAfterTitle(rowElement, cachedRank.rank, cachedRank.system, cachedRank.reason ?? null, cachedRank);
                badgesAppliedCount++;
            }
        }
    });
    if (badgesAppliedCount > 0 || activeSummaryFilter || previewSummaryFilter) {
        applyActiveSummaryFilter();
    }
}
// --- START: DBLP Integration Functions (REPLACED/UPDATED) ---
function getScholarAuthorName() {
    const nameElement = document.getElementById('gsc_prf_in');
    if (nameElement) {
        return nameElement.textContent?.trim() || null;
    }
    const h1NameElement = document.querySelector('#gs_hdr_name > a, #gs_hdr_name');
    if (h1NameElement) {
        return h1NameElement.textContent?.trim() || null;
    }
    return null;
}
function sanitizeAuthorName(name) {
    let cleaned = name.trim();
    const commaIndex = cleaned.indexOf(',');
    if (commaIndex !== -1) {
        cleaned = cleaned.substring(0, commaIndex);
    }
    const prefixPatterns = [
        /^professor\s*/i,
        /^prof\.?\s*/i,
        /^dr\.?\s*/i
    ];
    for (const p of prefixPatterns) {
        cleaned = cleaned.replace(p, "");
    }
    cleaned = cleaned.replace(/\./g, "");
    cleaned = cleaned.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ");
    return cleaned.trim();
}
// --- NEW FAST DBLP IDENTIFICATION LOGIC ---
// in content.ts
function createPublicationRankInfo(result) {
    return {
        paperTitle: result.paperTitle ?? result.titleText,
        publicationYear: result.publicationYear ?? null,
        authorCount: result.authorCount ?? null,
        authors: normalizeDblpAuthorsForPublication(result.authors),
        authorship: normalizePublicationAuthorship(result.authorship, result.authorCount ?? null),
        titleText: result.titleText,
        rank: result.rank,
        system: result.system,
        reason: result.reason,
        url: result.url,
        matchConfidence: result.matchConfidence ?? null,
        matchedVenue: result.matchedVenue ?? null,
        venueMatchConfidence: result.venueMatchConfidence ?? null,
        dblpVenue: result.dblpVenue ?? null,
        sourceYear: result.sourceYear ?? null,
        sourceYearFallback: result.sourceYearFallback === true,
        decisionVersion: result.decisionVersion ?? DECISION_VERSION,
        decisionStatus: result.decisionStatus ?? null,
        confidence: result.confidence ?? null,
        matchedKey: result.matchedKey ?? null,
        matchedSourceId: result.matchedSourceId ?? null,
        dblpKey: result.dblpKey ?? null,
        decisionEvidence: result.decisionEvidence ?? null,
        topCandidates: result.topCandidates ?? null
    };
}
async function ensureDblpVenueDataset() {
    return (await loadRankingsData()).venueDataset;
}
function selectDblpVenueCandidateIndexes(queryTokens, dataset) {
    if (!queryTokens.length || !dataset?.tokenIndex)
        return null;
    const ranked = queryTokens
        .map(token => ({ token, count: dataset.tokenIndex.tokenFrequency.get(token) || Number.POSITIVE_INFINITY }))
        .filter(entry => Number.isFinite(entry.count))
        .sort((a, b) => a.count - b.count || a.token.localeCompare(b.token));
    if (!ranked.length)
        return null;
    let candidateSet = null;
    for (const entry of ranked.slice(0, 3)) {
        const indexes = dataset.tokenIndex.tokenToIndexes.get(entry.token);
        if (!indexes?.size)
            continue;
        candidateSet = candidateSet ? new Set([...candidateSet].filter(index => indexes.has(index))) : new Set(indexes);
        if (candidateSet.size > 0 && candidateSet.size <= 64) {
            break;
        }
    }
    if (candidateSet?.size)
        return candidateSet;
    return dataset.tokenIndex.tokenToIndexes.get(ranked[0].token) || null;
}
function getDblpVenueTypePreference(venueName, trackInfo) {
    if (trackInfo?.isWorkshop)
        return 'workshop';
    const text = String(venueName || '').toLowerCase();
    if (/\b(workshops?|companion|adjunct)\b|@/.test(text))
        return 'workshop';
    if (/\b(journal|transactions|letters)\b/.test(text))
        return 'journal';
    if (/^\s*proceedings\s+of\s+the\s+acm\s+on\b/.test(text) && !/\bconference\b/.test(text))
        return 'journal';
    if (/\b(conference|symposium|workshop|proceedings)\b/.test(text))
        return 'conference';
    return null;
}
function chooseDblpVenueEntry(matches, typePreference) {
    const entries = Array.isArray(matches) ? matches.filter(Boolean) : [];
    if (!entries.length)
        return { status: DECISION_STATUS.MISSING };
    const preferred = typePreference ? entries.filter(entry => entry.type === typePreference) : entries;
    if (typePreference && preferred.length === 0)
        return { status: DECISION_STATUS.MISSING };
    const pool = typePreference ? preferred : entries;
    const ranked = pool.slice().sort((left, right) => {
        const leftCount = Number(left.count || 0);
        const rightCount = Number(right.count || 0);
        return rightCount - leftCount || left.id.localeCompare(right.id);
    });
    if (ranked.length === 1)
        return { status: DECISION_STATUS.MATCHED, entry: ranked[0] };
    if (ranked.length > 1) {
        const firstKey = `${ranked[0].type}:${normalizeDblpVenueAlias(ranked[0].title)}`;
        if (ranked.every(entry => `${entry.type}:${normalizeDblpVenueAlias(entry.title)}` === firstKey)) {
            return { status: DECISION_STATUS.MATCHED, entry: ranked[0] };
        }
    }
    if ((ranked[0].count || 0) >= Math.max(4, (ranked[1].count || 0) * 3)) {
        return { status: DECISION_STATUS.MATCHED, entry: ranked[0] };
    }
    return {
        status: DECISION_STATUS.MATCHED,
        entry: ranked[0],
        topCandidates: ranked.slice(0, 5).map(entry => ({
            matchedVenue: entry.title,
            matchedKey: entry.id,
            confidence: null,
            status: entry.type
        }))
    };
}
function buildDblpVenueQueryVariants(venueName, trackInfo) {
    const variants = [];
    const push = (value, source = 'variant') => {
        const trimmed = String(value || '').trim();
        if (!trimmed)
            return;
        const normalized = normalizeDblpVenueAlias(trimmed);
        if (!normalized)
            return;
        if (!variants.some(entry => entry.normalized === normalized)) {
            variants.push({ raw: trimmed, normalized, source });
        }
    };
    const pushGenericVariants = (value) => {
        const normalized = normalizeDblpVenueAlias(value);
        if (!normalized)
            return;
        const tokenCount = (text) => String(text || '').split(/\s+/).filter(Boolean).length;
        const pushConnectorCollapsed = (text) => {
            const collapsed = String(text || '')
                .split(/\s+/)
                .filter(token => token && !['and', 'of', 'on', 'the'].includes(token))
                .join(' ')
                .trim();
            if (collapsed && collapsed !== text && tokenCount(collapsed) >= 3) {
                push(collapsed);
            }
        };
        const pushComputingVariants = (text) => {
            const normalizedText = String(text || '');
            const variants = [
                normalizedText.replace(/\bcomputing\b/g, 'computer'),
                normalizedText.replace(/\bcomputer\b/g, 'computing'),
                normalizedText.replace(/\bcomputers\b/g, 'computer')
            ];
            for (const variant of variants) {
                if (variant && variant !== normalizedText && tokenCount(variant) >= 3) {
                    push(variant);
                    pushConnectorCollapsed(variant);
                }
            }
        };
        pushConnectorCollapsed(normalized);
        pushComputingVariants(normalized);
        const withoutLeadingAnnual = normalized
            .replace(/^annual\s+(?=\S)/, '')
            .trim();
        if (withoutLeadingAnnual && withoutLeadingAnnual !== normalized && tokenCount(withoutLeadingAnnual) >= 3) {
            push(withoutLeadingAnnual);
            pushConnectorCollapsed(withoutLeadingAnnual);
            pushComputingVariants(withoutLeadingAnnual);
        }
        const withoutPublisherChain = normalized
            .replace(/^(?:(?:acm|ieee|aaai|usenix|ifip|springer|elsevier|wiley)\s+)+(?!$)/, '')
            .trim();
        if (withoutPublisherChain && withoutPublisherChain !== normalized && tokenCount(withoutPublisherChain) >= 2) {
            push(withoutPublisherChain);
            pushConnectorCollapsed(withoutPublisherChain);
            pushComputingVariants(withoutPublisherChain);
        }
        const withoutPublisherPrefix = normalized
            .replace(/^(acm|ieee|aaai|usenix|ifip|sig[a-z0-9]+)\s+(?=\S)/, '')
            .replace(/^(international|annual|european|asian|asia pacific)\s+(acm|ieee|aaai|usenix|ifip|sig[a-z0-9]+)\s+(?=\S)/, '$1 ')
            .trim();
        if (withoutPublisherPrefix && withoutPublisherPrefix !== normalized && tokenCount(withoutPublisherPrefix) >= 2) {
            push(withoutPublisherPrefix);
            pushConnectorCollapsed(withoutPublisherPrefix);
            pushComputingVariants(withoutPublisherPrefix);
        }
        const patterns = [
            /^(international|annual|ieee|acm|aaai|usenix|ifip|european|asian|asia pacific)\s+(conference|symposium|workshop|journal)\s+(on|of|for)\s+/,
            /^(ieee|acm|aaai|usenix|ifip)\s+(on|of|for)\s+/,
            /^(conference|symposium|workshop|journal)\s+(on|of|for)\s+/,
            /^(international|annual)\s+/
        ];
        for (const pattern of patterns) {
            const stripped = normalized.replace(pattern, '').trim();
            if (stripped && stripped !== normalized) {
                if (tokenCount(stripped) >= 3) {
                    push(stripped);
                    pushConnectorCollapsed(stripped);
                    pushComputingVariants(stripped);
                }
                const withoutDataSecurity = stripped.replace(/\s+and\s+data\s+security$/i, '').trim();
                if (withoutDataSecurity && withoutDataSecurity !== stripped) {
                    push(withoutDataSecurity);
                }
            }
        }
    };
    push(venueName);
    pushGenericVariants(venueName);
    const withoutParentheticalAcronyms = String(venueName || '')
        .replace(/\s*\(([A-Za-z][A-Za-z0-9'’+\-]{1,12})\)\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (withoutParentheticalAcronyms && withoutParentheticalAcronyms !== String(venueName || '').trim()) {
        push(withoutParentheticalAcronyms);
        pushGenericVariants(withoutParentheticalAcronyms);
    }
    const noProc = String(venueName || '').replace(/^\s*(proceedings of the|proceedings of|proc\.?\s+of the|proc\.?\s+of|proceedings|proc\.?)\s+/i, '').trim();
    push(noProc);
    pushGenericVariants(noProc);
    push(trackInfo?.resolvedVenue);
    if (trackInfo?.isWorkshop) {
        push(trackInfo?.seriesId);
    }
    const canon = RANKING_UTILS?.canonicalizeCsrankingsVenueName ? RANKING_UTILS.canonicalizeCsrankingsVenueName(venueName) : null;
    push(canon);
    for (const acronym of extractPotentialAcronymsFromText(String(venueName || ''))) {
        push(acronym, 'acronym');
    }
    return variants;
}
function shouldSkipExactDblpVariant(variant, venueName, typePreference) {
    if (variant?.source !== 'acronym' || typePreference !== 'journal')
        return false;
    const normalizedVenue = normalizeDblpVenueAlias(venueName);
    const venueTokenCount = normalizedVenue.split(/\s+/).filter(Boolean).length;
    const variantTokenCount = String(variant.normalized || '').split(/\s+/).filter(Boolean).length;
    return venueTokenCount >= 4 && variantTokenCount === 1;
}
async function resolveDblpVenueCatalogMatch(venueName, trackInfo) {
    const dataset = await ensureDblpVenueDataset();
    if (!dataset?.available)
        return { catalogAvailable: false, status: DECISION_STATUS.MISSING };
    const typePreference = getDblpVenueTypePreference(venueName, trackInfo);
    const variants = buildDblpVenueQueryVariants(venueName, trackInfo);
    const isTruncatedQuery = /\s*(?:\.\.\.|…)\s*$/u.test(String(venueName || ''));
    for (const variant of variants) {
        if (shouldSkipExactDblpVariant(variant, venueName, typePreference))
            continue;
        const matches = dataset.byNormalized.get(variant.normalized);
        if (!matches?.length)
            continue;
        const chosen = chooseDblpVenueEntry(matches, typePreference);
        if (chosen.status === DECISION_STATUS.MATCHED) {
            return {
                catalogAvailable: true,
                status: DECISION_STATUS.MATCHED,
                entry: chosen.entry,
                score: 1.0,
                matchedBy: 'alias_exact',
                query: variant.normalized,
                topCandidates: chosen.topCandidates ?? null
            };
        }
    }
    const tokenCount = (value) => String(value || '').split(/\s+/).filter(Boolean).length;
    let fuzzyVariantPool = (variants.length ? variants : [{ normalized: normalizeDblpVenueAlias(venueName), source: 'variant' }])
        .filter(variant => !shouldSkipExactDblpVariant(variant, venueName, typePreference));
    if (isTruncatedQuery && fuzzyVariantPool.length) {
        fuzzyVariantPool = fuzzyVariantPool.filter(variant => {
            const normalized = String(variant.normalized || '');
            if (!/^(?:international\s+|acm\s+|ieee\s+|ifip\s+|usenix\s+)*(?:conference|symposium|workshop)\b/.test(normalized))
                return true;
            return !fuzzyVariantPool.some(other => {
                const otherNormalized = String(other.normalized || '');
                return tokenCount(otherNormalized) > tokenCount(normalized)
                    && otherNormalized.endsWith(` ${normalized}`);
            });
        });
    }
    const fuzzyQueries = Array.from(new Set((fuzzyVariantPool.length ? fuzzyVariantPool : [{ normalized: normalizeDblpVenueAlias(venueName) }])
        .map(variant => variant.normalized)
        .filter(Boolean)));
    await ensureDblpVenueTokenIndex(dataset);
    const candidateIndexes = new Set();
    for (const fuzzyQuery of fuzzyQueries) {
        const queryTokens = Array.from(createVenueTokenSet(fuzzyQuery));
        const indexes = selectDblpVenueCandidateIndexes(queryTokens, dataset) || new Set();
        for (const index of indexes) {
            candidateIndexes.add(index);
        }
    }
    let best = null;
    let second = null;
    for (const index of candidateIndexes) {
        const entry = dataset.entries[index];
        if (!entry)
            continue;
        if (typePreference && entry.type !== typePreference)
            continue;
        for (const alias of entry.normalizedAliases || []) {
            for (const query of fuzzyQueries) {
                const queryTokenCount = tokenCount(query);
                const prefixScore = isTruncatedQuery
                    && queryTokenCount >= 5
                    && alias.startsWith(query)
                    ? Math.min(0.995, 0.975 + (queryTokenCount * 0.002))
                    : null;
                const score = prefixScore ?? computeDblpVenueFuzzySimilarity(query, alias);
                if (score < RANKING_CONFIG.coreFuzzyThreshold)
                    continue;
                const candidate = { entry, alias, score, query };
                if (!best || score > best.score) {
                    second = best;
                    best = candidate;
                }
                else if ((!second || score > second.score) && candidate.entry.id !== best.entry.id) {
                    second = candidate;
                }
            }
        }
    }
    if (!best) {
        return { catalogAvailable: true, status: DECISION_STATUS.MISSING };
    }
    return {
        catalogAvailable: true,
        status: DECISION_STATUS.MATCHED,
        entry: best.entry,
        score: best.score,
        matchedBy: 'alias_fuzzy',
        query: best.query,
        topCandidates: second ? [best, second].map(candidate => ({
            matchedVenue: candidate.entry.title,
            matchedKey: candidate.entry.id,
            confidence: candidate.score,
            status: candidate.entry.type
        })) : null
    };
}
function getRankCandidateNamesFromDblpVenue(match, fallbackVenueName) {
    const entry = match?.entry || null;
    const out = [];
    const push = (value) => {
        const trimmed = String(value || '').trim();
        if (trimmed && !out.some(existing => existing.toLowerCase() === trimmed.toLowerCase())) {
            out.push(trimmed);
        }
    };
    push(entry?.title);
    push(entry?.shortName);
    for (const compactVariant of createAcronymVariantsFromCompactDblpAlias(entry?.shortName)) {
        push(compactVariant);
    }
    for (const alias of entry?.aliases || []) {
        push(alias);
        for (const compactVariant of createAcronymVariantsFromCompactDblpAlias(alias)) {
            push(compactVariant);
        }
    }
    push(fallbackVenueName);
    return out.slice(0, 12);
}
function hasExplicitConferenceCue(value) {
    return /\b(conference|symposium|workshops?|proceedings|proc\.?|poster|demo|doctoral|extended\s+abstracts?)\b/i.test(String(value || ''));
}
function isBareJournalCandidateVenue(value) {
    const text = String(value || '').trim();
    if (!text || hasExplicitConferenceCue(text))
        return false;
    const normalized = normalizeDblpVenueAlias(text);
    const tokens = normalized.split(/\s+/).filter(Boolean);
    if (tokens.length < 2)
        return false;
    if (/^[A-Z0-9&.\-]{2,12}$/.test(text) && !/\s/.test(text))
        return false;
    return true;
}
function createUnrankedDblpVenueDecision(match, reason = 'Unranked') {
    const entry = match?.entry || null;
    return {
        system: entry?.type === 'journal' ? 'SJR' : 'CORE',
        rank: 'N/A',
        matchedVenue: entry?.title ?? null,
        venueMatchConfidence: typeof match?.score === 'number' ? match.score : null,
        sourceYear: null,
        naReason: reason,
        decisionStatus: DECISION_STATUS.UNRANKED,
        decisionEvidence: reason === 'Workshop'
            ? ['dblp_venue_match', 'workshop']
            : ['dblp_venue_match', 'venue_unranked'],
        matchedKey: entry?.id ?? null,
        matchedSourceId: entry?.id ?? null,
        sourceYearFallback: false,
        topCandidates: null
    };
}
function selectPrecomputedSjrQuartile(qstr, publicationYear, startYear = SJR_DATASET_START_YEAR) {
    const text = String(qstr || '');
    if (!text)
        return null;
    const readAt = (index) => {
        const c = text[index];
        return /^[1-4]$/.test(c) ? `Q${c}` : null;
    };
    if (publicationYear) {
        const exactIndex = publicationYear - startYear;
        if (exactIndex >= 0 && exactIndex < text.length) {
            const exact = readAt(exactIndex);
            if (exact)
                return { rank: exact, year: publicationYear, sourceYearFallback: false };
        }
        for (let index = Math.min(text.length - 1, exactIndex - 1); index >= 0; index--) {
            const fallback = readAt(index);
            if (fallback)
                return { rank: fallback, year: startYear + index, sourceYearFallback: true };
        }
    }
    for (let index = text.length - 1; index >= 0; index--) {
        const latest = readAt(index);
        if (latest)
            return { rank: latest, year: startYear + index, sourceYearFallback: true };
    }
    return null;
}
function selectPrecomputedCoreRank(rows, publicationYear) {
    const entries = (Array.isArray(rows) ? rows : [])
        .filter(row => Array.isArray(row) && Number.isFinite(Number(row[0])) && VALID_RANKS.includes(String(row[1] || '').toUpperCase()))
        .map(([year, rank, title, acronym]) => ({ year: Number(year), rank: String(rank).toUpperCase(), title: title || '', acronym: acronym || '' }))
        .sort((left, right) => right.year - left.year);
    if (!entries.length)
        return null;
    const targetFile = getCoreDataFileForYear(publicationYear ?? null);
    const targetYear = getCoreDatasetYear(targetFile);
    const exact = entries.find(entry => entry.year === targetYear);
    if (exact)
        return { ...exact, sourceYearFallback: false };
    const prior = entries.find(entry => entry.year < targetYear);
    if (prior)
        return { ...prior, sourceYearFallback: true };
    return { ...entries[0], sourceYearFallback: true };
}
function resolvePrecomputedDblpVenueRank(match, publicationYear) {
    const entry = match?.entry;
    const rankInfo = entry?.rankInfo;
    if (!Array.isArray(rankInfo) || !rankInfo.length)
        return null;
    if (rankInfo[0] === 'SJR') {
        const [, matchedTitle, matchedKey, qstr] = rankInfo;
        const selection = selectPrecomputedSjrQuartile(qstr, publicationYear ?? null);
        if (!selection)
            return null;
        return {
            system: 'SJR',
            rank: selection.rank,
            matchedVenue: matchedTitle || entry.title,
            venueMatchConfidence: match.score ?? 1,
            sourceYear: selection.year,
            naReason: null,
            decisionStatus: DECISION_STATUS.MATCHED,
            decisionEvidence: ['dblp_venue_match', 'precomputed_rank'],
            matchedKey: matchedKey || matchedTitle || entry.id,
            matchedSourceId: entry.id,
            sourceYearFallback: selection.sourceYearFallback === true,
            shouldPersist: true,
            topCandidates: null
        };
    }
    if (rankInfo[0] === 'CORE') {
        const selection = selectPrecomputedCoreRank(rankInfo[1], publicationYear ?? null);
        if (!selection)
            return null;
        return {
            system: 'CORE',
            rank: selection.rank,
            matchedVenue: selection.title || entry.title,
            venueMatchConfidence: match.score ?? 1,
            sourceYear: selection.year,
            naReason: null,
            decisionStatus: DECISION_STATUS.MATCHED,
            decisionEvidence: ['dblp_venue_match', 'precomputed_rank'],
            matchedKey: selection.acronym || selection.title || entry.id,
            matchedSourceId: entry.id,
            sourceYearFallback: selection.sourceYearFallback === true,
            shouldPersist: true,
            topCandidates: null
        };
    }
    return null;
}
async function resolveCoreRanking(venueName, publicationYear, trackInfo) {
    const utils = RANKING_UTILS;
    const coreDataFile = getCoreDataFileForYear(publicationYear ?? null);
    const sourceYear = getCoreDatasetYear(coreDataFile);
    const coreData = await loadCoreDataForFile(coreDataFile);
    const result = { system: 'CORE', rank: 'N/A', matchedVenue: null, venueMatchConfidence: null, sourceYear, naReason: null, decisionStatus: null, decisionEvidence: null, matchedKey: null, topCandidates: null };
    if (!coreData || coreData.length === 0) {
        return result;
    }
    const candidates = [];
    const pushCandidate = (candidate) => {
        const trimmed = String(candidate || '').trim();
        if (!trimmed) return;
        const lower = trimmed.toLowerCase();
        if (!candidates.some((existing) => existing.toLowerCase() === lower)) {
            candidates.push(trimmed);
        }
    };
    const expandVenue = (candidate, opts) => {
        if (!candidate) return;
        const variants = utils?.expandVenueCandidates ? utils.expandVenueCandidates(candidate, opts) : [candidate];
        for (const variant of variants) {
            pushCandidate(variant);
            const canon = utils?.canonicalizeCsrankingsVenueName ? utils.canonicalizeCsrankingsVenueName(variant) : null;
            if (canon) pushCandidate(canon);
        }
    };
    // Scholar venue strings are verbose ("Proceedings of the AAAI conference
    // on artificial intelligence"); also try the name without the proceedings
    // prefix and any acronyms embedded in the string ("AAAI", "ICCV"), which
    // CORE indexes directly.
    const noProc = venueName.replace(/^\s*(proceedings of the|proceedings of|proc\.?\s+of the|proc\.?\s+of|proceedings|proc\.?)\s+/i, '').trim();
    if (trackInfo?.isWorkshop && !INHERIT_PARENT_CONFERENCE_RANK_FOR_WORKSHOPS) {
        if (trackInfo.resolvedVenue) expandVenue(trackInfo.resolvedVenue, { includeAtParent: false });
        if (trackInfo.seriesId) expandVenue(trackInfo.seriesId, { includeAtParent: false });
        expandVenue(venueName, { includeAtParent: false });
        if (noProc && noProc !== venueName) expandVenue(noProc, { includeAtParent: false });
    }
    else {
        expandVenue(venueName);
        if (noProc && noProc !== venueName) expandVenue(noProc);
    }
    // Acronyms are tried last so exact title matches win over acronym collisions.
    for (const acronym of extractPotentialAcronymsFromText(venueName)) {
        pushCandidate(acronym);
    }
    let resolvedRank = null;
    let resolvedDetails = null;
    for (const candidate of candidates) {
        const details = {};
        const attempt = findRankForVenue(candidate, coreData, venueName, details);
        if (VALID_RANKS.includes(attempt)) {
            resolvedRank = attempt;
            resolvedDetails = details;
            break;
        }
        if (resolvedRank === null && attempt !== 'N/A') {
            resolvedRank = attempt;
            resolvedDetails = details;
        }
        else if (resolvedDetails === null && details.matchedVenue) {
            resolvedDetails = details;
        }
    }
    result.rank = resolvedRank ?? 'N/A';
    if (resolvedDetails) {
        result.matchedVenue = resolvedDetails.matchedVenue ?? null;
        result.venueMatchConfidence = resolvedDetails.venueMatchConfidence ?? null;
        result.matchedKey = resolvedDetails.matchedKey ?? resolvedDetails.matchedVenue ?? null;
        result.decisionStatus = resolvedDetails.decisionStatus ?? null;
        result.decisionEvidence = resolvedDetails.decisionEvidence ?? null;
        result.topCandidates = Array.isArray(resolvedDetails.topCandidates) ? resolvedDetails.topCandidates : null;
    }
    if (result.rank === 'N/A') {
        if (trackInfo?.isWorkshop) result.naReason = 'Workshop';
        else if (resolvedDetails?.decisionStatus === DECISION_STATUS.AMBIGUOUS) result.naReason = 'Ambiguous';
    }
    return result;
}
async function resolveSjrRanking(venueName, publicationYear) {
    const utils = RANKING_UTILS;
    const names = [];
    const pushName = (name) => {
        const trimmed = String(name || '').trim();
        if (trimmed && !names.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
            names.push(trimmed);
        }
    };
    pushName(venueName);
    pushName(utils?.canonicalizeCsrankingsVenueName ? utils.canonicalizeCsrankingsVenueName(venueName) : null);
    const result = { system: 'SJR', rank: 'N/A', matchedVenue: null, venueMatchConfidence: null, sourceYear: null, naReason: null, decisionStatus: null, decisionEvidence: null, matchedKey: null, matchedSourceId: null, sourceYearFallback: false, shouldPersist: true, topCandidates: null };
    let bestSjr = null;
    let sawAmbiguous = false;
    let sawHistorical = false;
    let transientFailure = false;
    for (const name of names) {
        const sjrResult = await resolveSjrQuartile(name, publicationYear ?? null, {});
        if (sjrResult.status === 'success' && sjrResult.quartile && SJR_QUARTILES.includes(sjrResult.quartile)) {
            const score = typeof sjrResult.matchScore === 'number' ? sjrResult.matchScore : 1.0;
            if (!bestSjr || score > bestSjr.score) {
                bestSjr = { ...sjrResult, score };
            }
            transientFailure = false;
            continue;
        }
        if (sjrResult.status === 'ambiguous') sawAmbiguous = true;
        if (sjrResult.status === 'historical_coverage_unavailable') sawHistorical = true;
        if (sjrResult.status === 'error' && sjrResult.transient) transientFailure = true;
    }
    if (bestSjr) {
        result.rank = bestSjr.quartile;
        result.matchedVenue = bestSjr.resolvedTitle ?? null;
        result.venueMatchConfidence = typeof bestSjr.matchScore === 'number' ? bestSjr.matchScore : null;
        result.sourceYear = bestSjr.year ?? null;
        result.matchedKey = bestSjr.matchedNormalizedTitle ?? bestSjr.resolvedTitle ?? null;
        result.matchedSourceId = bestSjr.matchedSourceId ?? null;
        result.sourceYearFallback = bestSjr.sourceYearFallback === true;
        result.decisionStatus = DECISION_STATUS.MATCHED;
        result.decisionEvidence = bestSjr.matchedSourceId ? [`source:${bestSjr.matchedSourceId}`] : null;
    }
    else if (sawAmbiguous) {
        result.naReason = 'Ambiguous Journal Match';
        result.decisionStatus = DECISION_STATUS.AMBIGUOUS;
        result.matchedKey = venueName ?? null;
        result.decisionEvidence = ['sjr_ambiguous'];
    }
    else if (sawHistorical) {
        result.naReason = 'SJR Historical Coverage Unavailable';
        result.decisionStatus = DECISION_STATUS.UNRANKED;
        result.matchedKey = venueName ?? null;
        result.decisionEvidence = ['sjr_historical_coverage_unavailable'];
    }
    if (result.rank === 'N/A' && transientFailure) {
        result.shouldPersist = false;
    }
    return result;
}
function createVenueTrackInfoForRanking(venueName, titleText) {
    const utils = RANKING_UTILS;
    return utils?.classifyVenueTrack
        ? utils.classifyVenueTrack({
            title: titleText || '',
            venue: venueName,
            venue_full: venueName,
            acronym: null,
            dblpKey: null,
            dblpType: null,
            crossref: null,
            scholarVenue: venueName,
            pageCount: null
        })
        : { isWorkshop: false, isDemoPoster: false, isShortPaper: false, isExtendedAbstract: false, reason: null, resolvedVenue: null, parentVenue: null, seriesId: null, signals: [] };
}
// Match a Scholar-scraped venue string against CORE (conferences) and SJR
// (journals), returning whichever system yields the more confident ranking.
// Replaces the former DBLP-type-based journal-vs-conference routing.
async function pickVenueRanking(venueName, titleText, publicationYear) {
    const trackInfo = createVenueTrackInfoForRanking(venueName, titleText);
    const cacheKey = [
        normalizeDblpVenueAlias(venueName),
        Number.isFinite(publicationYear) ? publicationYear : '',
        trackInfo.isWorkshop ? 'workshop' : '',
        trackInfo.isDemoPoster ? 'demo' : '',
        trackInfo.isExtendedAbstract ? 'extended' : '',
        trackInfo.reason || ''
    ].join('|');
    const cachedDecision = venueRankingDecisionCache.get(cacheKey);
    if (cachedDecision) {
        return { ...cachedDecision, decisionEvidence: Array.isArray(cachedDecision.decisionEvidence) ? cachedDecision.decisionEvidence.slice() : cachedDecision.decisionEvidence, topCandidates: Array.isArray(cachedDecision.topCandidates) ? cachedDecision.topCandidates.slice() : cachedDecision.topCandidates };
    }
    const remember = (decision) => {
        if (!decision)
            return decision;
        if (venueRankingDecisionCache.size >= VENUE_RANKING_DECISION_CACHE_LIMIT) {
            venueRankingDecisionCache.clear();
        }
        venueRankingDecisionCache.set(cacheKey, { ...decision, decisionEvidence: Array.isArray(decision.decisionEvidence) ? decision.decisionEvidence.slice() : decision.decisionEvidence, topCandidates: Array.isArray(decision.topCandidates) ? decision.topCandidates.slice() : decision.topCandidates });
        return decision;
    };
    const excluded = (status, reason, evidence) => ({ system: 'CORE', rank: 'N/A', matchedVenue: null, venueMatchConfidence: null, sourceYear: null, naReason: reason, decisionStatus: status, decisionEvidence: evidence, matchedKey: null, topCandidates: null });
    if (trackInfo.isExtendedAbstract || trackInfo.reason === 'Extended Abstract') {
        return remember(excluded(DECISION_STATUS.UNRANKED, 'Extended Abstract', trackInfo.signals ?? ['extended_abstract']));
    }
    if (trackInfo.reason === 'Editorship') {
        return remember(excluded(DECISION_STATUS.UNRANKED, 'Editorship', trackInfo.signals ?? ['editorship']));
    }
    if (trackInfo.isDemoPoster) {
        return remember(excluded(DECISION_STATUS.UNRANKED, trackInfo.reason || 'Demo/Poster', trackInfo.signals ?? ['demo_poster']));
    }
    if (isArxivLikeVenue({ venue: venueName, venue_full: venueName })) {
        return remember(excluded(DECISION_STATUS.UNRANKED, 'Preprint', ['arxiv_like']));
    }
    if (isPatentLikeVenue(venueName)) {
        return remember(excluded(DECISION_STATUS.UNRANKED, 'Patent', ['patent_like']));
    }
    const dblpVenueMatch = await resolveDblpVenueCatalogMatch(venueName, trackInfo);
    if (dblpVenueMatch.catalogAvailable) {
        if (dblpVenueMatch.status === DECISION_STATUS.AMBIGUOUS) {
            return remember({
                system: 'CORE',
                rank: 'N/A',
                matchedVenue: null,
                venueMatchConfidence: dblpVenueMatch.score ?? null,
                sourceYear: null,
                naReason: 'Ambiguous',
                decisionStatus: DECISION_STATUS.AMBIGUOUS,
                decisionEvidence: ['dblp_venue_ambiguous'],
                matchedKey: null,
                matchedSourceId: null,
                topCandidates: dblpVenueMatch.topCandidates ?? null
            });
        }
        if (dblpVenueMatch.status === DECISION_STATUS.MISSING || !dblpVenueMatch.entry) {
            const core = await resolveCoreRanking(venueName, publicationYear, trackInfo);
            const sjr = await resolveSjrRanking(venueName, publicationYear);
            const coreHit = VALID_RANKS.includes(core.rank);
            const sjrHit = SJR_QUARTILES.includes(sjr.rank);
            if (coreHit || sjrHit) {
                const ranked = coreHit && sjrHit
                    ? ((core.venueMatchConfidence ?? 0) >= (sjr.venueMatchConfidence ?? 0) ? core : sjr)
                    : (coreHit ? core : sjr);
                return remember({
                    ...ranked,
                    decisionEvidence: Array.from(new Set([...(ranked.decisionEvidence || []), 'dblp_venue_missing'])),
                    decisionStatus: DECISION_STATUS.MATCHED
                });
            }
            return remember({
                system: 'CORE',
                rank: 'N/A',
                matchedVenue: null,
                venueMatchConfidence: null,
                sourceYear: null,
                naReason: 'N/A',
                decisionStatus: DECISION_STATUS.MISSING,
                decisionEvidence: ['dblp_venue_missing'],
                matchedKey: null,
                matchedSourceId: null,
                topCandidates: null
            });
        }
        if (dblpVenueMatch.entry.type === 'workshop' || trackInfo.isWorkshop) {
            return remember(createUnrankedDblpVenueDecision(dblpVenueMatch, 'Workshop'));
        }
        if (dblpVenueMatch.entry.type === 'conference' && isBareJournalCandidateVenue(venueName)) {
            const sjrBare = await resolveSjrRanking(venueName, publicationYear);
            if (SJR_QUARTILES.includes(sjrBare.rank) && (sjrBare.venueMatchConfidence ?? 0) >= 0.98) {
                return remember({
                    ...sjrBare,
                    decisionEvidence: Array.from(new Set([...(sjrBare.decisionEvidence || []), 'bare_journal_preferred_over_dblp_conference'])),
                    decisionStatus: DECISION_STATUS.MATCHED
                });
            }
        }
        const precomputedRank = resolvePrecomputedDblpVenueRank(dblpVenueMatch, publicationYear ?? null);
        if (precomputedRank) {
            return remember(precomputedRank);
        }
        const rankCandidates = getRankCandidateNamesFromDblpVenue(dblpVenueMatch, venueName);
        const useSjr = dblpVenueMatch.entry.type === 'journal';
        let best = null;
        let sawAmbiguous = false;
        for (const candidate of rankCandidates) {
            let result = useSjr
                ? await resolveSjrRanking(candidate, publicationYear)
                : await resolveCoreRanking(candidate, publicationYear, trackInfo);
            let hit = useSjr ? SJR_QUARTILES.includes(result.rank) : VALID_RANKS.includes(result.rank);
            if (!hit && !useSjr && publicationYear != null) {
                const latestCoreResult = await resolveCoreRanking(candidate, null, trackInfo);
                if (VALID_RANKS.includes(latestCoreResult.rank)) {
                    result = {
                        ...latestCoreResult,
                        sourceYearFallback: true,
                        decisionEvidence: Array.from(new Set([...(latestCoreResult.decisionEvidence || []), 'core_latest_snapshot_fallback']))
                    };
                    hit = true;
                }
            }
            if (hit) {
                return remember({
                    ...result,
                    matchedVenue: result.matchedVenue ?? dblpVenueMatch.entry.title,
                    venueMatchConfidence: result.venueMatchConfidence ?? dblpVenueMatch.score ?? null,
                    matchedKey: result.matchedKey ?? dblpVenueMatch.entry.id,
                    matchedSourceId: result.matchedSourceId ?? dblpVenueMatch.entry.id,
                    decisionEvidence: Array.from(new Set([...(result.decisionEvidence || []), 'dblp_venue_match'])),
                    decisionStatus: DECISION_STATUS.MATCHED
                });
            }
            if (result.decisionStatus === DECISION_STATUS.AMBIGUOUS)
                sawAmbiguous = true;
            if (!best || (result.matchedVenue && !best.matchedVenue)) {
                best = result;
            }
        }
        if (sawAmbiguous) {
            return remember({
                ...(best || createUnrankedDblpVenueDecision(dblpVenueMatch, 'Ambiguous')),
                rank: 'N/A',
                matchedVenue: dblpVenueMatch.entry.title,
                venueMatchConfidence: dblpVenueMatch.score ?? null,
                naReason: 'Ambiguous',
                decisionStatus: DECISION_STATUS.AMBIGUOUS,
                decisionEvidence: ['dblp_venue_match', useSjr ? 'sjr_ambiguous' : 'ambiguous_fuzzy_core'],
                matchedKey: dblpVenueMatch.entry.id,
                matchedSourceId: dblpVenueMatch.entry.id
            });
        }
        return remember(createUnrankedDblpVenueDecision(dblpVenueMatch, 'Unranked'));
    }
    const core = await resolveCoreRanking(venueName, publicationYear, trackInfo);
    const sjr = await resolveSjrRanking(venueName, publicationYear);
    const coreHit = VALID_RANKS.includes(core.rank);
    const sjrHit = SJR_QUARTILES.includes(sjr.rank);
    if (coreHit && sjrHit) {
        return remember((core.venueMatchConfidence ?? 0) >= (sjr.venueMatchConfidence ?? 0) ? core : sjr);
    }
    if (coreHit) return remember(core);
    if (sjrHit) return remember(sjr);
    // Neither system produced a rank: surface the most informative miss.
    if (sjr.naReason || sjr.matchedVenue) return remember(sjr);
    return remember(core);
}
async function evaluatePublicationRanks(publicationLinkElements, statusElement, sessionId, options = {}) {
    const determinedPublicationRanks = [];
    const persistentPublicationRanks = [];
    const coreRankCounts = createEmptyCoreRankCounts();
    const sjrRankCounts = createEmptySjrRankCounts();
    const scholarTitlesAlreadyRanked = new Set();
    const existingRanksByUrl = new Map();
    for (const entry of Array.isArray(options.existingPublicationRanks) ? options.existingPublicationRanks : []) {
        if (entry?.url) {
            existingRanksByUrl.set(entry.url, entry);
        }
    }
    let processedCount = 0;
    const addResultToCounts = (result) => {
        if (result.system === 'CORE') {
            const coreKey = VALID_RANKS.includes(result.rank) ? result.rank : 'N/A';
            coreRankCounts[coreKey] += 1;
        }
        else if (result.system === 'SJR') {
            const sjrKey = SJR_QUARTILES.includes(result.rank) ? result.rank : 'N/A';
            sjrRankCounts[sjrKey] += 1;
        }
    };
    const buildResultFromExistingRank = (pubInfo, existing) => ({
        rank: existing.rank,
        system: existing.system ?? 'UNKNOWN',
        reason: existing.reason ?? null,
        rowElement: pubInfo.rowElement,
        paperTitle: existing.paperTitle ?? pubInfo.paperTitle,
        titleText: existing.titleText ?? pubInfo.titleText,
        publicationYear: existing.publicationYear ?? pubInfo.yearFromProfile ?? null,
        authorCount: existing.authorCount ?? pubInfo.authorCount ?? null,
        url: pubInfo.url,
        shouldPersist: true,
        matchConfidence: existing.matchConfidence ?? null,
        matchedVenue: existing.matchedVenue ?? null,
        venueMatchConfidence: existing.venueMatchConfidence ?? null,
        dblpVenue: existing.dblpVenue ?? null,
        sourceYear: existing.sourceYear ?? null,
        dblpKey: existing.dblpKey ?? null,
        topCandidates: existing.topCandidates ?? null,
        ...mergeDecisionMeta(createDecisionMeta(), {
            decisionVersion: existing.decisionVersion ?? DECISION_VERSION,
            decisionStatus: existing.decisionStatus ?? null,
            confidence: existing.confidence ?? existing.venueMatchConfidence ?? null,
            matchedKey: existing.matchedKey ?? existing.matchedVenue ?? null,
            matchedSourceId: existing.matchedSourceId ?? null,
            sourceYearFallback: existing.sourceYearFallback === true,
            decisionEvidence: existing.decisionEvidence ?? null
        })
    });
    const processPublication = async (pubInfo, titlesAlreadyProcessedSet) => {
        throwIfStaleScanSession(sessionId);
        const publicationYear = pubInfo.yearFromProfile ?? null;
        const buildResult = (extra) => ({
            rank: 'N/A',
            system: 'UNKNOWN',
            reason: null,
            rowElement: pubInfo.rowElement,
            paperTitle: pubInfo.paperTitle,
            titleText: pubInfo.titleText,
            publicationYear,
            authorCount: pubInfo.authorCount ?? null,
            url: pubInfo.url,
            shouldPersist: true,
            matchConfidence: null,
            matchedVenue: null,
            venueMatchConfidence: null,
            dblpVenue: null,
            sourceYear: null,
            dblpKey: null,
            topCandidates: null,
            ...createDecisionMeta(),
            ...extra
        });
        if (titlesAlreadyProcessedSet.has(pubInfo.titleText)) {
            return buildResult();
        }
        const venueName = String(pubInfo.venueText || '').trim();
        if (!venueName) {
            return buildResult({ reason: 'No Venue', ...mergeDecisionMeta(createDecisionMeta(), { decisionStatus: DECISION_STATUS.MISSING, decisionEvidence: ['no_venue'] }) });
        }
        let decision = null;
        const timer = gsvrTimingStart('pickVenueRanking');
        try {
            decision = await pickVenueRanking(venueName, pubInfo.titleText, publicationYear);
        }
        catch (error) {
            if (error instanceof ScanSessionCancelledError) {
                throw error;
            }
            console.warn(`GSR Error processing publication (URL: ${pubInfo.url}, Title: "${pubInfo.titleText.substring(0, 50)}..."):`, error);
        }
        finally {
            gsvrTimingEnd(timer, `(${publicationYear || 'no-year'} "${venueName.slice(0, 80)}")`);
        }
        if (!decision) {
            return buildResult();
        }
        const isRanked = (decision.system === 'CORE' && VALID_RANKS.includes(decision.rank)) || (decision.system === 'SJR' && SJR_QUARTILES.includes(decision.rank));
        if (isRanked) {
            titlesAlreadyProcessedSet.add(pubInfo.titleText);
        }
        const decisionMeta = mergeDecisionMeta(createDecisionMeta(), {
            decisionStatus: decision.decisionStatus ?? (isRanked ? DECISION_STATUS.MATCHED : DECISION_STATUS.UNRANKED),
            confidence: decision.venueMatchConfidence ?? null,
            matchedKey: decision.matchedKey ?? decision.matchedVenue ?? null,
            matchedSourceId: decision.matchedSourceId ?? null,
            sourceYearFallback: decision.sourceYearFallback === true,
            decisionEvidence: decision.decisionEvidence ?? null
        });
        return {
            rank: decision.rank,
            system: decision.system,
            reason: decision.rank === 'N/A' ? decision.naReason : null,
            rowElement: pubInfo.rowElement,
            paperTitle: pubInfo.paperTitle,
            titleText: pubInfo.titleText,
            publicationYear,
            authorCount: pubInfo.authorCount ?? null,
            url: pubInfo.url,
            shouldPersist: decision.shouldPersist !== false,
            matchConfidence: null,
            matchedVenue: decision.matchedVenue ?? null,
            venueMatchConfidence: decision.venueMatchConfidence ?? null,
            dblpVenue: null,
            sourceYear: decision.sourceYear ?? null,
            dblpKey: null,
            topCandidates: decision.topCandidates ?? null,
            ...decisionMeta
        };
    };
    for (const pubInfo of publicationLinkElements) {
        throwIfStaleScanSession(sessionId);
        const existingRank = existingRanksByUrl.get(pubInfo.url);
        const canReuseExistingRank = existingRank?.decisionVersion === DECISION_VERSION && isResearchQualityRankedInfo(existingRank);
        const result = canReuseExistingRank
            ? buildResultFromExistingRank(pubInfo, existingRank)
            : await processPublication(pubInfo, scholarTitlesAlreadyRanked);
        addResultToCounts(result);
        const publicationRankInfo = createPublicationRankInfo(result);
        displayRankBadgeAfterTitle(result.rowElement, result.rank, result.system, result.reason, publicationRankInfo);
        determinedPublicationRanks.push(publicationRankInfo);
        if (result.shouldPersist !== false) {
            persistentPublicationRanks.push(publicationRankInfo);
        }
        processedCount++;
        updateStatusElement(statusElement, processedCount, publicationLinkElements.length, "Ranking");
    }
    return {
        coreRankCounts,
        sjrRankCounts,
        determinedPublicationRanks,
        persistentPublicationRanks
    };
}
async function createProductionVenueMatchReport(rawVenue, publicationYear = null, titleText = '') {
    const extractedVenue = extractVenueFromProfileLine(rawVenue) || String(rawVenue || '').trim();
    const trackInfo = createVenueTrackInfoForRanking(extractedVenue, titleText);
    const dblpVenueMatch = isPatentLikeVenue(extractedVenue)
        ? { catalogAvailable: true, status: DECISION_STATUS.UNRANKED, matchedBy: 'patent_like' }
        : await resolveDblpVenueCatalogMatch(extractedVenue, trackInfo);
    const decision = await pickVenueRanking(extractedVenue, titleText, publicationYear ?? null);
    return {
        rawVenue: String(rawVenue || ''),
        venueName: extractedVenue,
        normalizedVenue: normalizeDblpVenueAlias(extractedVenue),
        publicationYear: publicationYear ?? null,
        trackInfo,
        dblpVenueMatch,
        decision
    };
}
function installProductionMatcherDebugApi() {
    const root = (typeof globalThis !== 'undefined') ? globalThis : (typeof window !== 'undefined' ? window : null);
    if (!root)
        return;
    root.GSVRProductionMatcher = {
        createProductionVenueMatchReport,
        extractVenueFromProfileLine,
        normalizeDblpVenueAlias,
        pickVenueRanking,
        resolveDblpVenueCatalogMatch,
        resolveCoreRanking,
        resolveSjrRanking,
        loadRankingsData
    };
}
installProductionMatcherDebugApi();
async function runScanPass({ phase, sessionId, statusElement = null, context = {} }) {
    throwIfStaleScanSession(sessionId);
    const diagnostics = { rateLimitDetected: false, rateLimitEvents: 0 };
    const statusTextElement = statusElement?.querySelector('.gsr-status-text');
    let publicationLinkElements = Array.isArray(context.publicationLinkElements) && context.publicationLinkElements.length > 0
        ? context.publicationLinkElements
        : null;
    if (!publicationLinkElements) {
        if (statusTextElement)
            statusTextElement.textContent = "Expanding publications list...";
        await expandAllPublications(statusElement);
        throwIfStaleScanSession(sessionId);
        publicationLinkElements = collectPublicationLinkElements();
    }
    if (!publicationLinkElements.length) {
        return {
            ok: false,
            reason: 'no-publications',
            phase,
            diagnostics,
            context: { ...context, publicationLinkElements: [] }
        };
    }
    if (statusTextElement)
        statusTextElement.textContent = "Loading venue index…";
    await warmRankingsData('scan');
    throwIfStaleScanSession(sessionId);
    updateStatusElement(statusElement, 0, publicationLinkElements.length, "Ranking");
    const rankingResult = await evaluatePublicationRanks(publicationLinkElements, statusElement, sessionId, {
        existingPublicationRanks: context.existingPublicationRanks || []
    });
    throwIfStaleScanSession(sessionId);
    return {
        ok: true,
        phase,
        diagnostics,
        ...rankingResult,
        context: { ...context, publicationLinkElements }
    };
}
async function persistScanPassResult({ userId, passResult, scanMetadata }) {
    if (!userId || !passResult) {
        return;
    }
    await saveCachedData(userId, passResult.coreRankCounts, passResult.sjrRankCounts, passResult.persistentPublicationRanks || [], {
        ...(scanMetadata || {})
    });
}
function getDepthRunningMessage() {
    return "Fast results are ready. Running a deeper check to improve accuracy and catch missed ranks.";
}
function getDepthCompletionMessage(improvementCount, options = {}) {
    const rateLimited = options?.rateLimited === true;
    if (rateLimited) {
        return improvementCount > 0
            ? "Found additional ranked venues, but DBLP rate-limited part of the depth check. Rescan after some time for the fullest result."
            : "DBLP rate-limited part of the depth check. No additional ranked venues were found this time; try rescanning after some time.";
    }
    return improvementCount > 0
        ? "Found additional ranked venues in the depth check."
        : "No additional ranked venues were found.";
}
function getDepthFailureMessage(options = {}) {
    return options?.rateLimited === true
        ? "DBLP is rate limiting requests right now. Fast results remain visible. Try rescanning after some time."
        : "Fast results remain visible.";
}
function getScanLifecyclePresentation(scanLifecycle) {
    if (!scanLifecycle) {
        return null;
    }
    if (scanLifecycle.status === 'running') {
        return {
            chip: 'UPGRADING',
            title: 'Improving your results',
            message: scanLifecycle.message || getDepthRunningMessage()
        };
    }
    if (scanLifecycle.status === 'completed') {
        const improved = Number(scanLifecycle.improvementCount) > 0;
        return {
            chip: improved ? 'UPDATED' : 'DONE',
            title: improved ? 'Results improved' : 'Depth check complete',
            message: scanLifecycle.message || getDepthCompletionMessage(scanLifecycle.improvementCount || 0)
        };
    }
    if (scanLifecycle.status === 'failed') {
        return {
            chip: 'DEPTH',
            title: 'Depth check paused',
            message: scanLifecycle.message || getDepthFailureMessage()
        };
    }
    return {
        chip: 'STATUS',
        title: 'Scan update',
        message: scanLifecycle.message || ''
    };
}
function displayProfileMismatchStatus(statusElement, sanitizedName) {
    setStatusCardTitle(statusElement, "DBLP Author Not Found");
    setStatusCardSpinnerVisible(statusElement, false);
    const progressBar = statusElement?.querySelector('.gsr-progress-bar-inner');
    if (progressBar?.parentElement) {
        progressBar.parentElement.style.display = 'none';
    }
    const statusTextElement = statusElement?.querySelector('.gsr-status-text');
    if (statusTextElement) {
        statusTextElement.textContent = "DBLP Author Not Found";
        statusTextElement.setAttribute('title', `No verified DBLP PID for "${sanitizedName}".`);
        statusTextElement.style.color = '#64748b';
    }
    appendStatusRescanControls(statusElement, { includeManualEntry: true, rescanLabel: 'Rescan Me' });
}
function displayNoPublicationsStatus(statusElement, message) {
    setStatusCardSpinnerVisible(statusElement, false);
    const progressBar = statusElement?.querySelector('.gsr-progress-bar-inner');
    if (progressBar?.parentElement) {
        progressBar.parentElement.style.display = 'none';
    }
    const statusTextElement = statusElement?.querySelector('.gsr-status-text');
    if (statusTextElement) {
        statusTextElement.textContent = message;
        statusTextElement.style.color = '#64748b';
    }
}
function releaseForegroundScanSession(sessionId) {
    if (activeForegroundScanSessionId === sessionId) {
        activeForegroundScanSessionId = 0;
    }
    isMainProcessing = false;
}
async function runExpandedProfileUpdate({ sessionId, statusElement, currentUserId, scholarAuthorName, visiblePassResult = null }) {
    try {
        throwIfStaleScanSession(sessionId);
        const statusTextElement = statusElement?.querySelector('.gsr-status-text');
        if (statusTextElement) {
            statusTextElement.textContent = "Loading remaining publications...";
        }
        await expandAllPublications(statusElement);
        throwIfStaleScanSession(sessionId);
        const publicationLinkElements = collectPublicationLinkElements();
        const expandedResult = await runScanPass({
            phase: 'expanded',
            sessionId,
            statusElement,
            context: {
                currentUserId,
                scholarAuthorName,
                publicationLinkElements,
                existingPublicationRanks: visiblePassResult?.determinedPublicationRanks || []
            }
        });
        if (!expandedResult.ok) {
            return;
        }
        throwIfStaleScanSession(sessionId);
        const completedAt = Date.now();
        await persistScanPassResult({
            userId: currentUserId,
            passResult: expandedResult,
            scanMetadata: {
                scanStage: 'complete',
                fastCompletedAt: completedAt,
                depthCompletedAt: completedAt,
                depthAttemptedAt: completedAt,
                depthCompletionDismissed: true
            }
        });
        displaySummaryPanel(expandedResult.coreRankCounts, expandedResult.sjrRankCounts, currentUserId, expandedResult.determinedPublicationRanks, completedAt, null, buildScanLifecycleState('complete', null), {
            authorName: scholarAuthorName
        });
        logE2eMilestoneOnce('full profile ranked');
    }
    catch (error) {
        if (error instanceof ScanSessionCancelledError) {
            return;
        }
        console.warn('GSR: Background expansion pass failed.', error);
    }
}
// --- END: Main Orchestration ---
async function legacyInitialLoad_DoNotUse() {
    if (isMainProcessing) {
        return;
    }
    await loadSettingsIntoState();
    activeSummaryFilter = null;
    previewSummaryFilter = null;
    const surfaceMode = getScholarSurfaceMode();
    if (surfaceMode !== 'profile') {
        teardownOffProfileSurfaceUi();
        return;
    }
    const userId = getScholarUserId();
    if (userId) {
        const cached = await loadCachedData(userId);
        if (cached && cached.publicationRanks && cached.scanStage !== 'visible') {
            const pubRanksArr = unpackRanks(cached.publicationRanks);
            displaySummaryPanel(cached.coreRankCounts, cached.sjrRankCounts, userId, pubRanksArr, cached.timestamp, cached.dblpAuthorPid, null, {
                authorName: getScholarAuthorName(),
                dblpPidSource: cached.dblpPidSource || (cached.dblpAuthorPid ? 'cached' : null)
            });
            return;
        }
    }
    if (currentSettings.autoRun === false) {
        displayDormantStatus();
        return;
    }
    main().catch(error => {
        // Errors are now handled inside main(), so this top-level catch is a final fallback.
        console.error("GSR: Error during initial full analysis in main():", error);
        const statusElem = document.getElementById(STATUS_ELEMENT_ID) || createStatusElement("A critical error occurred.");
        const statusText = statusElem.querySelector('.gsr-status-text');
        if (statusText)
            statusText.textContent = "Critical Error. Check console.";
        const progressBar = statusElem.querySelector('.gsr-progress-bar-inner');
        if (progressBar)
            progressBar.style.backgroundColor = 'red';
        appendStatusScanControls(statusElem);
    });
}
async function main(options = {}) {
    if (getScholarSurfaceMode() !== 'profile') {
        teardownOffProfileSurfaceUi();
        return;
    }
    if (isMainProcessing) {
        return;
    }
    const sessionId = typeof options.sessionId === 'number' ? options.sessionId : nextScanSessionId();
    activeForegroundScanSessionId = sessionId;
    isMainProcessing = true;
    let foregroundReleased = false;
    await loadSettingsIntoState();
    disconnectPublicationTableObserver();
    activeCachedPublicationRanks = null;
    rankMapForObserver = null;
    const statusElement = createStatusElement("Initializing Scholar Ranker...");
    try {
        const currentUserId = getScholarUserId();
        const scholarAuthorName = getScholarAuthorName();
        if (!scholarAuthorName) {
            const statusTextElement = statusElement.querySelector('.gsr-status-text');
            if (statusTextElement)
                statusTextElement.textContent = "Could not determine Scholar author name from page.";
            return;
        }
        const shouldRunExpansionPass = hasExpandableScholarPublications();
        const visiblePublicationLinkElements = collectPublicationLinkElements();
        const passResult = await runScanPass({
            phase: shouldRunExpansionPass ? 'visible' : 'full',
            sessionId,
            statusElement,
            context: { currentUserId, scholarAuthorName, publicationLinkElements: visiblePublicationLinkElements }
        });
        if (!passResult.ok) {
            if (passResult.reason === 'no-publications') {
                displayNoPublicationsStatus(statusElement, "No publications found on profile.");
                setTimeout(() => document.getElementById(STATUS_ELEMENT_ID)?.remove(), 3000);
            }
            return;
        }
        throwIfStaleScanSession(sessionId);
        const completedAt = Date.now();
        await persistScanPassResult({
            userId: currentUserId,
            passResult,
            scanMetadata: {
                scanStage: shouldRunExpansionPass ? 'visible' : 'complete',
                fastCompletedAt: completedAt,
                depthCompletedAt: shouldRunExpansionPass ? null : completedAt,
                depthAttemptedAt: shouldRunExpansionPass ? null : completedAt,
                depthCompletionDismissed: !shouldRunExpansionPass
            }
        });
        displaySummaryPanel(passResult.coreRankCounts, passResult.sjrRankCounts, currentUserId, passResult.determinedPublicationRanks, completedAt, null, shouldRunExpansionPass ? buildScanLifecycleState('running', "Visible ranks are ready. Loading remaining publications in the background.") : buildScanLifecycleState('complete', null), {
            authorName: scholarAuthorName
        });
        releaseForegroundScanSession(sessionId);
        foregroundReleased = true;
        if (shouldRunExpansionPass) {
            Promise.resolve().then(() => runExpandedProfileUpdate({
                sessionId,
                statusElement,
                currentUserId,
                scholarAuthorName,
                visiblePassResult: passResult
            }));
        }
        else {
            logE2eMilestoneOnce('full profile ranked');
        }
    }
    catch (error) {
        if (error instanceof ScanSessionCancelledError) {
            return;
        }
        console.error("GSR: Uncaught error in main pipeline:", error);
        const statusElem = document.getElementById(STATUS_ELEMENT_ID) || createStatusElement("An error occurred in main pipeline.");
        const currentStatusText = statusElem.querySelector('.gsr-status-text');
        if (currentStatusText)
            currentStatusText.textContent = "Error in main. Check console.";
        const progressBar = statusElem.querySelector('.gsr-progress-bar-inner');
        if (progressBar)
            progressBar.style.backgroundColor = 'red';
        appendStatusRescanControls(statusElem);
    }
    finally {
        if (!foregroundReleased) {
            releaseForegroundScanSession(sessionId);
        }
    }
}
async function initialLoad() {
    if (isMainProcessing) {
        return;
    }
    await loadSettingsIntoState();
    activeSummaryFilter = null;
    previewSummaryFilter = null;
    const surfaceMode = getScholarSurfaceMode();
    if (surfaceMode !== 'profile') {
        teardownOffProfileSurfaceUi();
        return;
    }
    const userId = getScholarUserId();
    if (userId) {
        const cached = await loadCachedData(userId);
        if (cached && cached.publicationRanks && cached.scanStage !== 'visible') {
            const pubRanksArr = unpackRanks(cached.publicationRanks);
            const cachedTimestamp = cached.depthCompletedAt ?? cached.fastCompletedAt ?? cached.timestamp;
            displaySummaryPanel(cached.coreRankCounts, cached.sjrRankCounts, userId, pubRanksArr, cachedTimestamp, null, buildScanLifecycleState('complete', null), {
                authorName: getScholarAuthorName()
            });
            return;
        }
    }
    if (currentSettings.autoRun === false) {
        displayDormantStatus();
        return;
    }
    main().catch(error => {
        console.error("GSR: Error during initial full analysis in main():", error);
        const statusElem = document.getElementById(STATUS_ELEMENT_ID) || createStatusElement("A critical error occurred.");
        const statusText = statusElem.querySelector('.gsr-status-text');
        if (statusText)
            statusText.textContent = "Critical Error. Check console.";
        const progressBar = statusElem.querySelector('.gsr-progress-bar-inner');
        if (progressBar)
            progressBar.style.backgroundColor = 'red';
        appendStatusRescanControls(statusElem);
    });
}
function executeInitialLoad() {
    initialLoad();
}
let pageInitializationObserver = null;
if (!(typeof globalThis !== 'undefined' && globalThis.GSVR_DISABLE_AUTO_INIT === true)) {
if (chrome?.storage?.onChanged && SETTINGS_API?.SETTINGS_KEY) {
    chrome.storage.onChanged.addListener(async (changes, areaName) => {
        if (areaName !== 'local') {
            return;
        }
        const settingsChanged = !!changes[SETTINGS_API.SETTINGS_KEY];
        const rankingPacksChanged = !!changes[FEATURE_STORAGE_KEYS.enabledRankingPacks];
        if (!settingsChanged && !rankingPacksChanged) {
            return;
        }
        await loadSettingsIntoState();
        if (getScholarSurfaceMode() !== 'profile') {
            teardownOffProfileSurfaceUi();
            return;
        }
        if (!activeSummaryFilter) {
            activeSummaryFilter = currentSettings.defaultHighlightMode !== 'none'
                ? { type: 'preset', mode: currentSettings.defaultHighlightMode }
                : null;
        }
        if (currentSettings.showAuthorshipHighlights !== true && activeSummaryFilter?.type === 'authorship') {
            activeSummaryFilter = null;
        }
        if (currentSettings.showAuthorshipHighlights !== true && previewSummaryFilter?.type === 'authorship') {
            previewSummaryFilter = null;
        }
        previewSummaryFilter = null;
        if (activeCachedPublicationRanks && activeCachedPublicationRanks.length > 0) {
            restoreVisibleInlineBadgesFromCache(activeCachedPublicationRanks);
        }
        else {
            applyActiveSummaryFilter();
        }
    });
}
// Popup remote control: lets the toolbar popup show the live state of this
// tab and trigger a rescan without the user hunting for in-page controls.
if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (!message || typeof message !== 'object') {
            return;
        }
        if (message.type === 'GSVR_POPUP_STATUS') {
            const surfaceMode = getScholarSurfaceMode();
            const summary = currentSummaryState;
            const publicationCount = Array.isArray(summary?.publicationRanks) ? summary.publicationRanks.length : 0;
            const totalScore = Number(summary?.venueProfileIndex?.totalScore);
            sendResponse({
                ok: true,
                surfaceMode,
                isScanning: isMainProcessing,
                authorName: surfaceMode === 'profile' ? (getScholarAuthorName() || null) : null,
                hasResults: !!summary,
                publicationCount,
                gsvrScore: Number.isFinite(totalScore) ? totalScore : null,
                updatedAt: summary?.cacheTimestamp ?? null,
                dblpAuthorPid: currentProfileContext?.dblpAuthorPid || null,
                dblpPidSource: currentProfileContext?.dblpPidSource || null
            });
            return false;
        }
        if (message.type === 'GSVR_POPUP_RESCAN') {
            if (getScholarSurfaceMode() !== 'profile') {
                sendResponse({ ok: false, reason: 'not-profile' });
                return false;
            }
            if (isMainProcessing) {
                sendResponse({ ok: false, reason: 'busy' });
                return false;
            }
            Promise.resolve()
                .then(() => rescanCurrentProfile())
                .catch((error) => console.warn('GSVR: popup-triggered rescan failed.', error));
            sendResponse({ ok: true });
            return false;
        }
        return undefined;
    });
}
function hasLiveRankingHydration() {
    return !!publicationTableObserver
        || !!(activeCachedPublicationRanks && activeCachedPublicationRanks.length > 0)
        || !!(rankMapForObserver && rankMapForObserver.size > 0)
        || !!document.querySelector('.gsr-rank-badge-inline');
}
function clearStaleInitializationMarkers() {
    document.getElementById(STATUS_ELEMENT_ID)?.remove();
    document.getElementById(SUMMARY_PANEL_ID)?.remove();
    document.getElementById(FACULTY_SCORE_PANEL_ID)?.remove();
    removeCitationGraphRankChips();
    currentSummaryState = null;
}
function attemptPageInitialization() {
    if (getScholarSurfaceMode() !== 'profile') {
        teardownOffProfileSurfaceUi();
        return false;
    }
    const hasInitializationMarker = !!(document.getElementById(STATUS_ELEMENT_ID) || document.getElementById(SUMMARY_PANEL_ID));
    if (isMainProcessing && hasInitializationMarker) {
        return true;
    }
    if (hasInitializationMarker && hasLiveRankingHydration()) {
        return true;
    }
    if (hasInitializationMarker) {
        clearStaleInitializationMarkers();
    }
    if (window.location.pathname.includes("/citations")) {
        const tableBodyElement = document.getElementById('gsc_a_b');
        if (tableBodyElement) {
            warmRankingsData('profile-detected');
            if (pageInitializationObserver) {
                pageInitializationObserver.disconnect();
                pageInitializationObserver = null;
            }
            setTimeout(executeInitialLoad, 500);
            return true;
        }
    }
    else {
        if (pageInitializationObserver) {
            pageInitializationObserver.disconnect();
            pageInitializationObserver = null;
        }
    }
    return false;
}
if (!attemptPageInitialization()) {
    pageInitializationObserver = new MutationObserver(() => {
        if (attemptPageInitialization()) {
            // Observer is disconnected within the function
        }
    });
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
            if (document.documentElement && pageInitializationObserver) {
                pageInitializationObserver.observe(document.documentElement, { childList: true, subtree: true });
            }
        });
    }
    else {
        if (document.documentElement && pageInitializationObserver) {
            pageInitializationObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
    }
    setTimeout(() => {
        if (pageInitializationObserver) {
            pageInitializationObserver.disconnect();
            pageInitializationObserver = null;
        }
    }, 15000);
}
}
