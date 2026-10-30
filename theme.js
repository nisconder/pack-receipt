(function () {
  "use strict";

  const root = document.documentElement;
  const storageKey = "pack-receipt.theme";
  const choices = ["system", "light", "dark"];
  const labels = { system: "跟随系统", light: "浅色", dark: "深色" };
  const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  let preference = "system";

  try {
    const saved = window.localStorage.getItem(storageKey);
    if (choices.includes(saved)) preference = saved;
  } catch (_) {
    // Local file URLs and privacy modes can deny optional preference storage.
  }

  function apply(next, persist) {
    preference = choices.includes(next) ? next : "system";
    const theme = preference === "system" ? (media && media.matches ? "dark" : "light") : preference;
    const changed = root.dataset.theme !== theme || root.dataset.themePreference !== preference;
    root.dataset.theme = theme;
    root.dataset.themePreference = preference;
    const select = document.getElementById("theme-select");
    if (select) select.value = preference;
    const toggle = document.getElementById("theme-toggle");
    if (toggle) {
      const nextPreference = choices[(choices.indexOf(preference) + 1) % choices.length];
      toggle.title = `当前：${labels[preference]}；切换为${labels[nextPreference]}`;
      toggle.setAttribute("aria-label", toggle.title);
    }
    if (persist) {
      try { window.localStorage.setItem(storageKey, preference); } catch (_) { /* File data is never stored. */ }
    }
    if (changed) window.dispatchEvent(new CustomEvent("pack-theme-change", { detail: { preference, theme } }));
  }

  // Execute before the stylesheet loads to avoid a flash of the wrong theme.
  apply(preference, false);

  function attachControls() {
    const select = document.getElementById("theme-select");
    if (select) select.addEventListener("change", function () { apply(select.value, true); });
    const toggle = document.getElementById("theme-toggle");
    if (toggle) toggle.addEventListener("click", function () { apply(choices[(choices.indexOf(preference) + 1) % choices.length], true); });
    apply(preference, false);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", attachControls, { once: true });
  else attachControls();

  function systemChanged() {
    if (preference === "system") apply("system", false);
  }
  if (media && typeof media.addEventListener === "function") media.addEventListener("change", systemChanged);
  else if (media && typeof media.addListener === "function") media.addListener(systemChanged);

  window.addEventListener("storage", function (event) {
    if (event.key === storageKey) apply(event.newValue, false);
    else if (event.key === null) apply("system", false);
  });
})();
