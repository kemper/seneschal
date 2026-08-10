/**
 * dock-styles.js — CSS for the floating quick menu, injected into its own
 * shadow root.
 *
 * Same reasoning as styles.js: a JS string needs no web_accessible_resources
 * entry and cannot flash unstyled. Note the [hidden] restatements — an author
 * `display` rule beats the UA stylesheet's `[hidden] { display: none }`, which
 * is exactly the bug that once stopped the palette from closing.
 *
 * (Avoid backticks anywhere in here, including in comments: this whole sheet
 *  is one template literal.)
 */
(function () {
  "use strict";

  const SEN = (globalThis.SEN = globalThis.SEN || {});

  SEN.dockStyles = `
:host { all: initial; }

.dk-wrap {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  /* Under the palette's overlay, above everything the game draws. */
  z-index: 2147483000;
  display: flex;
  align-items: center;
  /* No gap: the tab has to sit flush against the rail, which in turn sits
     flush against the screen edge. The form spaces itself with a margin. */
  gap: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  color: #e6e9ef;
}
.dk-wrap[hidden] { display: none; }

.dk-wrap.dk-right { right: 0; flex-direction: row; }
.dk-wrap.dk-left  { left: 0;  flex-direction: row-reverse; }

.dk-rail {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  background: rgba(20, 24, 31, 0.94);
  border: 1px solid #2c333f;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(3px);
  max-height: 86vh;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #39424f transparent;
}
.dk-right .dk-rail { border-right: 0; border-radius: 10px 0 0 10px; }
.dk-left  .dk-rail { border-left: 0;  border-radius: 0 10px 10px 0; }

.dk-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: #cbd2dd;
  font: inherit;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.dk-left .dk-btn { flex-direction: row-reverse; text-align: right; }
.dk-btn:hover, .dk-btn:focus-visible { background: #1d2430; color: #f2f5fa; outline: 0; }
.dk-btn:focus-visible { box-shadow: inset 0 0 0 1px #d9a441; }

.dk-icon {
  flex: none;
  width: 18px;
  text-align: center;
  font-size: 14px;
}
.dk-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* Collapsed: icons only. The label stays in the DOM for screen readers and
   for the native tooltip, it just stops taking horizontal space. */
.dk-wrap.dk-collapsed .dk-text { display: none; }
.dk-wrap.dk-collapsed .dk-btn { justify-content: center; padding: 6px 8px; }

.dk-sep { height: 1px; margin: 4px 2px; background: #2c333f; }

.dk-tools { display: flex; gap: 2px; }
.dk-wrap.dk-collapsed .dk-tools { flex-direction: column; }
.dk-tools .dk-btn { justify-content: center; padding: 5px 8px; color: #7d8798; }
.dk-tools .dk-btn:hover { color: #e6e9ef; }

/* The pull tab: always visible, so a hidden rail can always be brought back. */
.dk-tab {
  flex: none;
  border: 1px solid #2c333f;
  background: rgba(20, 24, 31, 0.94);
  color: #7d8798;
  font: inherit;
  font-size: 11px;
  padding: 14px 3px;
  cursor: pointer;
  writing-mode: vertical-rl;
}
.dk-right .dk-tab { border-right: 0; border-radius: 8px 0 0 8px; }
.dk-left  .dk-tab { border-left: 0;  border-radius: 0 8px 8px 0; }
.dk-tab:hover { color: #e6e9ef; }

/* --- add form ------------------------------------------------------------ */

.dk-form {
  width: 250px;
  padding: 12px;
  border: 1px solid #2c333f;
  border-radius: 10px;
  background: #14181f;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dk-form[hidden] { display: none; }
.dk-right .dk-form { margin-right: 10px; }
.dk-left  .dk-form { margin-left: 10px; }

.dk-form h2 {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #6b7686;
}
.dk-field { display: flex; flex-direction: column; gap: 3px; }
.dk-field label { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7686; }
.dk-field input, .dk-field select {
  border: 1px solid #2c333f;
  border-radius: 6px;
  background: #0f131a;
  color: #e6e9ef;
  font: inherit;
  font-size: 12.5px;
  padding: 5px 7px;
  box-sizing: border-box;
  width: 100%;
}
.dk-field input:focus, .dk-field select:focus { outline: 0; border-color: #d9a441; }
.dk-hint { font-size: 10.5px; color: #6b7686; }
.dk-field[hidden] { display: none; }

.dk-error { font-size: 11.5px; color: #e2705f; }
.dk-error[hidden] { display: none; }

.dk-actions { display: flex; gap: 6px; justify-content: flex-end; }
.dk-actions button {
  border: 1px solid #2c333f;
  border-radius: 6px;
  background: #1d2430;
  color: #cbd2dd;
  font: inherit;
  font-size: 12px;
  padding: 4px 12px;
  cursor: pointer;
}
.dk-actions .dk-primary { background: #d9a441; border-color: #d9a441; color: #17181b; font-weight: 600; }

/* --- toast ---------------------------------------------------------------- */

/* Failures are LOUD by design: a pattern that stops matching after a patch has
   to be visible, not a button that quietly does nothing. */
.dk-toast {
  position: fixed;
  bottom: 18px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(460px, 90vw);
  z-index: 2147483001;
  padding: 9px 14px;
  border: 1px solid #6d4b2c;
  border-radius: 8px;
  background: #241a12;
  color: #f0c88a;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 12.5px;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
}
.dk-toast[hidden] { display: none; }

/* --- in-flight entry -----------------------------------------------------
   A menu entry walks to its door and then waits for the control to appear,
   which can take seconds. The icon becomes a spinner for that window so the
   click does not read as having done nothing. */
.dk-spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, .22);
  border-top-color: #d9a441;
  animation: dk-spin 720ms linear infinite;
}
.dk-btn[data-busy="true"] { color: #d9a441 }
@keyframes dk-spin { to { transform: rotate(360deg) } }

@media (prefers-reduced-motion: reduce) {
  .dk-wrap, .dk-toast { transition: none }
  /* Keep the affordance, drop the rotation. */
  .dk-spinner {
    animation: dk-pulse 1.4s ease-in-out infinite;
    border-top-color: rgba(255, 255, 255, .22);
    background: #d9a441;
  }
  @keyframes dk-pulse { 50% { opacity: .35 } }
}
`;
})();
