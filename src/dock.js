/**
 * dock.js — the floating quick menu.
 *
 * A configurable rail pinned to the left or right edge of the page, holding
 * whatever destinations the user wants. Two kinds of entry (see config.js):
 * a `url` entry has an address; a `menu` entry has a PATTERN matched against
 * the visible labels of the game's navigation, plus an optional `door` to walk
 * through first when nothing on the current page matches.
 *
 * That second kind is what makes contextual sub-navigation reachable in one
 * click. Wardenfall only renders CRAFTABLES / ARENA / HUNT once you are inside
 * their parent door, so "go to /expeditions, then click the thing called ARENA"
 * is the honest description of the journey — and it is expressed here as data
 * rather than as a hardcoded route table.
 *
 * Everything lives in its own shadow root, on a host separate from the
 * palette's, so the game's CSS cannot reach in and its re-renders cannot sweep
 * the dock away.
 */
(function () {
  "use strict";

  const SEN = (globalThis.SEN = globalThis.SEN || {});

  // How long we keep hunting for a menu entry after walking through its door.
  // The game re-renders its sub-nav row asynchronously; six seconds is far
  // longer than it has ever taken, and failing at all is meant to be visible.
  const RESOLVE_MS = 6000;
  const PENDING_KEY = "seneschal.pending.v1";
  const TOAST_MS = 7000;

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
        /* non-fatal: the dock still works for this page load */
      }
    },
  };

  // sessionStorage is how a pending click survives a FULL page load. It can
  // throw outright when cookies are blocked, so every access is guarded.
  const session = {
    read(key) {
      try {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    },
    write(key, value) {
      try {
        sessionStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* fine: the in-memory watcher still covers same-document routing */
      }
    },
    clear(key) {
      try {
        sessionStorage.removeItem(key);
      } catch {
        /* nothing to do */
      }
    },
  };

  class Dock {
    constructor() {
      this.settings = SEN.config.defaults();
      this.watcher = null;
      this.toastTimer = null;
      this._build();
    }

    async init() {
      const stored = await store.get(SEN.config.STORAGE_KEY, null);
      const { config, problems } = SEN.config.normalize(stored);
      this.settings = config;
      if (problems.length) {
        console.warn("[Seneschal] quick menu config:", problems.join(" · "));
        this.toast(`Quick menu: ${problems[0]}`);
      }
      this.render();

      // Keep every tab in step with the options page (and with each other).
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local" || !changes[SEN.config.STORAGE_KEY]) return;
          this.settings = SEN.config.normalize(changes[SEN.config.STORAGE_KEY].newValue).config;
          this.render();
        });
      } catch {
        /* no live sync; a reload still picks up changes */
      }

      this._resumePending();
    }

    // --- DOM -----------------------------------------------------------------
    _build() {
      this.host = document.createElement("div");
      this.host.id = "seneschal-dock";
      // Marks this subtree as ours so the palette's scanner never indexes it.
      this.host.setAttribute("data-seneschal", "dock");
      this.root = this.host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = SEN.dockStyles;

      this.wrap = document.createElement("div");
      this.wrap.className = "dk-wrap dk-right";
      // Child order matters: the rail is LAST so it stays flush against the
      // screen edge, with the tab beside it and the form opening inward. Put
      // the form first and it no longer shoves the rail sideways when it opens.
      this.wrap.innerHTML = `
        <div class="dk-form" hidden role="dialog" aria-label="Add a quick menu entry">
          <h2>Add to quick menu</h2>
          <div class="dk-field">
            <label for="dk-label">Label</label>
            <input id="dk-label" type="text" autocomplete="off" spellcheck="false" />
          </div>
          <div class="dk-field">
            <label for="dk-type">Goes to</label>
            <select id="dk-type">
              <option value="url">A URL</option>
              <option value="menu">A menu entry, by name</option>
            </select>
          </div>
          <div class="dk-field" data-for="url">
            <label for="dk-path">Path</label>
            <input id="dk-path" type="text" autocomplete="off" spellcheck="false" placeholder="/market" />
          </div>
          <div class="dk-field" data-for="menu" hidden>
            <label for="dk-match">Menu entry name</label>
            <input id="dk-match" type="text" autocomplete="off" spellcheck="false" placeholder="craftables" />
            <span class="dk-hint">Matched against what the link says. /regex/ works too.</span>
          </div>
          <div class="dk-field" data-for="menu" hidden>
            <label for="dk-door">Open this first, if needed</label>
            <input id="dk-door" type="text" autocomplete="off" spellcheck="false" placeholder="/empire" />
          </div>
          <p class="dk-error" hidden></p>
          <div class="dk-actions">
            <button type="button" class="dk-cancel">Cancel</button>
            <button type="button" class="dk-primary dk-save">Add</button>
          </div>
        </div>
        <button type="button" class="dk-tab" title="Collapse or expand the quick menu"></button>
        <div class="dk-rail" role="navigation" aria-label="Seneschal quick menu"></div>
        <div class="dk-toast" role="status" aria-live="polite" hidden></div>`;

      this.rail = this.wrap.querySelector(".dk-rail");
      this.tab = this.wrap.querySelector(".dk-tab");
      this.form = this.wrap.querySelector(".dk-form");
      this.toastEl = this.wrap.querySelector(".dk-toast");
      this.errorEl = this.wrap.querySelector(".dk-error");
      this.typeSelect = this.wrap.querySelector("#dk-type");

      this.tab.addEventListener("click", () => this._setCollapsed(!this.settings.dock.collapsed));
      this.typeSelect.addEventListener("change", () => this._syncFormFields());
      this.wrap.querySelector(".dk-cancel").addEventListener("click", () => this._closeForm());
      this.wrap.querySelector(".dk-save").addEventListener("click", () => this._saveNewItem());
      this.form.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this._saveNewItem();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this._closeForm();
        }
      });

      this.root.append(style, this.wrap);
      // documentElement, not body: the game re-renders body subtrees on a timer.
      document.documentElement.appendChild(this.host);
    }

    // --- render --------------------------------------------------------------
    render() {
      const { side, collapsed, enabled, items } = this.settings.dock;
      this.wrap.className = `dk-wrap dk-${side === "left" ? "left" : "right"}` + (collapsed ? " dk-collapsed" : "");
      this.wrap.hidden = !enabled;
      this.tab.textContent = collapsed ? "MENU" : "HIDE";
      this.tab.setAttribute("aria-expanded", String(!collapsed));

      this.rail.textContent = "";
      for (const item of items) {
        this.rail.appendChild(this._itemButton(item));
      }
      if (!items.length) {
        const empty = document.createElement("button");
        empty.type = "button";
        empty.className = "dk-btn";
        empty.title = "Add your first quick menu entry";
        empty.append(this._span("dk-icon", "＋"), this._span("dk-text", "Add a link"));
        empty.addEventListener("click", () => this._openForm());
        this.rail.appendChild(empty);
      }

      const sep = document.createElement("div");
      sep.className = "dk-sep";
      const tools = document.createElement("div");
      tools.className = "dk-tools";
      tools.append(
        this._toolButton("＋", "Add the current page to the quick menu", () => this._openForm()),
        this._toolButton("⚙", "Configure the quick menu", () => this._openOptions())
      );
      this.rail.append(sep, tools);

      if (!this.form.hidden) this._closeForm();
    }

    _span(className, text) {
      const el = document.createElement("span");
      el.className = className;
      el.textContent = text;
      return el;
    }

    _itemButton(item) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dk-btn";
      btn.dataset.id = item.id;
      btn.title = item.type === "url" ? `${item.label} — ${item.path}` : `${item.label} — menu entry "${item.match}"`;
      btn.append(this._span("dk-icon", item.icon || (item.type === "menu" ? "◈" : "•")), this._span("dk-text", item.label));
      btn.addEventListener("click", () => this.activate(item));
      return btn;
    }

    _toolButton(glyph, title, onClick) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dk-btn";
      btn.title = title;
      btn.setAttribute("aria-label", title);
      btn.append(this._span("dk-icon", glyph));
      btn.addEventListener("click", onClick);
      return btn;
    }

    // --- activation ----------------------------------------------------------
    activate(item) {
      if (item.type === "menu") return this._openMenuEntry(item);
      return this._goto(item.path);
    }

    /**
     * Go to a path. Clicking a live anchor beats assigning location: the game
     * is a client-routed SPA, some routes render near-empty on a hard load, and
     * a click leaves the router's own state intact.
     */
    _goto(path) {
      const target = SEN.config.classifyPath(path, location.origin);
      if (!target) {
        this.toast(`Quick menu: "${path}" is not a usable link.`);
        return false;
      }
      if (target.kind === "external") {
        window.open(target.href, "_blank", "noopener");
        return true;
      }
      const anchor = this._findAnchor(target.href);
      if (anchor) {
        anchor.click();
        return true;
      }
      location.assign(target.href);
      return true;
    }

    _findAnchor(href) {
      const escaped = CSS.escape(href);
      return (
        [...document.querySelectorAll(`a[href="${escaped}"]`)].find(
          (el) => SEN.scanner.isVisible(el) && !SEN.scanner.isOurs(el)
        ) || null
      );
    }

    /**
     * Activate a pattern entry: click the matching nav entry if it is on this
     * page, otherwise walk through its door and click it when it appears.
     */
    _openMenuEntry(item) {
      const parsed = SEN.config.parsePattern(item.match);
      if (parsed.error) {
        this.toast(`Quick menu: "${item.label}" has a bad pattern — ${parsed.error}`);
        return;
      }

      const here = this._findNavMatch(item.match);
      if (here) {
        here.click();
        return;
      }
      if (!item.door) {
        this.toast(`Quick menu: nothing here is called "${item.match}", and "${item.label}" has no door set.`);
        return;
      }

      // Two belts: the in-memory watcher handles same-document SPA routing,
      // the sessionStorage record survives a full reload.
      const pending = { match: item.match, label: item.label, expires: Date.now() + RESOLVE_MS };
      session.write(PENDING_KEY, pending);
      this._watchFor(pending);

      if (!this._goto(item.door)) {
        this._stopWatching();
        session.clear(PENDING_KEY);
      }
    }

    /** Resume a click that was interrupted by a page load. */
    _resumePending() {
      const pending = session.read(PENDING_KEY);
      if (!pending || !pending.match) return;
      if (!(pending.expires > Date.now())) {
        session.clear(PENDING_KEY);
        return;
      }
      // A reload eats part of the budget; give the fresh page a full window.
      this._watchFor({ ...pending, expires: Date.now() + RESOLVE_MS });
    }

    /**
     * Hunt for a nav entry matching `pending.match` until it appears or the
     * deadline passes. A MutationObserver catches the sub-nav swap; the
     * interval is a backstop for a render that mutates nothing we can see.
     */
    _watchFor(pending) {
      this._stopWatching();

      const finish = (found) => {
        this._stopWatching();
        session.clear(PENDING_KEY);
        if (found) {
          found.click();
          return;
        }
        // LOUD failure. A pattern that stopped matching after a patch must not
        // look like a button that simply does nothing.
        const message = `Quick menu: could not find a menu entry matching "${pending.match}".`;
        console.warn("[Seneschal]", message);
        this.toast(message);
      };

      const attempt = () => {
        const el = this._findNavMatch(pending.match);
        if (el) {
          finish(el);
          return true;
        }
        if (Date.now() >= pending.expires) {
          finish(null);
          return true;
        }
        return false;
      };

      if (attempt()) return;

      const observer = new MutationObserver(() => attempt());
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const interval = setInterval(attempt, 250);
      this.watcher = { observer, interval };
    }

    _stopWatching() {
      if (!this.watcher) return;
      this.watcher.observer.disconnect();
      clearInterval(this.watcher.interval);
      this.watcher = null;
    }

    /**
     * Find the clickable whose visible label satisfies `pattern`.
     *
     * Navigation entries win over anything else on the page, and an exact
     * label wins over a partial one, so "arena" prefers ARENA over
     * "ARENA HISTORY". Everything is found by role and visible text — never by
     * class name, which is the part of this game that rots.
     */
    _findNavMatch(pattern) {
      const parsed = SEN.config.parsePattern(pattern);
      if (parsed.error) return null;

      const wanted = SEN.config.foldLabel(pattern);
      const scored = [];
      for (const candidate of SEN.scanner.scan()) {
        if (!SEN.config.matchesPattern(pattern, candidate.label)) continue;
        const el = SEN.scanner.resolve(candidate);
        if (!el || this.host.contains(el)) continue;
        const folded = SEN.config.foldLabel(candidate.label);
        scored.push({
          el,
          rank:
            (candidate.inNav || candidate.marked ? 0 : 100) +
            (folded === wanted ? 0 : 10) +
            Math.min(folded.length, 9),
        });
      }
      scored.sort((a, b) => a.rank - b.rank);
      return scored.length ? scored[0].el : null;
    }

    // --- add form ------------------------------------------------------------
    _openForm() {
      this.form.hidden = false;
      this._showError("");
      const label = this.wrap.querySelector("#dk-label");
      label.value = this._guessLabel();
      this.wrap.querySelector("#dk-path").value = location.pathname + location.search;
      this.wrap.querySelector("#dk-match").value = "";
      this.wrap.querySelector("#dk-door").value = "";
      this.typeSelect.value = "url";
      this._syncFormFields();
      label.focus();
      label.select();
    }

    _closeForm() {
      this.form.hidden = true;
      this._showError("");
    }

    _syncFormFields() {
      const type = this.typeSelect.value;
      this.wrap.querySelectorAll(".dk-field[data-for]").forEach((field) => {
        field.hidden = field.dataset.for !== type;
      });
    }

    /** Best guess at a name for the current page: the active nav entry, else the title. */
    _guessLabel() {
      const path = location.pathname;
      const active = SEN.scanner
        .scan()
        .find((it) => it.path === path && (it.inNav || it.marked));
      const raw = active ? active.label : document.title.split(/[|–—-]/)[0];
      const cleaned = SEN.scanner.cleanLabel(raw || "").slice(0, SEN.config.MAX_LABEL);
      if (!cleaned) return "";
      // Nav labels are shouted; the dock is not.
      return cleaned === cleaned.toUpperCase()
        ? cleaned.charAt(0) + cleaned.slice(1).toLowerCase()
        : cleaned;
    }

    _showError(message) {
      this.errorEl.textContent = message;
      this.errorEl.hidden = !message;
    }

    async _saveNewItem() {
      const type = this.typeSelect.value;
      const draft = {
        id: SEN.config.newId(),
        label: this.wrap.querySelector("#dk-label").value,
        type,
        path: this.wrap.querySelector("#dk-path").value,
        match: this.wrap.querySelector("#dk-match").value,
        door: this.wrap.querySelector("#dk-door").value,
      };

      const result = SEN.config.validateItem(draft);
      if (!result.ok) {
        this._showError(result.reason);
        return;
      }
      if (this.settings.dock.items.length >= SEN.config.MAX_ITEMS) {
        this._showError(`the quick menu holds at most ${SEN.config.MAX_ITEMS} entries`);
        return;
      }

      this.settings = {
        ...this.settings,
        dock: { ...this.settings.dock, items: [...this.settings.dock.items, result.item] },
      };
      await store.set(SEN.config.STORAGE_KEY, this.settings);
      this.render();
      this.toast(`Added "${result.item.label}" to the quick menu.`);
    }

    async _setCollapsed(collapsed) {
      this.settings = { ...this.settings, dock: { ...this.settings.dock, collapsed } };
      this.render();
      await store.set(SEN.config.STORAGE_KEY, this.settings);
    }

    _openOptions() {
      try {
        chrome.runtime.sendMessage({ type: "seneschal:open-options" });
      } catch {
        this.toast("Open the Seneschal options from chrome://extensions to configure the quick menu.");
      }
    }

    // --- toast ---------------------------------------------------------------
    toast(message) {
      this.toastEl.textContent = message;
      this.toastEl.hidden = false;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => {
        this.toastEl.hidden = true;
      }, TOAST_MS);
    }
  }

  SEN.Dock = Dock;
})();
