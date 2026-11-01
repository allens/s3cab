// The OS switcher's tabs (config.mjs's `osVariants` writes them). The choice is
// the `data-os` on `<html>`, which the stylesheet reads to show one variant,
// so every example on every page follows it; config.mjs's `osChoice` sets it
// before the first paint. This keeps the tabs' ARIA state in step with it,
// stores a new choice, and gives the tabs their arrow keys.

// The DOM types reach the whole type check from here, src/ included; ESLint's
// globals are what keep `document` out of the Node code.
/// <reference lib="dom" />

import { nextTick, onMounted, watch } from "vue";
import { useRoute } from "vitepress";

// Also read by config.mjs's `osChoice`.
const KEY = "s3cab-os";

const TAB = ".os-tabs [role=tab]";

/** Marks the chosen tab in every tab list, and leaves only it in the tab order. */
function sync() {
  for (const tab of document.querySelectorAll(TAB)) {
    const chosen =
      tab instanceof HTMLElement &&
      tab.dataset.os === document.documentElement.dataset.os;
    tab.setAttribute("aria-selected", String(chosen));
    tab.setAttribute("tabindex", chosen ? "0" : "-1");
  }
}

/** @param {string} os */
function choose(os) {
  document.documentElement.dataset.os = os;
  try {
    localStorage.setItem(KEY, os);
  } catch {
    // Storage blocked: the choice lasts until the next full page load.
  }
  sync();
}

/**
 * The tab an event happened on, if any.
 * @param {Event} event
 */
const tabOf = (event) =>
  event.target instanceof Element ? event.target.closest(TAB) : null;

/** @param {MouseEvent} event */
function onClick(event) {
  const tab = tabOf(event);
  if (tab instanceof HTMLElement && tab.dataset.os) {
    choose(tab.dataset.os);
  }
}

/** @param {KeyboardEvent} event */
function onKeydown(event) {
  const tab = tabOf(event);
  const tabs = tab?.parentElement?.querySelectorAll(TAB);
  // Alt+Left is the browser's back, Ctrl+Home the page's top.
  if (!tab || !tabs || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  const at = [...tabs].indexOf(tab);
  /** @type {Record<string, number>} */
  const keys = {
    ArrowLeft: at - 1,
    ArrowRight: at + 1,
    Home: 0,
    End: tabs.length - 1,
  };
  const to = keys[event.key];
  const next =
    to === undefined ? undefined : tabs[(to + tabs.length) % tabs.length];
  if (next instanceof HTMLElement && next.dataset.os) {
    event.preventDefault();
    choose(next.dataset.os);
    next.focus();
  }
}

/** The theme's `setup`: runs once, in the app's root component. */
export function osSwitch() {
  const route = useRoute();
  onMounted(() => {
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeydown);
    sync();
  });
  watch(
    () => route.path,
    () => nextTick(sync),
  );
}
