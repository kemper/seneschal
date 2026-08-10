/**
 * palette.js — the Cmd-K modal: index, filter, render, activate.
 *
 * Lives entirely inside a shadow root so the game's CSS cannot reach in and
 * ours cannot leak out.
 */
(function () {
  "use strict";

  const SEN = (globalThis.SEN = globalThis.SEN || {});
  const MAX_RESULTS = 40;
  const LEARNED_KEY = "seneschal.learned.v1";
  const FRECENCY_KEY = "seneschal.frecency.v1";
  // How long an action may run before the status line admits it is slow, and
  // how long a success message stays up before the palette closes itself.
  const SLOW_AFTER_MS = 8000;
  const DONE_LINGER_MS = 900;

  // How long the DOM has to stay still before we rebuild the index. The game
  // re-renders its boards on a timer, so rebuilding on every mutation would
  // burn CPU continuously; waiting for a lull costs nothing, because the index
  // is only ever needed when you press Cmd-K.
  const REBUILD_QUIET_MS = 700;

  const onIdle =
    globalThis.requestIdleCallback?.bind(globalThis) || ((fn) => setTimeout(fn, 0));

  // --- persistence ---------------------------------------------------------
  // chrome.storage is async and may be unavailable (e.g. when the file is
  // opened outside an extension context), so every access is guarded.
  const store = {
    async get(key, fallback) {
      try {
        const out = await chrome.storage.local.get(key);
        return out?.[key] ?? fallback;
      } catch {
        return fallback;
      }
    },
    async set(key, value) {
      try {
        await chrome.storage.local.set({ [key]: value });
      } catch {
        /* non-fatal: the palette still works, it just forgets */
      }
    },
  };

  class Palette {
    constructor() {
      this.open = false;
      this.items = [];
      this.results = [];
      this.cursor = 0;
      this.rows = [];   // the rendered rows, so cursor moves need no lookup
      this.query = "";
      this.learned = {};   // key -> {label, path, group}  (nav seen in the past)
      this.frecency = {};  // key -> {n, last}
      this.lastFocus = null;
      // Switched off from the toolbar popup or the options page. Default on, so
      // a storage read that fails never leaves the user without the palette.
      this.enabled = true;
      // The index is kept warm in the background; `stale` says whether the page
      // has changed since it was built.
      this.stale = true;
      this.rebuildTimer = null;
      this._build();
    }

    async init() {
      this.learned = this._prune(await store.get(LEARNED_KEY, {}));
      this.frecency = await store.get(FRECENCY_KEY, {});
      this._applySettings(await store.get(SEN.config.STORAGE_KEY, null));

      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local" || !changes[SEN.config.STORAGE_KEY]) return;
          this._applySettings(changes[SEN.config.STORAGE_KEY].newValue);
        });
      } catch {
        /* no live sync; a reload still picks the setting up */
      }

      // Build the index up front — this also learns the current page's sub-nav,
      // so the very first Cmd-K already knows about it — and then keep it warm
      // in the background. show() must never scan: scanning is the expensive
      // part, and doing it on the keystroke is what made the palette feel slow.
      this._rebuild();
      this._watchForChanges();
    }

    /**
     * Rebuild the index off the interaction path. Skipped while the palette is
     * open (the list would shift under the cursor) and while the tab is in the
     * background; `stale` stays set, so show() picks the work up if it must.
     */
    _rebuild() {
      if (this.open) return;
      this.items = this._index();
      this.stale = false;
    }

    /** Mark the index stale when the page changes, and refresh it once it settles. */
    _watchForChanges() {
      const observer = new MutationObserver(() => {
        this.stale = true;
        clearTimeout(this.rebuildTimer);
        this.rebuildTimer = setTimeout(() => {
          if (this.open || document.hidden) return; // try again after the next change
          onIdle(() => {
            if (this.stale) this._rebuild();
          });
        }, REBUILD_QUIET_MS);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    /** Adopt the on/off switch, closing the palette if it was just turned off. */
    _applySettings(stored) {
      this.enabled = SEN.config.normalize(stored).config.palette.enabled;
      if (!this.enabled && this.open) this.hide();
    }

    // --- DOM ---------------------------------------------------------------
    _build() {
      this.host = document.createElement("div");
      this.host.id = "seneschal-root";
      // Tags the subtree as ours, so the scanner never indexes our own UI.
      this.host.setAttribute("data-seneschal", "palette");
      this.root = this.host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = SEN.styles;

      this.overlay = document.createElement("div");
      this.overlay.className = "sen-overlay";
      this.overlay.hidden = true;
      this.overlay.innerHTML = `
        <div class="sen-modal" role="dialog" aria-modal="true" aria-label="Seneschal command palette">
          <div class="sen-inputrow">
            <span class="sen-prompt" aria-hidden="true">&gt;</span>
            <input class="sen-input" type="text" spellcheck="false" autocomplete="off"
                   placeholder="Jump to…" aria-label="Search destinations"
                   role="combobox" aria-expanded="true" aria-controls="sen-list" />
          </div>
          <div class="sen-list" id="sen-list" role="listbox"></div>
          <div class="sen-status" role="status" aria-live="polite">
            <span class="sen-spinner" aria-hidden="true"></span>
            <span class="sen-mark" aria-hidden="true"></span>
            <span class="sen-statustext"></span>
          </div>
          <div class="sen-footer">
            <span><kbd>&uarr;&darr;</kbd>navigate</span>
            <span><kbd>&#8629;</kbd>open</span>
            <span><kbd>esc</kbd>close</span>
          </div>
        </div>`;

      this.root.append(style, this.overlay);
      this.input = this.root.querySelector(".sen-input");
      this.list = this.root.querySelector(".sen-list");
      this.modal = this.root.querySelector(".sen-modal");
      this.status = this.root.querySelector(".sen-status");
      this.statusText = this.root.querySelector(".sen-statustext");
      this.statusMark = this.root.querySelector(".sen-mark");
      this.busy = null;
      this.runId = 0;

      this.input.addEventListener("input", () => {
        this.query = this.input.value;
        this.cursor = 0;
        this._render();
      });

      this.overlay.addEventListener("mousedown", (e) => {
        if (!this.modal.contains(e.target)) this.hide();
      });

      // Keys handled while the palette owns focus.
      this.root.addEventListener("keydown", (e) => this._onKey(e));

      // Attach to documentElement rather than body: the game re-renders body
      // subtrees on its own timer and would otherwise sweep the host away.
      document.documentElement.appendChild(this.host);
    }

    // --- index -------------------------------------------------------------
    /** Remember nav entries so contextual sub-nav stays reachable from anywhere. */
    _learn(scanned) {
      const now = Date.now();
      let changed = false;

      for (const it of scanned) {
        // `learnable` is set by the scanner from EITHER a structural sighting
        // (inside header/nav) or the ● marker, so losing one signal does not
        // stop the palette learning.
        if (!it.learnable) continue;
        const key = SEN.scanner.normalizeKey(it.label);
        if (!key) continue;

        // Re-stamping `seen` is what keeps a live entry from ageing out and
        // lets a retired one expire.
        if (!SEN.learned.isStale(this.learned[key], it.path, now)) continue;
        this.learned[key] = { label: it.label, path: it.path, group: "Navigation", seen: now };
        changed = true;
      }

      if (changed) store.set(LEARNED_KEY, this._prune(this.learned));
    }

    /** Apply the retention policy and adopt the result. */
    _prune(learned) {
      this.learned = SEN.learned.prune(learned);
      return this.learned;
    }

    /** Merge live scan + learned entries + seed catalog into one candidate list. */
    _index() {
      const live = SEN.scanner.scan();
      this._learn(live);

      const byKey = new Map();
      // Sources are added most-trusted first (live > learned > seed), so a
      // later source may only FILL GAPS — never overwrite a label, path or
      // element we already have from a better source.
      const add = (item) => {
        const k = SEN.scanner.normalizeKey(item.label) || item.label.toLowerCase();
        const existing = byKey.get(k);
        if (!existing) {
          byKey.set(k, item);
          return;
        }
        if (!existing.el && item.el) existing.el = item.el;
        if (!existing.path && item.path) existing.path = item.path;
        if (!existing.keywords && item.keywords) existing.keywords = item.keywords;
        if (!existing.badge && item.badge && !existing.el) existing.badge = item.badge;
        if (item.clickOnly) existing.clickOnly = true;
      };

      for (const it of live) {
        add({
          label: it.label,
          path: it.path,
          group: it.group,
          el: it.el,
          badge: null,
          keywords: "",
        });
      }
      for (const [, it] of Object.entries(this.learned)) {
        add({ label: it.label, path: it.path, group: it.group, el: null, badge: "seen", keywords: "" });
      }

      // A seed entry whose destination is already represented by a real header
      // link is pure noise ("Messages" next to "✉ 3 NEW MESSAGES"), so drop it.
      const claimed = new Set([...byKey.values()].map((i) => i.path).filter(Boolean));
      for (const it of SEN.catalog) {
        const seedKey = SEN.scanner.normalizeKey(it.label) || it.label.toLowerCase();
        if (it.path && claimed.has(it.path) && !byKey.has(seedKey)) continue;
        add({
          label: it.label,
          path: it.path,
          group: it.group,
          el: null,
          badge: "known",
          keywords: it.keywords || "",
          clickOnly: it.clickOnly,
        });
      }
      return [...byKey.values()];
    }

    // --- filtering ---------------------------------------------------------
    /** key -> position in most-recently-used order (0 is the last thing you picked). */
    _recencyRanks() {
      const ranks = new Map();
      Object.entries(this.frecency)
        .sort((a, b) => (b[1].last || 0) - (a[1].last || 0))
        .forEach(([key], i) => ranks.set(key, i));
      return ranks;
    }

    _keyOf(item) {
      return SEN.scanner.normalizeKey(item.label) || item.label.toLowerCase();
    }

    /**
     * With no query, the list is simply your history: everything you have
     * jumped to before, most recent first, under one "Recent" heading, then
     * everything else in its normal groups. Opening Cmd-K and pressing Enter
     * therefore repeats your last jump.
     */
    _recentFirst(ranks) {
      const used = [];
      const rest = [];
      for (const item of this.items) {
        (ranks.has(this._keyOf(item)) ? used : rest).push(item);
      }
      used.sort((a, b) => ranks.get(this._keyOf(a)) - ranks.get(this._keyOf(b)));
      rest.sort(
        (a, b) =>
          Number(Boolean(b.el)) - Number(Boolean(a.el)) || a.label.localeCompare(b.label)
      );

      return [
        ...used.map((item) => ({ item, group: "Recent", score: 0, positions: [] })),
        ...rest.map((item) => ({ item, group: item.group, score: 0, positions: [] })),
      ].slice(0, MAX_RESULTS);
    }

    _filter() {
      const q = this.query.trim();
      const ranks = this._recencyRanks();
      if (!q) return this._recentFirst(ranks);

      const scored = [];

      for (const item of this.items) {
        let hit = SEN.fuzzy.match(q, item.label);
        let positions = hit ? hit.positions : [];
        let score = hit ? hit.score : null;

        if (score === null && q) {
          // Fall back to the secondary haystack (path + keywords), which can
          // match but never highlights, and ranks below a real label hit.
          const alt = `${item.path || ""} ${item.keywords || ""} ${item.group || ""}`;
          const altHit = SEN.fuzzy.match(q, alt);
          if (!altHit) continue;
          score = altHit.score - 40;
          positions = [];
        }
        if (score === null) continue;

        // Frecency: things you jump to often float up.
        const f = this.frecency[SEN.scanner.normalizeKey(item.label) || item.label.toLowerCase()];
        if (f) {
          const ageDays = (Date.now() - f.last) / 86400000;
          score += Math.min(f.n, 8) * 4 + Math.max(0, 12 - ageDays * 2);
        }
        // A destination we can see on screen right now is more likely correct
        // than one we merely remember.
        if (item.el) score += 6;

        scored.push({ item, group: item.group, score, positions });
      }

      scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));

      // Keep the strongest match at the very top, but pull each group together
      // so a section heading is never printed twice. Groups are ordered by
      // their best member, so grouping never demotes the top hit.
      const order = new Map();
      for (const s of scored) {
        if (!order.has(s.group)) order.set(s.group, order.size);
      }
      scored.sort(
        (a, b) =>
          order.get(a.group) - order.get(b.group) ||
          b.score - a.score ||
          a.item.label.localeCompare(b.item.label)
      );

      return scored.slice(0, MAX_RESULTS);
    }

    // --- render ------------------------------------------------------------
    _render() {
      this.results = this._filter();
      this.list.textContent = "";
      this.rows = [];

      if (!this.results.length) {
        const empty = document.createElement("div");
        empty.className = "sen-empty";
        empty.textContent = "Nothing matches that.";
        this.list.appendChild(empty);
        return;
      }

      // Build off-document and attach once, so a keystroke costs one layout
      // pass instead of one per row.
      const frag = document.createDocumentFragment();
      let lastGroup = null;
      this.results.forEach((res, i) => {
        const { item, positions } = res;
        // The heading comes from the RESULT, not the item: an entry shown for
        // its recency is filed under "Recent" wherever it normally lives.
        const group = res.group || item.group;

        if (group !== lastGroup) {
          const g = document.createElement("div");
          g.className = "sen-group";
          g.textContent = group;
          frag.appendChild(g);
          lastGroup = group;
        }

        const row = document.createElement("div");
        row.className = "sen-item";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(i === this.cursor));
        row.dataset.index = String(i);

        const label = document.createElement("span");
        label.className = "sen-label";
        label.append(...this._highlight(item.label, positions));
        row.appendChild(label);

        if (item.badge) {
          const b = document.createElement("span");
          b.className = "sen-badge";
          b.textContent = item.badge;
          row.appendChild(b);
        }
        if (item.path) {
          const p = document.createElement("span");
          p.className = "sen-path";
          p.textContent = item.path;
          row.appendChild(p);
        }

        row.addEventListener("mousemove", () => this._moveTo(i));
        row.addEventListener("click", () => this._activate(i));
        this.rows.push(row);
        frag.appendChild(row);
      });

      this.list.appendChild(frag);
      this._scrollToCursor();
    }

    /** Build text nodes with <mark> around matched characters. */
    _highlight(text, positions) {
      if (!positions.length) return [document.createTextNode(text)];
      const set = new Set(positions);
      const out = [];
      let buf = "";
      let marking = false;

      const flush = () => {
        if (!buf) return;
        if (marking) {
          const m = document.createElement("mark");
          m.textContent = buf;
          out.push(m);
        } else {
          out.push(document.createTextNode(buf));
        }
        buf = "";
      };

      for (let i = 0; i < text.length; i++) {
        const on = set.has(i);
        if (on !== marking) {
          flush();
          marking = on;
        }
        buf += text[i];
      }
      flush();
      return out;
    }

    _scrollToCursor() {
      this.rows[this.cursor]?.scrollIntoView({ block: "nearest" });
    }

    /**
     * Moving the cursor touches exactly two rows — no re-render, and no
     * querySelector: the rows are held from the last render, so Ctrl-N / Ctrl-P
     * is two attribute writes and a scroll.
     */
    _moveTo(i) {
      if (i === this.cursor || i < 0 || i >= this.results.length) return;
      this.rows[this.cursor]?.setAttribute("aria-selected", "false");
      this.cursor = i;
      this.rows[i]?.setAttribute("aria-selected", "true");
      this._scrollToCursor();
    }

    _move(delta) {
      if (!this.results.length) return;
      const n = this.results.length;
      this._moveTo((this.cursor + delta + n) % n);
    }

    // --- activation --------------------------------------------------------
    _activate(index) {
      // Ignore every activation while an action is in flight. This is the
      // double-fire guard: an action can spend real resources, so a second
      // Enter on an unresponsive-looking palette must not buy a second one.
      if (this.busy) return;

      const res = this.results[index ?? this.cursor];
      if (!res) return;
      const item = res.item;

      this._bumpFrecency(item.label);

      // An action runs in place and reports progress; a jump closes the
      // palette, because the page changing is its own feedback.
      if (typeof item.run === "function") return this._runAction(item);

      this.hide();

      // Prefer a REAL CLICK on a live element over assigning location: the game
      // is a client-routed SPA and some routes (notably /buildings) render
      // near-empty on a hard load but paint correctly when reached via the nav
      // link. Clicking also keeps their router state intact.
      const el = SEN.scanner.resolve(item);
      if (el) {
        el.click();
        return;
      }
      if (item.path && !item.clickOnly) {
        location.assign(item.path);
        return;
      }
      // Reachable only by clicking, and its link is not on this page: get to
      // the parent door first and let the user finish from there.
      const doorPath = { Realm: "/empire", Expeditions: "/expeditions", Champions: "/heroes" }[item.group];
      if (doorPath && location.pathname !== doorPath) location.assign(doorPath);
    }

    // --- actions ------------------------------------------------------------
    /**
     * Run an item's action with the palette held open, showing a live status
     * line. Resolves when the action settles; never throws.
     *
     * States: busy → done (auto-closes) | error (stays open so the message can
     * be read and the action retried). A slow action escalates its own wording
     * rather than sitting on one frozen string, so a stall is distinguishable
     * from ordinary latency.
     */
    async _runAction(item) {
      // Every run carries a token. Dismissing the palette (or starting a new
      // run) invalidates it, so a slow action that settles after the user has
      // moved on cannot write its result over an unrelated later state.
      const myRun = ++this.runId;
      const verb = item.pendingLabel || `${item.label}…`;

      this.busy = item;
      this._setStatus("busy", verb);
      this.modal.setAttribute("aria-busy", "true");
      this.input.disabled = true;

      const slow = setTimeout(() => {
        if (this.runId === myRun) this._setStatus("busy", `${verb} still working`);
      }, SLOW_AFTER_MS);

      let ok = true;
      let message;
      try {
        const result = await item.run();
        message = (result && result.message) || `${item.label} — done`;
      } catch (err) {
        ok = false;
        // Surface the real reason. A generic "something went wrong" is worse
        // than useless for an action that may have spent resources.
        message = (err && err.message) || String(err) || "Failed";
      }

      clearTimeout(slow);
      if (this.runId !== myRun) return; // superseded or dismissed — stay quiet
      this._clearBusy();
      this._setStatus(ok ? "done" : "error", message);

      if (ok) {
        // Let the confirmation land, then get out of the way.
        this.doneTimer = setTimeout(() => {
          if (this.runId === myRun) this.hide();
        }, DONE_LINGER_MS);
      } else {
        // A failure is exactly when the palette should stay put: the message
        // needs reading, and retrying should not cost another Cmd-K.
        this.input.focus();
      }
    }

    _clearBusy() {
      this.busy = null;
      this.modal.removeAttribute("aria-busy");
      this.input.disabled = false;
    }

    /** state: "busy" | "done" | "error" | null to clear. */
    _setStatus(state, text) {
      if (!state) {
        this.status.removeAttribute("data-state");
        this.statusText.textContent = "";
        this.statusMark.textContent = "";
        return;
      }
      this.status.setAttribute("data-state", state);
      this.statusMark.textContent = state === "done" ? "✓" : state === "error" ? "✕" : "";
      this.statusText.textContent = text;
    }

    _bumpFrecency(label) {
      const k = SEN.scanner.normalizeKey(label) || label.toLowerCase();
      const cur = this.frecency[k] || { n: 0, last: 0 };
      this.frecency[k] = { n: cur.n + 1, last: Date.now() };
      store.set(FRECENCY_KEY, this.frecency);
    }

    // --- keys / visibility --------------------------------------------------
    _onKey(e) {
      if (!this.open) return;
      // Escape always works, even mid-action — never trap the user in a modal
      // waiting on something slow. The action keeps running; we just stop
      // narrating it. Everything else is inert while busy so the selection
      // cannot drift under the action that is already running.
      if (this.busy && e.key !== "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Every key we act on is also stopped here. Otherwise it goes on to the
      // game, which binds plenty of its own shortcuts and re-renders in
      // response — that work lands between the keypress and the cursor moving,
      // which is exactly what makes Ctrl-N / Ctrl-P feel sluggish.
      const claim = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      switch (e.key) {
        case "Escape":
          claim();
          this.hide();
          break;
        case "ArrowDown":
          claim();
          this._move(1);
          break;
        case "ArrowUp":
          claim();
          this._move(-1);
          break;
        case "Tab":
          claim();
          this._move(e.shiftKey ? -1 : 1);
          break;
        case "Enter":
          claim();
          this._activate();
          break;
        case "n":
        case "p":
        case "N":
        case "P":
          if (e.ctrlKey) {
            claim();
            this._move(e.key.toLowerCase() === "n" ? 1 : -1);
          }
          break;
      }
    }

    show() {
      if (this.open || !this.enabled) return;
      // Before `open` is set, because _rebuild() refuses to run while the
      // palette is up. Normally a no-op — the background rebuild has already
      // done the work — and it only costs anything if the page changed in the
      // last instant.
      if (this.stale) this._rebuild();

      this.lastFocus = document.activeElement;
      this.open = true;
      this.overlay.hidden = false;
      this._setStatus(null);
      this.query = "";
      this.input.value = "";
      this.input.disabled = false;
      this.cursor = 0;
      this._render();
      this.input.focus();
    }

    hide() {
      if (!this.open) return;
      clearTimeout(this.doneTimer);
      // Deliberately does NOT cancel a running action — the game request is
      // already in flight and cannot be recalled, so pretending otherwise
      // would be a lie. Dismissing only stops the narration; _runAction's
      // handlers check `this.busy` before touching a palette that may by then
      // have been reopened on something else.
      this.runId++; // invalidate any in-flight run's right to report back
      this._clearBusy();
      this.open = false;
      this.overlay.hidden = true;
      // Return focus where the user left it, but never to something detached.
      if (this.lastFocus && this.lastFocus.isConnected && this.lastFocus.focus) {
        this.lastFocus.focus();
      }
      this.lastFocus = null;
    }

    toggle() {
      this.open ? this.hide() : this.show();
    }
  }

  SEN.Palette = Palette;
})();
