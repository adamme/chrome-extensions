/**
 * HelloFresh Meal Ratings - Main World Preloader (`run_at: document_start`, `world: MAIN`)
 *
 * Pre-loads and pre-identifies all meal cards on HelloFresh's `/store` page before scrolling:
 * 1. Wraps `IntersectionObserver` AND its callback so `react-intersection-observer` (`useInView`)
 *    always receives `isIntersecting: true, intersectionRatio: 1` for every meal card on `/store`
 *    and never reverts off-screen cards back to `<button aria-busy="true" aria-label="..., loading">`.
 * 2. Reads HelloFresh's React Context Providers directly from the React Fiber tree:
 *    - The store-wide `slots` Map (`memoizedProps.value.slots`)
 *    - Each card's `activeItem` (`memoizedProps.value.activeItem`)
 *    Using HelloFresh's exact item schema (`activeItem.pricing`, `activeItem.recipe.label`,
 *    `activeItem.recipe.tags`, `activeItem.recipe.headline`), it stamps `data-hf-preload-premium="true"`
 *    and `data-hf-preload-subtitle="..."` onto every `<li data-test-id="item-...">` immediately.
 */

(function () {
  'use strict';

  function isTargetStorePage() {
    const path = window.location.pathname || '';
    if (path.includes('/my-account/deliveries/menu')) {
      return false;
    }
    return path.startsWith('/store');
  }

  function forceIntersectingEntry(entry) {
    if (entry && entry.isIntersecting && entry.intersectionRatio >= 1) {
      return entry;
    }
    return new Proxy(entry, {
      get(targetObj, prop) {
        if (prop === 'isIntersecting') return true;
        if (prop === 'intersectionRatio') return 1;
        if (prop === 'isVisible') return true;
        const val = Reflect.get(targetObj, prop);
        return typeof val === 'function' ? val.bind(targetObj) : val;
      }
    });
  }

  // 1. Wrap IntersectionObserver & its callback so all store cards mount immediately and stay mounted
  const NativeIntersectionObserver = window.IntersectionObserver;
  if (typeof NativeIntersectionObserver === 'function') {
    const WrappedIntersectionObserver = function (callback, options) {
      const wrappedCallback = function (entries, observer) {
        if (isTargetStorePage() && Array.isArray(entries)) {
          const forced = entries.map(forceIntersectingEntry);
          return callback(forced, observer);
        }
        return callback(entries, observer);
      };

      let effectiveOptions = options;
      if (isTargetStorePage() && (!options || !options.root)) {
        effectiveOptions = Object.assign({}, options || {}, {
          rootMargin: '50000px 0px 50000px 0px'
        });
      }

      const instance = new NativeIntersectionObserver(wrappedCallback, effectiveOptions);
      const nativeObserve = instance.observe.bind(instance);

      instance.observe = function (target) {
        nativeObserve(target);

        if (isTargetStorePage() && target && target.nodeType === 1) {
          queueMicrotask(() => {
            try {
              const rect = target.getBoundingClientRect();
              callback(
                [
                  {
                    target,
                    isIntersecting: true,
                    intersectionRatio: 1,
                    isVisible: true,
                    boundingClientRect: rect,
                    intersectionRect: rect,
                    rootBounds: rect,
                    time: performance.now()
                  }
                ],
                instance
              );
            } catch (_) {
              // Ignore if callback expects specific state
            }
          });
        }
      };

      return instance;
    };

    WrappedIntersectionObserver.prototype = NativeIntersectionObserver.prototype;
    Object.defineProperty(window, 'IntersectionObserver', {
      configurable: true,
      writable: true,
      value: WrappedIntersectionObserver
    });
  }

  // 2. Extract exact `activeItem` & `slots` Map from HelloFresh's React Fiber tree
  const PREMIUM_LABEL_REGEX = /premium|20-min[-_\s]+premium|chef[-_\s]+premium|gourmet|craft|family[-_\s]+feast|big[-_\s]+batch|surcharge|upcharge|\+\s*\$\d+/i;

  function checkActiveItemData(activeItem) {
    if (!activeItem || typeof activeItem !== 'object') {
      return null;
    }

    const recipe = activeItem.recipe;
    if (!recipe || typeof recipe !== 'object') {
      return null;
    }

    const recipeId = recipe.id ? String(recipe.id) : (activeItem.id ? String(activeItem.id) : '');
    const headline = typeof recipe.headline === 'string' ? recipe.headline.trim() : '';

    // In HelloFresh's store code (`67083` & `53579`), `isSurcharge` is `!!activeItem.pricing`
    let hasSurcharge = false;
    const pricing = activeItem.pricing;
    if (pricing && typeof pricing === 'object') {
      const ppc = pricing.pricePerContent?.price;
      const ppq = pricing.pricePerQuantity?.[0]?.price;
      const unitAmt = pricing.unitAmount ?? pricing.baseUnitAmount ?? pricing.price;
      if (typeof ppc === 'number' ? ppc > 0 : typeof ppq === 'number' ? ppq > 0 : typeof unitAmt === 'number' ? unitAmt > 0 : true) {
        hasSurcharge = true;
      }
    }
    if (typeof activeItem.itemPrice === 'number' && activeItem.itemPrice > 0) {
      hasSurcharge = true;
    }

    // Check recipe.label (`{ handle, name, text, displayLabel }`) and recipe.tags
    const labelParts = [];
    if (recipe.label && typeof recipe.label === 'object') {
      if (recipe.label.name) labelParts.push(recipe.label.name);
      if (recipe.label.text) labelParts.push(recipe.label.text);
      if (recipe.label.handle) labelParts.push(recipe.label.handle);
    } else if (typeof recipe.label === 'string') {
      labelParts.push(recipe.label);
    }

    if (Array.isArray(recipe.tags)) {
      for (const tag of recipe.tags) {
        if (tag && typeof tag === 'object') {
          if (tag.name) labelParts.push(tag.name);
          if (tag.text) labelParts.push(tag.text);
          if (tag.handle) labelParts.push(tag.handle);
        }
      }
    }

    const combinedLabels = labelParts.join(' ');
    const isPremium = hasSurcharge || PREMIUM_LABEL_REGEX.test(combinedLabels);

    return {
      recipeId,
      name: typeof recipe.name === 'string' ? recipe.name.trim() : '',
      headline,
      isPremium
    };
  }

  function getReactFiber(el) {
    if (!el) return null;
    for (const k of Object.keys(el)) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
        return el[k];
      }
    }
    return null;
  }

  function applyPreloadAttributes(li, info) {
    if (!li || !info) return;
    if (info.isPremium && li.getAttribute('data-hf-preload-premium') !== 'true') {
      li.setAttribute('data-hf-preload-premium', 'true');
    }
    if (info.headline && li.getAttribute('data-hf-preload-subtitle') !== info.headline) {
      li.setAttribute('data-hf-preload-subtitle', info.headline);
    }
    if (info.name && li.getAttribute('data-hf-preload-title') !== info.name) {
      li.setAttribute('data-hf-preload-title', info.name);
    }
  }

  function enrichStoreCardsFromReact() {
    if (!isTargetStorePage()) return;

    const items = document.querySelectorAll('li[data-test-id^="item-"]');
    if (items.length === 0) return;

    // Cache of recipeId -> info discovered from the top-level `slots` Map context
    const byId = new Map();

    // First, walk up from the first card or grid to grab the store-wide `slots` Map (module 251317)
    const firstCard = items[0];
    let rootFiber = getReactFiber(firstCard);
    let steps = 0;
    while (rootFiber && steps < 45) {
      const val = rootFiber.memoizedProps?.value;
      if (val && val.slots instanceof Map) {
        for (const [, slotObj] of val.slots.entries()) {
          const active = slotObj?.activeItem || slotObj?.mainItem || slotObj;
          const info = checkActiveItemData(active);
          if (info && info.recipeId) {
            byId.set(info.recipeId, info);
          }
          if (Array.isArray(slotObj?.variations)) {
            for (const v of slotObj.variations) {
              const vInfo = checkActiveItemData(v?.item || v);
              if (vInfo && vInfo.recipeId) {
                byId.set(vInfo.recipeId, vInfo);
              }
            }
          }
        }
        break;
      }
      rootFiber = rootFiber.return;
      steps++;
    }

    // Apply discovered slot info & per-card `activeItem` Context (module 638200 / 803134)
    for (const li of items) {
      const testId = li.getAttribute('data-test-id') || '';
      const rawId = testId.replace(/^item-/, '');

      if (rawId && byId.has(rawId)) {
        applyPreloadAttributes(li, byId.get(rawId));
        continue;
      }

      // Per-card Fiber walk up to `<o.hu value={{ activeItem, ... }}>`
      let fiber = getReactFiber(li) || getReactFiber(li.firstElementChild);
      let cardSteps = 0;
      while (fiber && cardSteps < 20) {
        const props = fiber.memoizedProps;
        const activeCandidate =
          props?.value?.activeItem ||
          props?.activeItem ||
          props?.shoppableProduct ||
          props?.product ||
          props?.item;

        if (activeCandidate) {
          const info = checkActiveItemData(activeCandidate);
          if (info) {
            applyPreloadAttributes(li, info);
            break;
          }
        }
        fiber = fiber.return;
        cardSteps++;
      }
    }
  }

  let preloadTimer = null;
  function scheduleEnrich() {
    if (preloadTimer) return;
    preloadTimer = setTimeout(() => {
      preloadTimer = null;
      enrichStoreCardsFromReact();
    }, 16);
  }

  const startObserver = () => {
    enrichStoreCardsFromReact();
    const mo = new MutationObserver(() => {
      if (isTargetStorePage()) {
        scheduleEnrich();
      }
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
  };

  if (document.documentElement) {
    startObserver();
  } else {
    window.addEventListener('DOMContentLoaded', startObserver, { once: true });
  }
})();
