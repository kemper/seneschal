/**
 * content.js — entry point. Wires Cmd-K / Ctrl-K to the palette.
 */
(function () {
  "use strict";

  const SEN = globalThis.SEN;
  if (!SEN || !SEN.Palette) return;
  if (globalThis.__seneschalInstalled) return; // guard against double injection
  globalThis.__seneschalInstalled = true;

  const palette = new SEN.Palette();
  palette.init();

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
      e.preventDefault();
      e.stopPropagation();
      palette.toggle();
    },
    true
  );

  // Handy for poking at the index from DevTools while developing.
  globalThis.__seneschal = palette;
})();
