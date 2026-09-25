/* =============================================================================
 * Guardian — make this panel the Home Assistant landing page
 * -----------------------------------------------------------------------------
 * Settings → Dashboards only lists Lovelace dashboards (Overview / Home,
 * Lights, Energy, user-created YAML). Guardian is a panel_custom at
 * /guardian, so it can never appear on that screen. Home Assistant still
 * stores the landing page as frontend system data `core.default_panel`,
 * which may be any registered panel url_path — that is what "Set as
 * default" writes for the dashboards it *can* list.
 *
 * This module is loaded on every page via frontend.extra_module_url, not
 * only when Guardian is open. The first admin session after deploy writes
 * default_panel: "guardian" once, then sets guardian_primary_applied so a
 * later "Set as default" on Overview is not overwritten. Non-admins cannot
 * call frontend/set_system_data; they inherit the system default after an
 * admin has opened Home Assistant once.
 *
 * NO BUILD STEP. Plain ES module, no dependencies. Bump the ?v= on
 * extra_module_url in configuration.yaml in the same commit as this file,
 * together with the panel module's ?v= / GUARDIAN_UI_VERSION.
 * ========================================================================== */

const PANEL_URL_PATH = 'guardian';
const APPLIED_FLAG = 'guardian_primary_applied';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Exact matches only. The subpath tests that used to be here - startsWith
// '/home/' and '/lovelace/' - counted a view the household BUILT, like
// /lovelace/kitchen, as a "stock landing" and redirected away from it.
//
// The timing made that worse rather than rarer. waitForHass polls 200 x 100 ms
// before apply() ever reaches the redirect, so the yank could land up to twenty
// seconds after the page loaded - i.e. on someone who had already given up
// waiting and navigated to their own dashboard. A default landing page is a
// statement about where you START, and nothing here should have an opinion
// about where you went afterwards.
const isStockLanding = (path) =>
  path === '/' ||
  path === '/home' ||
  path === '/lovelace';

async function waitForHass() {
  await customElements.whenDefined('home-assistant');
  const el = document.querySelector('home-assistant');
  if (!el) return null;
  for (let i = 0; i < 200; i += 1) {
    const hass = el.hass;
    if (hass?.connection && hass.user && hass.systemData !== undefined) {
      return hass;
    }
    await wait(100);
  }
  return el.hass || null;
}

async function apply() {
  const hass = await waitForHass();
  if (!hass?.connection || !hass.user?.is_admin) return;
  const core = hass.systemData || {};
  if (core[APPLIED_FLAG]) return;
  if (!hass.panels?.[PANEL_URL_PATH]) return;

  try {
    await hass.connection.sendMessagePromise({
      type: 'frontend/set_system_data',
      key: 'core',
      value: {
        ...core,
        default_panel: PANEL_URL_PATH,
        [APPLIED_FLAG]: true,
      },
    });
  } catch (err) {
    console.warn('Guardian: could not set the system default panel', err);
    return;
  }

  // The first admin visit after deploy may already have routed to Overview.
  // Reload onto Guardian only from that stock landing, never from Settings.
  //
  // Re-checked here, not just at the top: apply() can take twenty seconds to
  // reach this line, and the user may well have navigated somewhere deliberate
  // in the meantime. The path that mattered is the one they are on NOW.
  //
  // assign, not replace. replace erases the page they were on from history, so
  // a redirect they did not ask for also took away the Back button that would
  // have undone it. This happens at most once per install; leaving a history
  // entry behind costs nothing and keeps it reversible.
  if (isStockLanding(window.location.pathname)) {
    window.location.assign(`/${PANEL_URL_PATH}`);
  }
}

apply();
