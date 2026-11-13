/**
 * HelloFresh Meal Ratings - Content Script
 *
 * Runs only on meal selection URLs like:
 *   https://www.hellofresh.com/store?week=2026-W48&subscriptionId=...
 * Excludes the general menu view:
 *   https://www.hellofresh.com/my-account/deliveries/menu...
 */

(function () {
  'use strict';

  let ratingsIndex = null; // { exactMap: Map, mainTitleMap: Map, allEntries: Array }
  let filterSettings = {
    hideBelow7: false,
    hidePremium: false
  };
  // Persistent memory of premium cards across React virtualization (keyed by item data-test-id and meal title)
  const knownPremiumIds = new Set();
  const knownPremiumTitles = new Set();
  let scanTimeout = null;
  let lastUrl = location.href;

  /**
   * Check whether the current URL is the meal selection store page
   * and NOT the general my-account/deliveries/menu page.
   */
  function isTargetStorePage() {
    const path = window.location.pathname;
    if (path.includes('/my-account/deliveries/menu')) {
      return false;
    }
    return path.startsWith('/store');
  }

  /**
   * Normalize meal name strings for reliable comparison:
   * - Lowercase
   * - Convert "&" to "and"
   * - Normalize smart quotes and dashes
   * - Remove extra suffixes like "(trays included)" or "Includes recyclable aluminum trays"
   * - Collapse punctuation & whitespace
   */
  function normalizeMealText(str) {
    if (!str) return '';
    let s = str
      .toLowerCase()
      .replace(/[\u2018\u2019\u201B`´]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2010-\u2015]/g, '-')
      .replace(/&/g, ' and ')
      .replace(/includes recyclable aluminum trays/gi, '')
      .replace(/\(trays included\)/gi, '')
      .replace(/elevated dinners,?\s*impressively easy/gi, '')
      .replace(/^anissa recipe changed\s+/i, '');

    // Fix accidental duplicated suffix typos in sheet (e.g. "with Scallion Cabbage Slawwith Scallion Cabbage Slaw")
    const halfLen = Math.floor(s.length / 2);
    for (let len = 12; len <= halfLen; len++) {
      const suffix = s.slice(s.length - len);
      const beforeSuffix = s.slice(s.length - 2 * len, s.length - len);
      if (suffix === beforeSuffix) {
        s = s.slice(0, s.length - len);
        break;
      }
    }

    return s
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Split a full sheet meal name into its main dish headline vs side/subtitle
   * (HelloFresh splits titles at " with ", " over ", " plus ", " in a ", " topped with ", " served with ")
   */
  function extractMainHeadline(mealName) {
    if (!mealName) return '';
    const splitRegex = /\s+(?:with|over|plus|in a|topped with|served with|swirled with)\s+/i;
    const parts = mealName.split(splitRegex);
    return parts[0] ? parts[0].trim() : mealName.trim();
  }

  /**
   * Build fast lookup maps from the array of rating records.
   * Since rows in the sheet are ordered newest-first, the first occurrence of a meal
   * is the most recent rating, and subsequent occurrences are stored in `history`.
   */
  function buildRatingsIndex(records) {
    const exactMap = new Map();
    const mainTitleMap = new Map();

    for (const rec of records) {
      if (!rec || !rec.meal || typeof rec.average !== 'number' || isNaN(rec.average)) {
        continue;
      }

      const normFull = normalizeMealText(rec.meal);
      if (!normFull) continue;

      if (!exactMap.has(normFull)) {
        exactMap.set(normFull, {
          primary: rec,
          history: [rec]
        });
      } else {
        exactMap.get(normFull).history.push(rec);
      }

      const mainTitle = extractMainHeadline(rec.meal);
      const normMain = normalizeMealText(mainTitle);
      if (normMain && normMain.length >= 6) {
        if (!mainTitleMap.has(normMain)) {
          mainTitleMap.set(normMain, []);
        }
        mainTitleMap.get(normMain).push({
          normFull,
          rec
        });
      }
    }

    return { exactMap, mainTitleMap };
  }

  /**
   * Match a card's title and optional subtitle against our indexed sheet ratings.
   */
  function findRatingForCard(titleText, subtitleText) {
    if (!ratingsIndex || !titleText) return null;

    const { exactMap, mainTitleMap } = ratingsIndex;
    const normTitle = normalizeMealText(titleText);
    const normSubtitle = normalizeMealText(subtitleText || '');
    const normCombined = normalizeMealText(
      subtitleText ? `${titleText} ${subtitleText}` : titleText
    );

    if (!normTitle) return null;

    // 1. Exact match on combined Title + Subtitle
    if (normCombined && exactMap.has(normCombined)) {
      return exactMap.get(normCombined);
    }

    // 2. Exact match on Title alone
    if (exactMap.has(normTitle)) {
      return exactMap.get(normTitle);
    }

    // 3. Match where sheet full name starts with normTitle and shares subtitle words
    if (mainTitleMap.has(normTitle)) {
      const candidates = mainTitleMap.get(normTitle);
      if (candidates.length === 1) {
        return exactMap.get(candidates[0].normFull);
      }
      // If multiple variations of the same main dish exist (e.g. different sides), pick best word overlap with subtitle
      if (normSubtitle) {
        const subWords = new Set(normSubtitle.split(' ').filter(w => w.length > 2));
        let bestCandidate = candidates[0];
        let bestOverlap = -1;

        for (const cand of candidates) {
          const candWords = cand.normFull.split(' ');
          let overlap = 0;
          for (const w of candWords) {
            if (subWords.has(w)) overlap++;
          }
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestCandidate = cand;
          }
        }
        return exactMap.get(bestCandidate.normFull);
      }
      return exactMap.get(candidates[0].normFull);
    }

    return null;
  }

  /**
   * Format rating score for display (e.g., 9 -> "9", 9.5 -> "9.5", 8.25 -> "8.3")
   */
  function formatScore(score) {
    if (Number.isInteger(score)) {
      return String(score);
    }
    const rounded = Math.round(score * 10) / 10;
    return String(rounded);
  }

  /**
   * Round down to nearest whole number clamped between 1 and 10
   * so there are exactly 10 consistent colors.
   */
  function getColorBucket(score) {
    const floored = Math.floor(Number(score));
    return Math.max(1, Math.min(10, floored));
  }

  /**
   * Create the DOM element for the rating badge
   */
  function createBadgeElement(matchResult) {
    const { primary, history } = matchResult;
    const score = primary.average;
    const bucket = getColorBucket(score);
    const displayScore = formatScore(score);

    const badge = document.createElement('div');
    badge.className = `hf-meal-rating-badge hf-meal-rating-badge--bucket-${bucket}`;
    badge.setAttribute('data-hf-rating', displayScore);

    const starSpan = document.createElement('span');
    starSpan.className = 'hf-meal-rating-badge__star';
    starSpan.textContent = '★';

    const scoreSpan = document.createElement('span');
    scoreSpan.className = 'hf-meal-rating-badge__score';
    scoreSpan.textContent = displayScore;

    badge.appendChild(starSpan);
    badge.appendChild(scoreSpan);

    // Rich hover tooltip with breakdown and notes from sheet
    const tooltip = document.createElement('div');
    tooltip.className = 'hf-meal-rating-tooltip';

    const titleEl = document.createElement('span');
    titleEl.className = 'hf-meal-rating-tooltip__title';
    titleEl.textContent = `Rated ${displayScore} / 10`;
    tooltip.appendChild(titleEl);

    const metaParts = [];
    if (primary.anissa && primary.anissa !== '-') metaParts.push(`Anissa: ${primary.anissa}`);
    if (primary.adamme && primary.adamme !== '-') metaParts.push(`Adamme: ${primary.adamme}`);
    if (primary.date) metaParts.push(primary.date);

    if (metaParts.length > 0) {
      const metaEl = document.createElement('div');
      metaEl.className = 'hf-meal-rating-tooltip__meta';
      metaEl.textContent = metaParts.join(' • ');
      tooltip.appendChild(metaEl);
    }

    if (primary.notes) {
      const notesEl = document.createElement('div');
      notesEl.className = 'hf-meal-rating-tooltip__notes';
      notesEl.textContent = `“${primary.notes}”`;
      tooltip.appendChild(notesEl);
    }

    if (history && history.length > 1) {
      const prev = history.slice(1).map(h => `${formatScore(h.average)}${h.date ? ` (${h.date})` : ''}`);
      const histEl = document.createElement('div');
      histEl.className = 'hf-meal-rating-tooltip__history';
      histEl.textContent = `Previous: ${prev.join(', ')}`;
      tooltip.appendChild(histEl);
    }

    badge.appendChild(tooltip);

    // Prevent clicking the badge from accidentally triggering card modal if user is just hovering/inspecting
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    return badge;
  }

  /**
   * Extract title and subtitle from a HelloFresh meal card element (`li[data-test-id^="item-"]`).
   * Handles both fully loaded cards and skeleton/lazy-loading cards (enriched with React Fiber data).
   */
  function extractCardTitleAndSubtitle(cardEl) {
    const preloadedSubtitle = cardEl.getAttribute('data-hf-preload-subtitle') || '';

    // 1. Loaded card: h4[data-test-id="product-name"] and span[data-test-id="product-headline"]
    const nameEl = cardEl.querySelector('[data-test-id="product-name"]') ||
                   cardEl.querySelector('h4') ||
                   cardEl.querySelector('h3');

    const headlineEl = cardEl.querySelector('[data-test-id="product-headline"]') ||
                       cardEl.querySelector('[data-test-id="product-headline-screen-reader-text"]');

    if (nameEl) {
      const titleText = (nameEl.textContent || '').trim();
      const subtitleText = headlineEl ? (headlineEl.textContent || '').trim() : preloadedSubtitle;
      if (titleText) {
        return { titleText, subtitleText, isSkeleton: false };
      }
    }

    // 2. Skeleton / lazy-loading card: <button aria-busy="true" aria-label="Meal Name, loading">
    const busyBtn = cardEl.querySelector('button[aria-busy="true"][aria-label]');
    if (busyBtn) {
      const rawLabel = (busyBtn.getAttribute('aria-label') || '').replace(/,\s*loading$/i, '').trim();
      if (rawLabel) {
        return { titleText: rawLabel, subtitleText: preloadedSubtitle, isSkeleton: true };
      }
    }

    // 3. Preloaded React Fiber title or image alt text fallback
    const preloadedTitle = (cardEl.getAttribute('data-hf-preload-title') || '').trim();
    if (preloadedTitle) {
      return { titleText: preloadedTitle, subtitleText: preloadedSubtitle, isSkeleton: true };
    }

    const imgEl = cardEl.querySelector('img[data-test-id="product-image"], img[alt]');
    if (imgEl) {
      const altText = (imgEl.getAttribute('alt') || '').trim();
      if (altText && altText.length > 4) {
        return { titleText: altText, subtitleText: preloadedSubtitle, isSkeleton: false };
      }
    }

    return null;
  }

  /**
   * Detect whether a meal card is a Premium / Surcharge pick.
   * Works both on pre-loaded React Fiber attributes (`data-hf-preload-premium="true"`),
   * remembered IDs/titles, and mounted card DOM elements.
   */
  function isPremiumCard(cardEl, titleText) {
    const itemId = cardEl.getAttribute('data-test-id') || '';

    // 0. Check pre-loaded React Fiber attribute or remembered premium IDs/titles
    if (
      cardEl.getAttribute('data-hf-preload-premium') === 'true' ||
      (itemId && knownPremiumIds.has(itemId)) ||
      (titleText && knownPremiumTitles.has(titleText))
    ) {
      if (itemId) knownPremiumIds.add(itemId);
      if (titleText) knownPremiumTitles.add(titleText);
      return true;
    }

    // 1. Explicit surcharge price container or premium test-id
    let detected = false;
    if (
      cardEl.querySelector('[data-test-id="core-surcharge-price"]') ||
      cardEl.querySelector('[data-test-id*="surcharge"]') ||
      cardEl.querySelector('[data-test-id*="premium" i]')
    ) {
      detected = true;
    }

    // 2. Check any product label / badge / tag text for "premium" (catches "20-Min Premium",
    //    "Chef Premium", "Premium Picks", etc.) as well as "Gourmet", "Craft", "Family Feast", "Big Batch"
    if (!detected) {
      const labelElements = cardEl.querySelectorAll(
        '[data-test-id="product-label"], [data-test-id="product-tag"], [data-test-id*="label"], [data-test-id*="badge"]'
      );
      for (const el of labelElements) {
        const txt = (el.textContent || '').trim();
        if (/premium|gourmet|craft|surcharge|upcharge|family feast|big batch/i.test(txt)) {
          detected = true;
          break;
        }
      }
    }

    // 3. Check footer or full card text for "+$X.XX" surcharge or any "* Premium" label
    if (!detected) {
      const cardText = (cardEl.textContent || '');
      if (/\+\s*\$\d+(\.\d{2})?/.test(cardText) || /\b(20-min\s+premium|chef\s+premium|premium\s+pick|gourmet\s+plus)\b/i.test(cardText)) {
        detected = true;
      }
    }

    if (detected) {
      if (cardEl.getAttribute('data-hf-preload-premium') !== 'true') {
        cardEl.setAttribute('data-hf-preload-premium', 'true');
      }
      if (itemId) knownPremiumIds.add(itemId);
      if (titleText) knownPremiumTitles.add(titleText);
      return true;
    }

    return false;
  }

  /**
   * Inject or update the inline quick-filter bar right on the HelloFresh store page
   * so the user can toggle filters and see how many cards are currently hidden.
   */
  function ensureInlineFilterBar(hiddenCount) {
    let bar = document.getElementById('hf-ext-filter-bar');

    if (!bar) {
      const targetContainer =
        document.querySelector('[data-test-id="menu-items-browse-widget"]') ||
        document.querySelector('ul[data-test-id="item-grid"]')?.parentElement;

      if (!targetContainer) return;

      bar = document.createElement('div');
      bar.id = 'hf-ext-filter-bar';
      bar.className = 'hf-ext-filter-bar';

      bar.innerHTML = `
        <span class="hf-ext-filter-bar__brand">HF Filters</span>
        <label class="hf-ext-filter-pill" id="hf-pill-below7">
          <input type="checkbox" id="hf-chk-below7">
          <span>Hide Rated &lt; 7</span>
        </label>
        <label class="hf-ext-filter-pill" id="hf-pill-premium">
          <input type="checkbox" id="hf-chk-premium">
          <span>Hide Premium Picks</span>
        </label>
        <span class="hf-ext-filter-bar__count" id="hf-filter-hidden-count"></span>
      `;

      targetContainer.appendChild(bar);

      const chkBelow7 = bar.querySelector('#hf-chk-below7');
      const chkPremium = bar.querySelector('#hf-chk-premium');

      const onToggle = () => {
        filterSettings = {
          hideBelow7: chkBelow7.checked,
          hidePremium: chkPremium.checked
        };
        chrome.storage.local.set({ filterSettings });
        scanAndAnnotateCards();
      };

      chkBelow7.addEventListener('change', onToggle);
      chkPremium.addEventListener('change', onToggle);
    }

    // Sync checkbox states & active pill styles
    const chkBelow7 = bar.querySelector('#hf-chk-below7');
    const chkPremium = bar.querySelector('#hf-chk-premium');
    const pillBelow7 = bar.querySelector('#hf-pill-below7');
    const pillPremium = bar.querySelector('#hf-pill-premium');
    const countEl = bar.querySelector('#hf-filter-hidden-count');

    if (chkBelow7 && chkBelow7.checked !== Boolean(filterSettings.hideBelow7)) {
      chkBelow7.checked = Boolean(filterSettings.hideBelow7);
    }
    if (chkPremium && chkPremium.checked !== Boolean(filterSettings.hidePremium)) {
      chkPremium.checked = Boolean(filterSettings.hidePremium);
    }
    if (pillBelow7) {
      pillBelow7.classList.toggle('hf-ext-filter-pill--active', Boolean(filterSettings.hideBelow7));
    }
    if (pillPremium) {
      pillPremium.classList.toggle('hf-ext-filter-pill--active', Boolean(filterSettings.hidePremium));
    }

    if (countEl) {
      const nextText = hiddenCount > 0 ? `(${hiddenCount} filtered)` : '';
      if (countEl.textContent !== nextText) {
        countEl.textContent = nextText;
      }
    }
  }

  /**
   * Locate all meal cards on the HelloFresh store page, inject/update rating badges,
   * and apply saved filters (dim/mute below 7 or premium picks without breaking React's virtual scroll).
   */
  function scanAndAnnotateCards() {
    if (!isTargetStorePage()) {
      removeAllBadges();
      return;
    }

    if (!ratingsIndex) return;

    if (document.body) {
      document.body.classList.toggle('hf-filter-hide-premium', Boolean(filterSettings.hidePremium));
      document.body.classList.toggle('hf-filter-hide-below7', Boolean(filterSettings.hideBelow7));
    }

    // Target HelloFresh store grid items directly: <li data-test-id="item-...">
    let cards = Array.from(document.querySelectorAll('ul[data-test-id="item-grid"] > li[data-test-id^="item-"]'));
    if (cards.length === 0) {
      cards = Array.from(document.querySelectorAll('li[data-test-id^="item-"], [data-recipe-id]'));
    }

    let hiddenCount = 0;

    for (const card of cards) {
      const extracted = extractCardTitleAndSubtitle(card);
      const titleText = extracted ? extracted.titleText : '';
      const matchResult = titleText
        ? findRatingForCard(titleText, extracted.subtitleText)
        : null;

      const cardIsBelow7Rated = Boolean(
        matchResult &&
        typeof matchResult.primary.average === 'number' &&
        matchResult.primary.average < 7
      );
      if (cardIsBelow7Rated && card.getAttribute('data-hf-below7') !== 'true') {
        card.setAttribute('data-hf-below7', 'true');
      } else if (!cardIsBelow7Rated && card.hasAttribute('data-hf-below7')) {
        card.removeAttribute('data-hf-below7');
      }

      const cardIsPremium = isPremiumCard(card, titleText);

      // Determine whether this card should be filtered out
      const isBelow7 = Boolean(filterSettings.hideBelow7 && cardIsBelow7Rated);
      const isPremium = Boolean(filterSettings.hidePremium && cardIsPremium);

      if (isBelow7 || isPremium) {
        if (!card.classList.contains('hf-card-filtered-out')) {
          card.classList.add('hf-card-filtered-out');
        }
        hiddenCount++;
      } else {
        if (card.classList.contains('hf-card-filtered-out')) {
          card.classList.remove('hf-card-filtered-out');
        }
      }

      const existingBadge = card.querySelector('.hf-meal-rating-badge');

      if (!matchResult) {
        if (existingBadge) existingBadge.remove();
        continue;
      }

      const expectedScore = formatScore(matchResult.primary.average);

      // Anchor to the card's product wrapper so the badge stays visible and isn't wiped when the lazy image mounts
      const anchorEl =
        card.querySelector('[data-test-id="product-description-wrapper"]') ||
        card.querySelector('[data-test-id^="product-"]') ||
        card;

      if (existingBadge && existingBadge.parentElement === anchorEl && existingBadge.getAttribute('data-hf-rating') === expectedScore) {
        continue;
      }

      if (existingBadge) {
        existingBadge.remove();
      }

      const computedPos = window.getComputedStyle(anchorEl).position;
      if (computedPos === 'static') {
        anchorEl.classList.add('hf-rating-anchor-relative');
      }

      const badge = createBadgeElement(matchResult);
      anchorEl.appendChild(badge);
    }

    ensureInlineFilterBar(hiddenCount);
  }

  function removeAllBadges() {
    document.querySelectorAll('.hf-meal-rating-badge').forEach(el => el.remove());
    document.querySelectorAll('.hf-card-filtered-out').forEach(el => el.classList.remove('hf-card-filtered-out'));
    const bar = document.getElementById('hf-ext-filter-bar');
    if (bar) bar.remove();
  }

  function scheduleScan() {
    if (scanTimeout) clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
      scanAndAnnotateCards();
    }, 35);
  }

  /**
   * Load ratings and saved filter settings, then annotate and filter cards
   */
  function loadRatingsAndStart() {
    chrome.storage.local.get(['filterSettings'], (stored) => {
      if (stored && stored.filterSettings) {
        filterSettings = {
          hideBelow7: Boolean(stored.filterSettings.hideBelow7),
          hidePremium: Boolean(stored.filterSettings.hidePremium)
        };
      }
      chrome.runtime.sendMessage({ type: 'GET_RATINGS' }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ratings) {
          return;
        }
        ratingsIndex = buildRatingsIndex(response.ratings);
        scanAndAnnotateCards();
      });
    });
  }

  // Listen for live storage updates (ratings sync or filter toggles from popup)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      let needsScan = false;
      if (changes.ratings && changes.ratings.newValue) {
        ratingsIndex = buildRatingsIndex(changes.ratings.newValue);
        needsScan = true;
      }
      if (changes.filterSettings && changes.filterSettings.newValue) {
        filterSettings = {
          hideBelow7: Boolean(changes.filterSettings.newValue.hideBelow7),
          hidePremium: Boolean(changes.filterSettings.newValue.hidePremium)
        };
        needsScan = true;
      }
      if (needsScan) {
        scanAndAnnotateCards();
      }
    }
  });

  // Watch DOM changes for SPA navigation and lazy-loaded meal cards
  // Ignore mutations caused by our own badge or filter bar updates
  const observer = new MutationObserver((mutations) => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
    }
    if (!isTargetStorePage()) {
      removeAllBadges();
      return;
    }
    let hasRelevantMutation = false;
    for (const m of mutations) {
      if (m.target && m.target.closest && (m.target.closest('.hf-meal-rating-badge') || m.target.closest('#hf-ext-filter-bar'))) {
        continue;
      }
      hasRelevantMutation = true;
      break;
    }
    if (hasRelevantMutation) {
      scheduleScan();
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-hf-preload-premium', 'data-hf-preload-subtitle', 'aria-busy']
  });

  loadRatingsAndStart();
})();
