// ============================================================================
// [SW-1] Service worker — automatic cache-busting + offline shell
// ----------------------------------------------------------------------------
// Replaces the manual `?v=N` cache-busting trick. With this SW registered,
// every page load tries the network first. If the network responds, the
// user sees the freshest payroll.html and the cached copy is updated. If
// the network is unavailable (offline, spotty signal), the cached copy is
// served so the user at least sees the app shell.
//
// Strategy: NETWORK-FIRST for navigation requests, pass-through for all
// other requests. We deliberately do NOT cache the Supabase JS library
// (CDN, versioned by URL) or any API requests — those should always go
// through normally so the live data stays live.
//
// Lifecycle:
//   * install — skipWaiting() so a new SW activates immediately on next
//     page load instead of sitting in a "waiting" state behind the old one.
//   * activate — clients.claim() so the new SW takes control of all open
//     pages on activation, not just newly-opened ones.
//   * fetch — network-first for navigation, pass-through otherwise.
//
// CACHE_NAME bump strategy: change CACHE_NAME below if you ever need to
// force every user to drop their cached HTML on next visit (e.g. for a
// migration where the old cached version would break). Day-to-day pushes
// of payroll.html don't need this — network-first handles the freshening.
//
// FULL REMOVAL: see the unregister stub in payroll.html's registration
// block (commented out at the bottom). To remove the SW from a user's
// browser, deploy that stub as sw.js instead of this file; existing SWs
// will unregister themselves on next page load.
// ============================================================================

const CACHE_NAME = 'payroll-v1';

self.addEventListener('install', (event) => {
  // Take over immediately on first install — don't wait for existing tabs
  // to close. Safe here because the SW only does network-first, no
  // breaking-change interception.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Take control of all open pages immediately on activation.
    await self.clients.claim();

    // Clean up any old cache buckets (different CACHE_NAME from previous
    // versions). This only matters if CACHE_NAME has ever been bumped.
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter(k => k.startsWith('payroll-') && k !== CACHE_NAME)
        .map(k => caches.delete(k))
    );
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only intercept top-level navigation requests (i.e. loading the HTML
  // page itself). All other requests — Supabase API calls, storage
  // uploads, CDN scripts — pass through to the network untouched.
  // We check both `mode` and `destination` because Safari has been
  // inconsistent with mode='navigate' in some versions.
  const isNavigation =
    req.mode === 'navigate' ||
    (req.method === 'GET' && req.destination === 'document');

  if (!isNavigation) return;

  // Don't try to cache cross-origin requests (e.g. a navigation that's
  // somehow targeting another domain). Defensive — shouldn't happen in
  // practice.
  if (new URL(req.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      // Network first — always try fresh.
      const networkResponse = await fetch(req);

      // Cache a clone of the fresh response for offline fallback. Only
      // cache successful (2xx) responses to avoid caching 404/500 pages.
      if (networkResponse && networkResponse.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, networkResponse.clone()).catch(() => {
          // Cache write failure is non-fatal — user already has the
          // fresh response; we just don't get an offline copy this time.
        });
      }
      return networkResponse;
    } catch (networkErr) {
      // Network failed — try the cache. If neither works, the browser
      // shows its default "no internet" error, which is fine.
      const cached = await caches.match(req);
      if (cached) return cached;
      throw networkErr;
    }
  })());
});
