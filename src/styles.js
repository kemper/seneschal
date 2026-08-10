/**
 * styles.js — CSS for the palette, injected into the shadow root.
 *
 * Kept as a JS string rather than a .css file so it needs no
 * web_accessible_resources entry and cannot flash unstyled while it loads.
 * Shadow DOM keeps the page's stylesheet out; the explicit font/colour on
 * .sen-modal keeps inherited properties out too.
 */
(function () {
  "use strict";

  const SEN = (globalThis.SEN = globalThis.SEN || {});

  SEN.styles = `
:host { all: initial; }

.sen-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 14vh;
  background: rgba(6, 8, 12, 0.68);
  /* No backdrop-filter. A full-screen blur is recomposited every frame over
     whatever the game is animating underneath, which is real GPU work for a
     decorative effect — and it is felt most on exactly the machines that can
     least afford it. A slightly darker scrim reads the same. */
  animation: sen-fade 60ms ease-out;
}

/* An author display rule beats the UA stylesheet's [hidden]{display:none},
   so the hidden state has to be restated here or the palette never closes. */
.sen-overlay[hidden] { display: none; }

@keyframes sen-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes sen-rise { from { opacity: 0; transform: translateY(-6px) } to { opacity: 1; transform: none } }

.sen-modal {
  width: min(640px, 92vw);
  max-height: 62vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid #2c333f;
  border-radius: 12px;
  background: #14181f;
  color: #e6e9ef;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  animation: sen-rise 70ms ease-out;
}

.sen-inputrow {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid #232a34;
}

.sen-prompt { color: #d9a441; font-weight: 700; flex: none; }

.sen-input {
  flex: 1;
  border: 0;
  outline: 0;
  background: transparent;
  color: #e6e9ef;
  font: inherit;
  padding: 0;
}
.sen-input::placeholder { color: #6b7686; }

.sen-list {
  overflow-y: auto;
  padding: 6px 0;
  scrollbar-width: thin;
  scrollbar-color: #39424f transparent;
}
.sen-list::-webkit-scrollbar { width: 10px }
.sen-list::-webkit-scrollbar-thumb { background: #39424f; border-radius: 6px; border: 3px solid #14181f }

.sen-group {
  padding: 8px 16px 4px;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: #6b7686;
}

.sen-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  cursor: pointer;
  border-left: 2px solid transparent;
}
.sen-item[aria-selected="true"] {
  background: #1d2430;
  border-left-color: #d9a441;
}

.sen-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sen-label mark { background: transparent; color: #f0b750; font-weight: 700; }

.sen-path {
  flex: none;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px;
  color: #6b7686;
}
.sen-badge {
  flex: none;
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #7d8798;
  border: 1px solid #2c333f;
  border-radius: 999px;
  padding: 1px 7px;
}

.sen-empty { padding: 22px 16px; text-align: center; color: #6b7686; }

.sen-footer {
  display: flex;
  gap: 14px;
  padding: 8px 14px;
  border-top: 1px solid #232a34;
  font-size: 11.5px;
  color: #6b7686;
}
.sen-footer kbd {
  font-family: inherit;
  background: #1d2430;
  border: 1px solid #2c333f;
  border-radius: 4px;
  padding: 1px 5px;
  margin-right: 4px;
  color: #99a3b3;
}

/* --- pending state -------------------------------------------------------
   Shown while an action (as opposed to a plain jump) is in flight. A jump
   needs no indicator because the page itself visibly changes; an action can
   take seconds and leave the screen looking untouched, which reads as "my
   keypress did nothing". */
.sen-status {
  display: none;
  align-items: center;
  gap: 9px;
  padding: 11px 14px;
  border-top: 1px solid #232a34;
  font-size: 13px;
  color: #cbd2dd;
}
.sen-status[data-state] { display: flex }
.sen-status[data-state="error"] { color: #f0906b }
.sen-status[data-state="done"]  { color: #7fc98a }

.sen-spinner {
  width: 13px;
  height: 13px;
  flex: none;
  border-radius: 50%;
  border: 2px solid #39414f;
  border-top-color: #d9a441;
  animation: sen-spin 720ms linear infinite;
}
/* Success and failure are settled states — a still-spinning ring next to
   "Healed" would claim work is continuing. */
.sen-status[data-state="done"]  .sen-spinner,
.sen-status[data-state="error"] .sen-spinner { display: none }
.sen-status .sen-mark { flex: none; font-size: 13px }

@keyframes sen-spin { to { transform: rotate(360deg) } }

/* While busy the list is inert: dimmed, and pointer events off so a stray
   click cannot fire a second action. Keyboard is blocked in palette.js. */
.sen-modal[aria-busy="true"] .sen-list { opacity: .4; pointer-events: none }
.sen-modal[aria-busy="true"] .sen-input { color: #6b7686 }

@media (prefers-reduced-motion: reduce) {
  .sen-overlay, .sen-modal { animation: none }
  /* Keep a non-moving indicator rather than removing the affordance: the
     ring stays, it simply pulses instead of rotating. */
  .sen-spinner {
    animation: sen-pulse 1.4s ease-in-out infinite;
    border-top-color: #39414f;
    background: #d9a441;
  }
  @keyframes sen-pulse { 50% { opacity: .35 } }
}
`;
})();
