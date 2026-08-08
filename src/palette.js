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
      this.query = "";
      this.learned = {};   // key -> {label, path, group}  (nav seen in the past)
      this.frecency = {};  // key -> {n, last}
      this.lastFocus = null;
      this._build();
    }

    async init() {
      this.learned = this._prune(await store.get(LEARNED_KEY, {}));
      this.frecency = await store.get(FRECENCY_KEY, {});
      // Learn from the current page immediately, so the very first Cmd-K in a
      // session already knows about this door's sub-nav.
      this._learn(SEN.scanner.scan());
    }

    // --- DOM ---------------------------------------------------------------
    _build() {
      this.host = document.createElement("div");
      this.host.id = "seneschal-root";
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
    _filter() {
      const q = this.query.trim();
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

        scored.push({ item, score, positions });
      }

      scored.sort((a, b) => b.score - a.score || a.item.label.localeCompare(b.item.label));

      // Keep the strongest match at the very top, but pull each group together
      // so a section heading is never printed twice. Groups are ordered by
      // their best member, so grouping never demotes the top hit.
      const order = new Map();
      for (const s of scored) {
        if (!order.has(s.item.group)) order.set(s.item.group, order.size);
      }
      scored.sort(
        (a, b) =>
          order.get(a.item.group) - order.get(b.item.group) ||
          b.score - a.score ||
          a.item.label.localeCompare(b.item.label)
      );

      return scored.slice(0, MAX_RESULTS);
    }

    // --- render ------------------------------------------------------------
    _render() {
      this.results = this._filter();
      this.list.textContent = "";

      if (!this.results.length) {
        const empty = document.createElement("div");
        empty.className = "sen-empty";
        empty.textContent = "Nothing matches that.";
        this.list.appendChild(empty);
        return;
      }

      let lastGroup = null;
      this.results.forEach((res, i) => {
        const { item, positions } = res;

        if (item.group !== lastGroup) {
          const g = document.createElement("div");
          g.className = "sen-group";
          g.textContent = item.group;
          this.list.appendChild(g);
          lastGroup = item.group;
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
        this.list.appendChild(row);
      });

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
      const el = this.list.querySelector(`[data-index="${this.cursor}"]`);
      if (el) el.scrollIntoView({ block: "nearest" });
    }

    _moveTo(i) {
      if (i === this.cursor || i < 0 || i >= this.results.length) return;
      const prev = this.list.querySelector(`[data-index="${this.cursor}"]`);
      if (prev) prev.setAttribute("aria-selected", "false");
      this.cursor = i;
      const next = this.list.querySelector(`[data-index="${i}"]`);
      if (next) next.setAttribute("aria-selected", "true");
      this._scrollToCursor();
    }

    _move(delta) {
      if (!this.results.length) return;
      const n = this.results.length;
      this._moveTo((this.cursor + delta + n) % n);
    }

    // --- activation --------------------------------------------------------
    _activate(index) {
      const res = this.results[index ?? this.cursor];
      if (!res) return;
      const item = res.item;

      this._bumpFrecency(item.label);
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

    _bumpFrecency(label) {
      const k = SEN.scanner.normalizeKey(label) || label.toLowerCase();
      const cur = this.frecency[k] || { n: 0, last: 0 };
      this.frecency[k] = { n: cur.n + 1, last: Date.now() };
      store.set(FRECENCY_KEY, this.frecency);
    }

    // --- keys / visibility --------------------------------------------------
    _onKey(e) {
      if (!this.open) return;
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          this.hide();
          break;
        case "ArrowDown":
          e.preventDefault();
          this._move(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          this._move(-1);
          break;
        case "Tab":
          e.preventDefault();
          this._move(e.shiftKey ? -1 : 1);
          break;
        case "Enter":
          e.preventDefault();
          this._activate();
          break;
        case "n":
        case "p":
          if (e.ctrlKey) {
            e.preventDefault();
            this._move(e.key === "n" ? 1 : -1);
          }
          break;
      }
    }

    show() {
      if (this.open) return;
      this.lastFocus = document.activeElement;
      this.open = true;
      this.overlay.hidden = false;
      this.items = this._index();
      this.query = "";
      this.input.value = "";
      this.cursor = 0;
      this._render();
      this.input.focus();
    }

    hide() {
      if (!this.open) return;
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
