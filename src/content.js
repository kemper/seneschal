/**
 * content.js — entry point. Wires Cmd-K / Ctrl-K to the palette and mounts the
 * floating quick menu.
 */
(function () {
  "use strict";

  const SEN = globalThis.SEN;
  if (!SEN || !SEN.Palette) return;
  if (globalThis.__seneschalInstalled) return; // guard against double injection
  globalThis.__seneschalInstalled = true;

  const palette = new SEN.Palette();
  palette.init();

  // The dock is independent of the palette: if one throws while starting up,
  // the other still works.
  let dock = null;
  try {
    dock = new SEN.Dock();
    dock.init();
  } catch (e) {
    console.warn("[Seneschal] quick menu failed to start:", e);
  }

  function isToggleChord(e) {
    if (e.key !== "k" && e.key !== "K") return false;
    return e.metaKey || e.ctrlKey;
  }

  // Capture phase so we win the chord even if the game binds Cmd-K itself or
  // focus is sitting inside one of its inputs.
  window.addEventListener(
    "keydown",
    (e) => {
      if (!isToggleChord(e)) return;
      // Switched off in the extension: leave the chord alone entirely, rather
      // than swallowing it and doing nothing.
      if (!palette.enabled) return;
      e.preventDefault();
      e.stopPropagation();
      palette.toggle();
    },
    true
  );

  // Handy for poking at the index from DevTools while developing.
  globalThis.__seneschal = palette;
  globalThis.__seneschalDock = dock;
})();
