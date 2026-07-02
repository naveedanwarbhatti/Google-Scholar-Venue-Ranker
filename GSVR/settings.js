(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.GSVRSettings = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SETTINGS_KEY = "gsvr_settings_v1";
  const FEATURE_STORAGE_KEYS = Object.freeze({
    reportDraft: "gsvr_report_draft_v1",
    enabledRankingPacks: "gsvr_enabled_ranking_packs_v1",
    dataFreshnessState: "gsvr_data_freshness_state_v1",
    profileSnapshots: "gsvr_profile_snapshots_v1",
    savedCompareSet: "gsvr_saved_compare_set_v1",
  });
  const SCORE_MODEL_VERSION = "gsvr-fractional-venue-v1";
  const AVAILABLE_RANKING_PACKS = Object.freeze(["core", "sjr"]);
  const DEFAULT_RANKING_PACKS = Object.freeze(["core", "sjr"]);
  const DEFAULT_SETTINGS = Object.freeze({
    autoRun: true,
    compactMode: false,
    showUnranked: true,
    defaultHighlightMode: "none",
    showDebugDetails: true,
    showAuthorshipHighlights: false
  });
  const DEFAULT_FEATURE_STATE = Object.freeze({
    reportDraft: Object.freeze({
      createdAt: null,
      payload: null,
    }),
    enabledRankingPacks: DEFAULT_RANKING_PACKS,
    dataFreshnessState: Object.freeze({
      lastSeenVersion: null,
      lastDataRefreshLabel: null,
      lastCoreDatasetYear: null,
      lastSjrDatasetYear: null,
      updatedAt: null,
    }),
    profileSnapshots: Object.freeze([]),
    savedCompareSet: Object.freeze({
      leftSnapshotId: "__current__",
      rightSnapshotId: "__current__",
    }),
  });
  const HIGHLIGHT_MODES = Object.freeze(["none", "ranked-only", "needs-review"]);

  function buildCacheMetadata(overrides = {}) {
    const value = overrides && typeof overrides === "object" ? overrides : {};
    return {
      scoreModelVersion: value.scoreModelVersion ?? SCORE_MODEL_VERSION,
      rankingDataVersion: value.rankingDataVersion ?? null,
      coreDataYear: value.coreDataYear ?? null,
      sjrDataVersion: value.sjrDataVersion ?? null,
      decisionVersion: value.decisionVersion ?? null,
    };
  }

  function isCacheMetadataCurrent(cacheEntry, expectedMetadata) {
    const cache = cacheEntry && typeof cacheEntry === "object" ? cacheEntry : {};
    const expected = buildCacheMetadata(expectedMetadata);
    return cache.scoreModelVersion === expected.scoreModelVersion
      && cache.rankingDataVersion === expected.rankingDataVersion
      && cache.coreDataYear === expected.coreDataYear
      && cache.sjrDataVersion === expected.sjrDataVersion
      && cache.decisionVersion === expected.decisionVersion;
  }

  function normalizeSettings(raw) {
    const settings = raw && typeof raw === "object" ? raw : {};
    const next = {
      autoRun: settings.autoRun !== false,
      compactMode: settings.compactMode === true,
      showUnranked: settings.showUnranked !== false,
      defaultHighlightMode: HIGHLIGHT_MODES.includes(settings.defaultHighlightMode)
        ? settings.defaultHighlightMode
        : DEFAULT_SETTINGS.defaultHighlightMode,
      showDebugDetails: settings.showDebugDetails !== false,
      showAuthorshipHighlights: settings.showAuthorshipHighlights === true
    };
    return next;
  }

  function cloneDefaultFeatureValue(name) {
    const value = DEFAULT_FEATURE_STATE[name];
    if (Array.isArray(value)) {
      return value.slice();
    }
    if (value && typeof value === "object") {
      return { ...value };
    }
    return value;
  }

  function normalizeRankingPacks(_raw) {
    return DEFAULT_RANKING_PACKS.slice();
  }

  function normalizeFeatureState(name, raw) {
    if (name === "enabledRankingPacks") {
      return normalizeRankingPacks(raw);
    }

    const fallback = cloneDefaultFeatureValue(name);
    if (!fallback || typeof fallback !== "object" || Array.isArray(fallback)) {
      return raw == null ? fallback : raw;
    }

    const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    return { ...fallback, ...value };
  }

  function shouldReuseProfileCacheEntry(raw) {
    return !!raw && typeof raw === "object";
  }

  function extractScholarUserId(rawValue) {
    const value = String(rawValue || "").trim();
    if (!value) {
      return null;
    }

    try {
      const url = new URL(value, "https://scholar.google.com");
      const hostname = String(url.hostname || "").toLowerCase();
      const isScholarHost = hostname === "scholar.google.com" || /^scholar\.google\./i.test(hostname);
      if (!isScholarHost || !/\/citations\/?$/i.test(url.pathname || "")) {
        return null;
      }

      const userId = String(url.searchParams.get("user") || "").trim();
      return userId || null;
    } catch {
      return null;
    }
  }

  function normalizeScholarProfileUrl(rawValue) {
    const userId = extractScholarUserId(rawValue);
    if (!userId) {
      return null;
    }
    return `https://scholar.google.com/citations?user=${encodeURIComponent(userId)}`;
  }

  function normalizePersistentCacheToken(rawValue) {
    return encodeURIComponent(
      String(rawValue || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
    );
  }

  function buildLocalVenueCandidateNames(baseItem) {
    const entry = baseItem && typeof baseItem === "object" ? baseItem : {};
    const out = [];
    const seen = new Set();
    const push = (value) => {
      const trimmed = String(value || "").trim();
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
    const extractSeriesId = (value) => {
      const text = String(value || "").trim();
      if (!text) {
        return null;
      }
      const pathMatch = text.match(/^(?:conf|journals)\/([^/]+)(?:\/|$)/i);
      if (pathMatch?.[1]) {
        return pathMatch[1];
      }
      const lastSlash = text.lastIndexOf("/");
      if (lastSlash !== -1 && lastSlash < text.length - 1) {
        return text.slice(lastSlash + 1);
      }
      return text;
    };
    const booktitle = String(entry.booktitle || "").trim();
    const journal = String(entry.journal || "").trim();
    const series = String(entry.series || "").trim();
    const rawVenue = String(entry.rawVenue || "").trim();

    push(rawVenue);
    push(booktitle);
    push(journal);
    push(series);

    const crossrefSeriesId = extractSeriesId(entry.crossref);
    const dblpSeriesId = extractSeriesId(entry.dblpKey);
    push(crossrefSeriesId);
    push(dblpSeriesId);

    const procAcmFallback = rawVenue.startsWith("Proc. ACM") && /^[A-Za-z][A-Za-z0-9-]{1,15}$/.test(String(entry.number || "").trim())
      ? String(entry.number || "").trim()
      : null;
    push(procAcmFallback);
    if (/^[A-Za-z][A-Za-z0-9-]{1,15}$/.test(String(entry.number || "").trim())) {
      push(String(entry.number || "").trim());
    }

    return out;
  }

  function selectDistributedSampleIndices(totalCount, maxCount = 15) {
    const total = Math.max(0, Number(totalCount) || 0);
    const cap = Math.max(1, Number(maxCount) || 1);
    if (total === 0) {
      return [];
    }
    if (total <= cap) {
      return Array.from({ length: total }, (_, index) => index);
    }
    if (cap === 1) {
      return [0];
    }

    const seen = new Set();
    for (let index = 0; index < cap; index += 1) {
      const sampleIndex = Math.round((index * (total - 1)) / (cap - 1));
      seen.add(Math.max(0, Math.min(total - 1, sampleIndex)));
    }

    if (seen.size < cap) {
      for (let index = 0; index < total && seen.size < cap; index += 1) {
        seen.add(index);
      }
    }

    return Array.from(seen).sort((left, right) => left - right);
  }

  function buildScholarVerificationSample(items, maxCount = 15) {
    const entries = Array.isArray(items) ? items : [];
    const cap = Math.max(1, Number(maxCount) || 1);
    const selectedIndices = selectDistributedSampleIndices(entries.length, cap);
    const usedIndices = new Set(selectedIndices);
    const seenTitles = new Set();
    const sample = [];

    const appendEntry = (entry) => {
      const normalizedTitle = String(entry?.normalizedTitle || entry?.title || "").trim().toLowerCase();
      if (!normalizedTitle || seenTitles.has(normalizedTitle)) {
        return;
      }
      seenTitles.add(normalizedTitle);
      sample.push({
        ...entry,
        normalizedTitle,
      });
    };

    for (const index of selectedIndices) {
      appendEntry(entries[index]);
      if (sample.length >= cap) {
        return sample;
      }
    }

    for (let index = 0; index < entries.length && sample.length < cap; index += 1) {
      if (usedIndices.has(index)) {
        continue;
      }
      appendEntry(entries[index]);
    }

    return sample;
  }

  function selectBestProfileVerificationCandidate(candidates, options = {}) {
    const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
    const exactMatchPriority = (candidate) => {
      if (candidate?.matchReason === "scholar_user") {
        return 2;
      }
      if (candidate?.matchReason === "scholar_url") {
        return 1;
      }
      return 0;
    };
    const scoreValue = (candidate) => Number.isFinite(candidate?.score) ? candidate.score : Number.NEGATIVE_INFINITY;
    const overlapValue = (candidate) => Number.isFinite(candidate?.overlapCount) ? candidate.overlapCount : Number.NEGATIVE_INFINITY;
    const compareCandidates = (left, right) => {
      const exactDelta = exactMatchPriority(right) - exactMatchPriority(left);
      if (exactDelta !== 0) {
        return exactDelta;
      }
      if (scoreValue(right) !== scoreValue(left)) {
        return scoreValue(right) - scoreValue(left);
      }
      if (overlapValue(right) !== overlapValue(left)) {
        return overlapValue(right) - overlapValue(left);
      }
      return String(left?.pid || "").localeCompare(String(right?.pid || ""));
    };

    const exactMatches = list
      .filter((candidate) => exactMatchPriority(candidate) > 0)
      .sort(compareCandidates);
    if (exactMatches.length > 0) {
      return exactMatches[0];
    }

    const rankedMatches = list
      .filter((candidate) => candidate?.status === "matched")
      .sort(compareCandidates);
    const best = rankedMatches[0] || null;
    const runnerUp = rankedMatches[1] || null;
    if (!best) {
      return null;
    }

    const strongScoreThreshold = Number(options?.profileStrongScoreThreshold);
    const ambiguityGap = Number(options?.profileAmbiguityGap);
    if (
      runnerUp
      && Number.isFinite(strongScoreThreshold)
      && Number.isFinite(ambiguityGap)
      && scoreValue(best) < strongScoreThreshold
      && (scoreValue(best) - scoreValue(runnerUp)) < ambiguityGap
    ) {
      return null;
    }

    return best;
  }

  function shouldEscalateProfileVerification(status) {
    const normalized = String(status || "").trim().toLowerCase();
    return normalized === "no_match" || normalized === "ambiguous";
  }

  async function getArea() {
    return chrome?.storage?.local;
  }

  async function loadFeatureState(name) {
    const storageKey = FEATURE_STORAGE_KEYS[name];
    if (!storageKey) {
      throw new Error(`Unknown GSVR feature storage key: ${name}`);
    }
    const area = await getArea();
    const fallback = cloneDefaultFeatureValue(name);
    if (!area?.get) {
      return normalizeFeatureState(name, fallback);
    }
    try {
      const result = await area.get(storageKey);
      return normalizeFeatureState(name, result?.[storageKey]);
    } catch {
      return normalizeFeatureState(name, fallback);
    }
  }

  async function saveFeatureState(name, value) {
    const storageKey = FEATURE_STORAGE_KEYS[name];
    if (!storageKey) {
      throw new Error(`Unknown GSVR feature storage key: ${name}`);
    }
    const area = await getArea();
    const normalized = normalizeFeatureState(name, value);
    if (!area?.set) {
      return normalized;
    }
    await area.set({ [storageKey]: normalized });
    return normalized;
  }

  async function removeFeatureState(name) {
    const storageKey = FEATURE_STORAGE_KEYS[name];
    if (!storageKey) {
      throw new Error(`Unknown GSVR feature storage key: ${name}`);
    }
    const area = await getArea();
    if (!area?.remove) {
      return cloneDefaultFeatureValue(name);
    }
    await area.remove(storageKey);
    return cloneDefaultFeatureValue(name);
  }

  async function loadRankingPacks() {
    return loadFeatureState("enabledRankingPacks");
  }

  async function saveRankingPacks(value) {
    return saveFeatureState("enabledRankingPacks", value);
  }

  async function loadSettings() {
    const area = await getArea();
    if (!area?.get) {
      return { ...DEFAULT_SETTINGS };
    }
    try {
      const result = await area.get(SETTINGS_KEY);
      return normalizeSettings(result?.[SETTINGS_KEY]);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async function replaceSettings(value) {
    const area = await getArea();
    const normalized = normalizeSettings(value);
    if (!area?.set) {
      return normalized;
    }
    await area.set({ [SETTINGS_KEY]: normalized });
    return normalized;
  }

  async function saveSettings(partial) {
    const current = await loadSettings();
    return replaceSettings({ ...current, ...(partial || {}) });
  }

  async function resetSettings() {
    return replaceSettings(DEFAULT_SETTINGS);
  }

  return {
    SETTINGS_KEY,
    FEATURE_STORAGE_KEYS,
    SCORE_MODEL_VERSION,
    AVAILABLE_RANKING_PACKS,
    DEFAULT_RANKING_PACKS,
    DEFAULT_SETTINGS,
    DEFAULT_FEATURE_STATE,
    HIGHLIGHT_MODES,
    normalizeSettings,
    normalizeRankingPacks,
    normalizeFeatureState,
    buildCacheMetadata,
    isCacheMetadataCurrent,
    extractScholarUserId,
    normalizeScholarProfileUrl,
    buildLocalVenueCandidateNames,
    selectDistributedSampleIndices,
    buildScholarVerificationSample,
    shouldReuseProfileCacheEntry,
    selectBestProfileVerificationCandidate,
    shouldEscalateProfileVerification,
    loadSettings,
    replaceSettings,
    saveSettings,
    resetSettings,
    loadFeatureState,
    saveFeatureState,
    removeFeatureState,
    loadRankingPacks,
    saveRankingPacks
  };
});
