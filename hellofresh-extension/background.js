const SPREADSHEET_ID = '1mQOm4Cge3Oz5DVFKsj7uGXiLjC9RIq1f8_RaLatYB8E';
const GID = '0';

// Endpoints to try using the user's logged-in Chrome Google session
const CSV_ENDPOINTS = [
  `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/export?format=csv&gid=${GID}`,
  `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&gid=${GID}`
];

/**
 * RFC-4180 compliant CSV parser that handles quoted multiline strings and commas
 */
function parseCSV(csvText) {
  const rows = [];
  let currentRow = [];
  let currentVal = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const char = csvText[i];
    const nextChar = csvText[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        currentVal += '"';
        i++; // skip escaped quote
      } else if (char === '"') {
        inQuotes = false;
      } else {
        currentVal += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ',') {
        currentRow.push(currentVal);
        currentVal = '';
      } else if (char === '\r' && nextChar === '\n') {
        currentRow.push(currentVal);
        rows.push(currentRow);
        currentRow = [];
        currentVal = '';
        i++; // skip \n
      } else if (char === '\n' || char === '\r') {
        currentRow.push(currentVal);
        rows.push(currentRow);
        currentRow = [];
        currentVal = '';
      } else {
        currentVal += char;
      }
    }
  }

  if (currentVal.length > 0 || currentRow.length > 0) {
    currentRow.push(currentVal);
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Convert parsed CSV rows into structured rating records.
 * Sheet layout: Col A = Date, Col B = Meal, Col C = Anissa, Col D = Adamme, Col E = Average, Col F = Notes
 */
function rowsToRecords(rows) {
  if (!rows || rows.length < 2) return [];

  const mealColIndex = 1; // Column B
  const avgColIndex = 4;  // Column E

  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length <= avgColIndex) continue;

    const meal = (r[mealColIndex] || '').trim();
    if (!meal) continue;

    const avgStr = (r[avgColIndex] || '').trim();
    if (!avgStr || avgStr === '-') continue;

    const avgVal = parseFloat(avgStr);
    if (isNaN(avgVal)) continue;

    records.push({
      date: (r[0] || '').trim(),
      meal: meal,
      anissa: (r[2] || '').trim(),
      adamme: (r[3] || '').trim(),
      average: avgVal,
      averageRaw: avgStr,
      notes: (r[5] || '').trim()
    });
  }

  return records;
}

async function syncFromGoogleSheet() {
  let lastError = null;

  for (const url of CSV_ENDPOINTS) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store'
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
        continue;
      }

      const contentType = response.headers.get('content-type') || '';
      const text = await response.text();

      // Make sure we didn't get redirected to an HTML Google Sign-In page
      if (text.trim().startsWith('<!DOCTYPE html') || text.trim().startsWith('<html') || contentType.includes('text/html')) {
        lastError = 'Not signed into Google in Chrome (or no access to sheet)';
        continue;
      }

      const rows = parseCSV(text);
      const records = rowsToRecords(rows);

      if (records.length > 0) {
        const syncMeta = {
          ratings: records,
          lastSyncedAt: Date.now(),
          syncSource: 'live_google_sheet',
          syncError: null,
          count: records.length
        };
        await chrome.storage.local.set(syncMeta);
        return { ok: true, ...syncMeta };
      } else {
        lastError = 'Parsed 0 rated meals from CSV';
      }
    } catch (err) {
      lastError = err.message || String(err);
    }
  }

  // Fallback to bundled default_ratings.json if nothing in storage yet
  const existing = await chrome.storage.local.get(['ratings', 'lastSyncedAt', 'syncSource']);
  if (!existing.ratings || existing.ratings.length === 0) {
    try {
      const defaultUrl = chrome.runtime.getURL('default_ratings.json');
      const resp = await fetch(defaultUrl);
      const bundled = await resp.json();
      const fallbackMeta = {
        ratings: bundled,
        lastSyncedAt: Date.now(),
        syncSource: 'bundled_snapshot',
        syncError: lastError,
        count: bundled.length
      };
      await chrome.storage.local.set(fallbackMeta);
      return { ok: false, error: lastError, ...fallbackMeta };
    } catch (e) {
      return { ok: false, error: lastError || e.message, ratings: [] };
    }
  }

  await chrome.storage.local.set({ syncError: lastError });
  return {
    ok: false,
    error: lastError,
    ratings: existing.ratings,
    lastSyncedAt: existing.lastSyncedAt,
    syncSource: existing.syncSource,
    count: existing.ratings.length
  };
}

// Initial load on install/startup
chrome.runtime.onInstalled.addListener(() => {
  syncFromGoogleSheet();
});

chrome.runtime.onStartup.addListener(() => {
  syncFromGoogleSheet();
});

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_RATINGS') {
    chrome.storage.local.get(['ratings', 'lastSyncedAt', 'syncSource', 'syncError'], async (data) => {
      const CACHE_TTL_MS = 10 * 60 * 1000; // Refresh automatically every 10 minutes
      const isStale = !data.lastSyncedAt || (Date.now() - data.lastSyncedAt > CACHE_TTL_MS);

      if (!data.ratings || data.ratings.length === 0) {
        const result = await syncFromGoogleSheet();
        sendResponse(result);
      } else {
        // Return cached immediately for instant rendering, and trigger background refresh if stale
        sendResponse({
          ok: true,
          ratings: data.ratings,
          lastSyncedAt: data.lastSyncedAt,
          syncSource: data.syncSource,
          syncError: data.syncError,
          count: data.ratings.length
        });
        if (isStale || message.forceRefresh) {
          syncFromGoogleSheet();
        }
      }
    });
    return true; // async response
  }

  if (message.type === 'FORCE_SYNC') {
    syncFromGoogleSheet().then(result => {
      sendResponse(result);
    });
    return true;
  }
});
