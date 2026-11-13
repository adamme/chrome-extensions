# HelloFresh Meal Ratings

A Manifest V3 Chrome extension that overlays your personal Google Sheet meal ratings onto HelloFresh's meal selection store (`hellofresh.com/store`) and lets you filter out low-rated or premium surcharge meals.

## Features

- **Store-Only Activation**: Runs exclusively on `https://www.hellofresh.com/store*` meal selection pages and stays inactive on `/my-account/deliveries/menu*`.
- **Private Google Sheet Live Sync**: Fetches CSV exports directly from your Google Sheet using your active Chrome Google session (`credentials: 'include'`)—no need to make your spreadsheet public. Caches ratings locally in `chrome.storage.local` (auto-refreshing every 10 minutes) and falls back to `default_ratings.json` when offline or signed out.
- **1–10 Color-Coded Rating Badges**: Displays a high-contrast pill badge in the upper-right corner of each rated meal card. Supports decimal/half-point averages while mapping colors to 10 discrete buckets (`Math.floor(score)` clamped `1–10`):
  - **8–10**: Green (pretty good → top tier)
  - **7**: Yellow (borderline)
  - **6**: Amber
  - **5**: Orange
  - **1–4**: Red-orange → deep crimson red
- **Hover Breakdown Tooltip**: Hovering any rating badge displays individual scores, date, tasting notes, and previous rating history if you've had variations of the dish before.
- **Saved Meal Filters (`Hide Rated < 7` & `Hide Premium Picks`)**:
  - Accessible from both the extension popup and an inline **HF Filters** bar injected on the store page, with state persisted in `chrome.storage.local`.
  - **Hide Premium Picks** catches surcharge prices (`+$X.XX`), `20-Min Premium`, `Chef Premium`, `Premium Picks`, `Family Feast`, `Gourmet`, and related labels.
  - **In-Place Dimming**: Filtered cards are muted in place (`opacity: 0.14`, `grayscale(100%)`, `pointer-events: none`) rather than collapsed (`display: none`), keeping HelloFresh's grid geometry stable and preventing React virtual-scroll flickering.
- **Scroll-Ahead Preloading (`page_preload.js`)**: Runs at `document_start` in the `MAIN` world to wrap `IntersectionObserver` and read HelloFresh's React Fiber `slots` / `activeItem` context directly from memory. This pre-identifies premium surcharges, subtitles, and `< 7` ratings so filtered cards are already grayed out before you scroll them into view.

## Project Structure

| File | Purpose |
| :--- | :--- |
| `manifest.json` | Manifest V3 configuration, permissions, host permissions, and content script declarations (`MAIN` + isolated worlds). |
| `page_preload.js` | `MAIN`-world `document_start` script that wraps `IntersectionObserver` and extracts meal metadata from HelloFresh's React Fiber tree. |
| `content.js` | Matches meal cards against indexed ratings, injects rating badges/tooltips, renders the inline filter bar, and applies filter attributes. |
| `styles.css` | Styles for the 1–10 badge color scale, hover tooltips, inline filter bar, and `.hf-card-filtered-out` dimming rules. |
| `background.js` | Service worker that parses the Google Sheet CSV (Column B = Meal, Column E = Average), manages 10-minute cache TTL, and falls back to `default_ratings.json`. |
| `popup.html` / `popup.js` | Extension popup showing sync status, rated meal count, saved filter toggles, color scale legend, and a manual **Sync Sheet Now** button. |
| `default_ratings.json` | Bundled snapshot of rated meals used as an offline/unauthenticated fallback. |
| `icons/` | Extension icons (`16px`, `32px`, `48px`, `128px`, plus source `icon.svg`). |

## Installation (Load Unpacked)

1. Open `chrome://extensions/` in Google Chrome.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked** and select this extension folder.
4. Make sure you are signed into Google in Chrome (with access to the target spreadsheet) and open a `https://www.hellofresh.com/store?...` page.

## Configuration

To point the extension at a different Google Sheet:
1. Update `SPREADSHEET_ID` and `GID` in `background.js` (expects **Column B** for meal name and **Column E** for average score).
2. Update the matching spreadsheet URL under `host_permissions` in `manifest.json`.
