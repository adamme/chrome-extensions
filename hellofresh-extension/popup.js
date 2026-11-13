document.addEventListener('DOMContentLoaded', () => {
  const mealCountEl = document.getElementById('mealCount');
  const syncSourceEl = document.getElementById('syncSource');
  const lastSyncEl = document.getElementById('lastSync');
  const syncBtn = document.getElementById('syncBtn');
  const statusNoteEl = document.getElementById('statusNote');
  const hideBelow7Checkbox = document.getElementById('hideBelow7');
  const hidePremiumCheckbox = document.getElementById('hidePremium');

  // Load saved filter preferences
  chrome.storage.local.get(['filterSettings'], (res) => {
    const settings = res.filterSettings || { hideBelow7: false, hidePremium: false };
    hideBelow7Checkbox.checked = Boolean(settings.hideBelow7);
    hidePremiumCheckbox.checked = Boolean(settings.hidePremium);
  });

  function saveFilterSettings() {
    const filterSettings = {
      hideBelow7: hideBelow7Checkbox.checked,
      hidePremium: hidePremiumCheckbox.checked
    };
    chrome.storage.local.set({ filterSettings });
  }

  hideBelow7Checkbox.addEventListener('change', saveFilterSettings);
  hidePremiumCheckbox.addEventListener('change', saveFilterSettings);

  function renderState(data) {
    if (!data) return;
    mealCountEl.textContent = data.count || (data.ratings ? data.ratings.length : 0);

    if (data.syncSource === 'live_google_sheet') {
      syncSourceEl.textContent = 'Live Google Sheet';
      syncSourceEl.style.color = '#067a46';
    } else if (data.syncSource === 'bundled_snapshot') {
      syncSourceEl.textContent = 'Bundled Snapshot';
      syncSourceEl.style.color = '#d97706';
    } else {
      syncSourceEl.textContent = data.syncSource || 'Unknown';
    }

    if (data.lastSyncedAt) {
      const d = new Date(data.lastSyncedAt);
      lastSyncEl.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else {
      lastSyncEl.textContent = 'Never';
    }

    if (data.syncError && data.syncSource !== 'live_google_sheet') {
      statusNoteEl.textContent = `Using cached snapshot (${data.syncError}).`;
    } else {
      statusNoteEl.textContent = 'Active on hellofresh.com/store meal selection pages.';
    }
  }

  chrome.runtime.sendMessage({ type: 'GET_RATINGS' }, (resp) => {
    renderState(resp);
  });

  syncBtn.addEventListener('click', () => {
    syncBtn.disabled = true;
    syncBtn.textContent = 'Syncing...';
    chrome.runtime.sendMessage({ type: 'FORCE_SYNC' }, (resp) => {
      syncBtn.disabled = false;
      syncBtn.textContent = 'Sync Sheet Now';
      renderState(resp);
    });
  });
});
