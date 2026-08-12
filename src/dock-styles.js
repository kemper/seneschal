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
  /* A column flex sizes to its widest child's max-content, so one long line —
     the heal-all price quote — would stretch the whole rail across the page.
     Cap it and let text wrap instead. */
  max-width: 260px;
  background: rgba(20, 24, 31, 0.94);
  border: 1px solid #2c333f;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(3px);
  max-height: 86vh;
  /* The rail itself never scrolls: its children do. Scrolling the whole thing
     pushed the hero panel and the tools below the fold once the menu grew
     past about eight entries. */
  overflow: hidden;
  scrollbar-width: thin;
  scrollbar-color: #39424f transparent;
}

/* The link list surrenders space first — a link you can scroll to is a much
   smaller loss than a heal button you cannot see. min-height:0 is what lets a
   flex child shrink below its content at all. */
.dk-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  flex: 0 100 auto;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #39424f transparent;
}
/* The rites sit OUTSIDE the scroller and never shrink, for the same reason the
   heal buttons do not: this row carries the soul and raisable-dead reading, and
   a number you have to scroll to find is a number you will not look at. */
.dk-sep, .dk-tools, .dk-rites { flex: 0 0 auto; }
.dk-rites { display: flex; flex-direction: column; gap: 2px; }
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

/* --- confirm panel -------------------------------------------------------- */

/* Native confirm()/alert() are banned in this extension. They are browser
   chrome, so they read as Chrome asking rather than us; they cannot be styled
   or placed; they freeze the page and every timer on it; and under automation
   they hang the session. Questions are asked here, beside the rail, in the
   extension's own voice — same side as the add form, opening inward. */
.dk-ask {
  width: 226px;
  padding: 12px;
  border: 1px solid #2c333f;
  border-radius: 10px;
  background: #14181f;
  box-shadow: 0 18px 44px rgba(0, 0, 0, 0.55);
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-self: center;
}
.dk-ask[hidden] { display: none; }
.dk-right .dk-ask { margin-right: 10px; }
.dk-left  .dk-ask { margin-left: 10px; }

.dk-ask h2 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 700;
  color: #e6e9ef;
  letter-spacing: 0.01em;
}
.dk-ask-body { margin: 0; font-size: 11.5px; line-height: 1.45; color: #9aa4b2; }
.dk-ask-body[hidden] { display: none; }
.dk-ask .dk-ask-yes:focus-visible { outline: 2px solid #f0c674; outline-offset: 2px; }

/* --- hero panel ---------------------------------------------------------- */

.dk-heroes {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding-top: 2px;
  position: relative;
  /* Shrinks only after the link list has given up what it can, and scrolls
     itself rather than pushing the tools off the rail. */
  min-height: 0;
  flex: 0 1 auto;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: #39424f transparent;
}
.dk-heroes[hidden] { display: none; }

/* Refreshing: the last known roster stays put and is dimmed, rather than being
   replaced by a placeholder. Every navigation is a full page load, so a
   placeholder here would flash on every single page. */
.dk-heroes.dk-refreshing .dk-hero,
.dk-heroes.dk-refreshing .dk-bar { opacity: 0.45; transition: opacity 120ms ease-out; }
.dk-heroes.dk-refreshing .dk-heal { pointer-events: none; }

.dk-heroes::after {
  content: "";
  position: absolute;
  top: 6px;
  right: 10px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #d9a441;
  opacity: 0;
}
.dk-left .dk-heroes::after { right: auto; left: 10px; }
.dk-heroes.dk-refreshing::after { opacity: 1; animation: dk-pulse 900ms ease-in-out infinite; }
@keyframes dk-pulse { 0%, 100% { opacity: 0.25 } 50% { opacity: 1 } }
@media (prefers-reduced-motion: reduce) {
  .dk-heroes.dk-refreshing::after { animation: none; opacity: 0.8 }
}

.dk-hero { display: flex; align-items: center; gap: 7px; padding: 3px 10px; }
.dk-left .dk-hero { flex-direction: row-reverse; }
.dk-hero-name { flex: 1; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dk-hero-hp { flex: none; font-size: 10.5px; color: #7d8798; font-variant-numeric: tabular-nums; }

.dk-bar { height: 3px; border-radius: 2px; background: #2c333f; overflow: hidden; margin: 0 10px 2px; }
/* Collapsed means ICONS ONLY. Anything with running text has to go, or it
   holds the rail open at full width and the collapse does nothing visible —
   the siege picker is nowrap, so it was the widest thing in here. */
.dk-wrap.dk-collapsed .dk-bar,
.dk-wrap.dk-collapsed .dk-hero-name,
.dk-wrap.dk-collapsed .dk-hero-hp,
.dk-wrap.dk-collapsed .dk-siege { display: none; }
.dk-wrap.dk-collapsed .dk-hero { justify-content: center; gap: 4px; padding: 3px 8px; }
.dk-wrap.dk-collapsed .dk-heroes::after { top: 2px; right: 4px; }
.dk-left .dk-wrap.dk-collapsed .dk-heroes::after { left: 4px; right: auto; }
.dk-bar-fill { height: 100%; background: #5fa564; transition: width 180ms ease-out; }
.dk-bar-fill.dk-hurt { background: #d9a441; }
.dk-bar-fill.dk-bad { background: #d16a5a; }

/* The heal control is the only thing here that spends anything, so it reads as
   an action rather than as decoration, and it disappears at full health. */
.dk-heal {
  flex: none;
  border: 1px solid #3c4553;
  border-radius: 5px;
  background: #1d2430;
  color: #cbd2dd;
  font: inherit;
  font-size: 10.5px;
  padding: 1px 6px;
  cursor: pointer;
}
.dk-heal:hover:not(:disabled) { border-color: #d9a441; color: #f0b750; }
.dk-heal:disabled { opacity: 0.35; cursor: default; }
.dk-heal.dk-busy { color: #d9a441; }

.dk-siege {
  margin: 4px 10px 2px;
  font-size: 10.5px;
  color: #7d8798;
  background: #1a1f28;
  border: 1px solid #2c333f;
  border-radius: 5px;
  padding: 3px 7px;
  cursor: pointer;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dk-siege:hover:not(:disabled) { color: #f0b750; border-color: #d9a441; }
.dk-siege:disabled { opacity: 0.6; cursor: default; }
.dk-siege[hidden] { display: none; }

/* One button per healing method, under the hero's bar. Icons only, but every
   one carries a title naming the elixir, what it mends, what you hold and what
   brewing would cost. */
.dk-methods { display: flex; gap: 3px; margin: 0 10px 4px; flex-wrap: wrap; }
.dk-left .dk-methods { justify-content: flex-end; }
.dk-wrap.dk-collapsed .dk-methods { margin: 0 4px 3px; justify-content: center; }

.dk-method {
  flex: none;
  border: 1px solid #3c4553;
  border-radius: 5px;
  background: #1d2430;
  color: #cbd2dd;
  font: inherit;
  font-size: 11px;
  line-height: 1.2;
  padding: 2px 6px;
  cursor: pointer;
}
.dk-method:hover:not(:disabled) { border-color: #d9a441; color: #f0b750; }
.dk-method:disabled { opacity: 0.3; cursor: default; }
.dk-method.dk-busy { color: #d9a441; border-color: #d9a441; }

/* Heal all: the game's own control, mirrored. Reads as an action, and carries
   the game's own price quote underneath rather than one we computed. */
.dk-healall {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  box-sizing: border-box;
  margin: 2px 0;
  padding: 5px 10px;
  border: 1px solid #3a5c40;
  border-radius: 7px;
  background: #16241a;
  color: #9fd3a6;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.dk-left .dk-healall { flex-direction: row-reverse; text-align: right; }
.dk-healall:hover:not(:disabled) { border-color: #5fa564; color: #c6ecc9; }
.dk-healall:disabled { opacity: 0.4; cursor: default; }
.dk-healall.dk-busy { color: #d9a441; border-color: #d9a441; }
.dk-wrap.dk-collapsed .dk-healall { justify-content: center; padding: 5px 8px; }

.dk-quote {
  margin: 0 10px 4px;
  font-size: 10px;
  line-height: 1.35;
  color: #6b7686;
  white-space: normal;
  overflow-wrap: anywhere;
}
.dk-wrap.dk-collapsed .dk-quote { display: none; }

/* --- toast ---------------------------------------------------------------- */

/* Sits BELOW the rail, on the same side, and is a sibling of .dk-wrap rather
   than a child of it. That is not cosmetic: .dk-wrap is transformed to centre
   itself, and a transformed ancestor becomes the containing block for
   position: fixed descendants — nested inside, this box positioned itself
   against the rail and covered the menu. */
.dk-toast {
  position: fixed;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(360px, 46vw);
  z-index: 2147483001;
  padding: 8px 13px;
  border: 1px solid #2c333f;
  border-radius: 8px;
  background: #1a1f28;
  color: #cbd2dd;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 12.5px;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
}
.dk-toast[hidden] { display: none; }

/* Failures are LOUD by design: a pattern that stops matching after a patch has
   to be visible, not a button that quietly does nothing. Warnings are coloured
   and stay up far longer than a confirmation does. */
.dk-toast.dk-warn {
  border-color: #6d4b2c;
  background: #241a12;
  color: #f0c88a;
  max-width: min(460px, 70vw);
}

/* --- soul balance badge --------------------------------------------------
   The rites panel is the only place the game renders a soul count, and no API
   carries it, so this is the LAST READING rather than a live number. Age is in
   the button's tooltip; past an hour the badge greys to say so at a glance. */
.dk-count {
  margin-left: auto;
  padding: 1px 6px;
  border: 1px solid #3a4250;
  border-radius: 999px;
  background: #1b212b;
  color: #cbb27a;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.dk-count.dk-stale { color: #6b7686; border-color: #2c333f; }
.dk-collapsed .dk-count { display: none; }

/* --- confirmation sheet ---------------------------------------------------
   Raising a host spends souls, and covering a shortfall sacrifices veterans.
   Neither happens without this on screen first, showing the numbers actually
   read off the page. */
.dk-scrim {
  position: fixed;
  inset: 0;
  z-index: 2147483002;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(6, 8, 12, .72);
}
.dk-scrim[hidden] { display: none; }

.dk-sheet {
  width: min(420px, 100%);
  box-sizing: border-box;
  padding: 16px 18px;
  border: 1px solid #2c333f;
  border-radius: 12px;
  background: #14181f;
  box-shadow: 0 24px 60px rgba(0, 0, 0, .6);
}
.dk-sheet h2 { margin: 0 0 12px; font-size: 14px; color: #e6e9ef; }

.dk-read { margin: 0 0 12px; display: flex; gap: 18px; flex-wrap: wrap; }
.dk-read[hidden] { display: none; }
.dk-read div { display: flex; flex-direction: column; gap: 2px; }
.dk-read dt {
  font-size: 10px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: #6b7686;
}
.dk-read dd {
  margin: 0;
  font-size: 15px;
  color: #e6e9ef;
  font-variant-numeric: tabular-nums;
}

.dk-sheet-body { margin: 0 0 10px; font-size: 12.5px; color: #cbd2dd; }
.dk-sheet-warn {
  margin: 0 0 12px;
  padding: 8px 10px;
  border: 1px solid #6d4b2c;
  border-radius: 8px;
  background: #241a12;
  color: #f0c88a;
  font-size: 12px;
}
.dk-sheet-warn[hidden] { display: none; }

.dk-sheet-actions { flex-wrap: wrap; }
.dk-actions .dk-danger {
  background: #7d2f22;
  border-color: #9c3b2b;
  color: #ffe6df;
}

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
