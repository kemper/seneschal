/**
 * popup.js — the toolbar popup.
 *
 * Just enough to switch each surface on or off without hunting through the
 * options page. Both surfaces watch chrome.storage, so a flick here lands in
 * every open Wardenfall tab immediately.
 */
(function () {
  "use strict";

  const CFG = globalThis.SEN.config;

  const els = {
    palette: document.getElementById("palette"),
    dock: document.getElementById("dock"),
    heroes: document.getElementById("heroes"),
    side: document.getElementById("side"),
    options: document.getElementById("options"),
    status: document.getElementById("status"),
  };

  let settings = CFG.defaults();

  function paint() {
    els.palette.checked = settings.palette.enabled;
    els.dock.checked = settings.dock.enabled;
    els.heroes.checked = settings.heroes.enabled;
    els.side.textContent = settings.dock.side === "left" ? "Move to the right" : "Move to the left";
    els.side.disabled = !settings.dock.enabled;
  }

  async function save(message) {
    try {
      await chrome.storage.local.set({ [CFG.STORAGE_KEY]: settings });
      els.status.textContent = message;
    } catch (e) {
      els.status.textContent = `Could not save: ${e.message}`;
    }
    paint();
  }

  els.palette.addEventListener("change", () => {
    settings.palette = { ...settings.palette, enabled: els.palette.checked };
    save(els.palette.checked ? "Command palette on." : "Command palette off.");
  });

  els.dock.addEventListener("change", () => {
    settings.dock = { ...settings.dock, enabled: els.dock.checked };
    save(els.dock.checked ? "Quick menu on." : "Quick menu hidden.");
  });

  els.heroes.addEventListener("change", () => {
    settings.heroes = { ...settings.heroes, enabled: els.heroes.checked };
    save(els.heroes.checked ? "Hero panel on." : "Hero panel off.");
  });

  els.side.addEventListener("click", () => {
    const side = settings.dock.side === "left" ? "right" : "left";
    settings.dock = { ...settings.dock, side };
    save(`Quick menu moved to the ${side}.`);
  });

  els.options.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  (async () => {
    let stored = null;
    try {
      stored = (await chrome.storage.local.get(CFG.STORAGE_KEY))?.[CFG.STORAGE_KEY] ?? null;
    } catch {
      els.status.textContent = "Could not read saved settings; showing the defaults.";
    }
    settings = CFG.normalize(stored).config;
    paint();
  })();
})();
