/**
 * dock.js — the floating quick menu.
 *
 * A configurable rail pinned to the left or right edge of the page, holding
 * whatever destinations the user wants. Two kinds of entry (see config.js):
 * a `url` entry has an address; a `menu` entry has a PATTERN matched against
 * the visible labels of the game's navigation, plus an optional `door` to walk
 * through first when nothing on the current page matches.
 *
 * That second kind makes contextual sub-navigation reachable in one click.
 * Wardenfall only renders CRAFTABLES / ARENA / HUNT once you are inside their
 * parent door, so "go to /expeditions, then click the thing called ARENA" is
 * the honest description of the journey, expressed as data rather than as a
 * hardcoded route table.
 *
 * Note that this is about the link not being ON THE PAGE, not about it having
 * no URL — most of these do have one. See config.js for when each kind is the
 * right choice; a known-good URL is usually the better entry.
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
  // Every in-game navigation is a full page load, so the content script starts
  // from nothing each time. Without a cache the hero panel would flash a
  // placeholder on every single page — so the last known roster is shown
  // immediately, dimmed, while a fresh read lands underneath it.
  const HEROES_KEY = "seneschal.heroes.v1";
  const PENDING_KEY = "seneschal.pending.v1";
  // A confirmation has done its job the moment you have read it. A warning is
  // the whole point of the loud-failure design, so it lingers.
  const TOAST_MS = 2600;
  const TOAST_WARNING_MS = 7000;
  // How many messages can be on screen at once. Healing a full roster posts one
  // per hero; past this the oldest goes, so a burst cannot march off screen.
  const MAX_TOASTS = 6;

  // The soul balance is rendered only on the rites panel and no API exposes
  // it, so the rail shows the LAST READING rather than a live number. Kept
  // under its own key: it churns, and settings do not.
  const SOULS_KEY = "seneschal.souls.v1";
  // How often to look for a balance on screen. Only runs when a `host` entry
  // exists, and reads textContent, never innerText (CLAUDE.md finding 6).
  const SOULS_POLL_MS = 4000;
  // Past this the badge greys out: souls move with every raid casualty.
  const SOULS_FRESH_MS = 60 * 60 * 1000;
  // How long a rite click gets to move the balance before it is judged a
  // no-op. Exceeding this STOPS the run — it never re-clicks a sacrifice.
  const RITE_SETTLE_MS = 5000;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      this.heroes = null;   // null = nothing known yet, [] = read and empty
      this.healAll = null;
      this.elixirs = [];
      this.sieges = null;
      this.refreshing = false;
      this.watcher = null;
      this.busyHandle = null;   // the single in-flight toast a hunt owns
      this.healing = new Map(); // heals in flight, keyed by hero + method
      this.askQueue = [];       // questions waiting their turn beside the rail
      this.souls = null; // last balance reading: {souls, disturbance, tolerance, at}
      this.soulsTimer = null;
      this.running = false; // a rite is mid-flight; the rail is inert
      this._build();
    }

    async init() {
      const stored = await store.get(SEN.config.STORAGE_KEY, null);
      const { config, problems, migrated } = SEN.config.normalize(stored);
      this.settings = config;
      if (problems.length) {
        console.warn("[Seneschal] quick menu config:", problems.join(" · "));
        this.toast(`Quick menu: ${problems[0]}`, true);
      }
      // Stamp the migration forward, or it re-runs on every page load and
      // keeps resurrecting an entry the user deleted.
      if (migrated) await store.set(SEN.config.STORAGE_KEY, this.settings);

      this.souls = await store.get(SOULS_KEY, null);
      // Read the cached roster BEFORE the first paint, not after. Rendering
      // first put a "Reading heroes…" placeholder on screen for a frame — and
      // since every in-game navigation is a full page load, that flash was on
      // EVERY page, not just the first. Hydrating first removes it entirely.
      if (this.settings.heroes?.enabled) await this._hydrateHeroes();
      this.render();

      // Keep every tab in step with the options page (and with each other).
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== "local") return;
          if (changes[SEN.config.STORAGE_KEY]) {
            const wasOn = this.settings.heroes?.enabled;
            this.settings = SEN.config.normalize(changes[SEN.config.STORAGE_KEY].newValue).config;
            this.render();
            if (!wasOn && this.settings.heroes?.enabled) this._refreshHeroes();
          }
          if (changes[SOULS_KEY]) {
            this.souls = changes[SOULS_KEY].newValue || null;
            this._paintSouls();
          }
        });
      } catch {
        /* no live sync; a reload still picks up changes */
      }

      this._resumePending();
      this._watchSouls();
      // The stack is positioned from the rail's measured box, so it has to be
      // re-measured whenever that box can move.
      addEventListener("resize", () => this._positionToasts(), { passive: true });

      // The cache is already on screen; this is the live read that replaces it.
      if (this.settings.heroes?.enabled) this._refreshHeroes();
    }

    /** Adopt the last known roster so the first paint is never a placeholder. */
    async _hydrateHeroes() {
      const cached = await store.get(HEROES_KEY, null);
      if (!cached || !Array.isArray(cached.heroes)) return;
      this.heroes = cached.heroes;
      this.healAll = cached.healAll || null;
      this.elixirs = Array.isArray(cached.elixirs) ? cached.elixirs : [];
      this.sieges = Array.isArray(cached.sieges) ? cached.sieges : [];
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
        <div class="dk-ask" hidden role="alertdialog" aria-modal="true" aria-labelledby="dk-ask-title">
          <h2 id="dk-ask-title"></h2>
          <p class="dk-ask-body"></p>
          <div class="dk-actions">
            <button type="button" class="dk-ask-no">Cancel</button>
            <button type="button" class="dk-primary dk-ask-yes">Confirm</button>
          </div>
        </div>
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
              <option value="host">Raise a spectral host</option>
            </select>
          </div>
          <div class="dk-field" data-for="url">
            <label for="dk-path">Path</label>
            <input id="dk-path" type="text" autocomplete="off" spellcheck="false" placeholder="/market" />
          </div>
          <div class="dk-field" data-for="host" hidden>
            <label for="dk-souls">Souls to raise</label>
            <input id="dk-souls" type="number" min="1" step="1" autocomplete="off" placeholder="10000" />
            <span class="dk-hint">Always asks before spending anything.</span>
          </div>
          <div class="dk-field" data-for="menu host" hidden>
            <label for="dk-match">Menu entry name</label>
            <input id="dk-match" type="text" autocomplete="off" spellcheck="false" placeholder="craftables" />
            <span class="dk-hint">Matched against what the link says. /regex/ works too.</span>
          </div>
          <div class="dk-field" data-for="menu host" hidden>
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
        <div class="dk-rail" role="navigation" aria-label="Seneschal quick menu"></div>`;

      // The toast is a SIBLING of the wrap, not a child. .dk-wrap is
      // transform: translateY(-50%) to centre itself, and a transformed
      // ancestor becomes the containing block for position: fixed descendants —
      // so inside the wrap, "fixed; bottom: 18px" resolved against the rail and
      // planted the toast on top of the menu.
      // A STACK, not a single slot. Healing five heroes fires five results
      // seconds apart, and a single element meant each one wiped the last —
      // you saw one message and had no idea the other four had happened.
      this.toastStack = document.createElement("div");
      this.toastStack.className = "dk-toasts";
      this.toastStack.setAttribute("role", "status");
      this.toastStack.setAttribute("aria-live", "polite");

      // OUTSIDE .dk-wrap, deliberately. The wrap carries a `transform` to
      // centre itself vertically, and a transformed element becomes the
      // containing block for its `position: fixed` descendants — so a scrim
      // nested inside it is not full-screen at all, it is confined to the
      // rail's own box (a 160px-wide sheet crushed against the edge).
      this.scrim = document.createElement("div");
      this.scrim.className = "dk-scrim";
      this.scrim.hidden = true;
      this.scrim.innerHTML = `
        <div class="dk-sheet" role="dialog" aria-modal="true" aria-labelledby="dk-sheet-title">
          <h2 id="dk-sheet-title"></h2>
          <dl class="dk-read"></dl>
          <p class="dk-sheet-body"></p>
          <p class="dk-sheet-warn" hidden></p>
          <div class="dk-actions dk-sheet-actions"></div>
        </div>`;

      this.rail = this.wrap.querySelector(".dk-rail");
      this.tab = this.wrap.querySelector(".dk-tab");
      this.form = this.wrap.querySelector(".dk-form");
      this.errorEl = this.wrap.querySelector(".dk-error");
      this.typeSelect = this.wrap.querySelector("#dk-type");
      this.ask = this.wrap.querySelector(".dk-ask");
      this.askTitleEl = this.ask.querySelector("h2");
      this.askBodyEl = this.ask.querySelector(".dk-ask-body");
      this.askYes = this.ask.querySelector(".dk-ask-yes");

      this.askYes.addEventListener("click", () => this._closeAsk(true));
      this.ask.querySelector(".dk-ask-no").addEventListener("click", () => this._closeAsk(false));
      this.ask.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== "Escape") return;
        // The game handles keys too, and a re-render underneath an open
        // question is exactly the kind of thing that eats the answer.
        e.preventDefault();
        e.stopPropagation();
        this._closeAsk(e.key === "Enter");
      });
      this.sheet = this.scrim.querySelector(".dk-sheet");

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

      // Both the toast and the scrim are SIBLINGS of .dk-wrap, never children:
      // the wrap is transformed to centre itself, and a transformed ancestor
      // becomes the containing block for position:fixed descendants. Nested,
      // the toast landed on the menu and the scrim rendered as a narrow column
      // crushed against the edge. Keep them out here.
      this.root.append(style, this.wrap, this.toastStack, this.scrim);
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

      // The links live in their own scroller. A long menu and a full hero panel
      // together outgrow a laptop screen, and when the rail scrolled as ONE
      // block the heal buttons — the part you actually press — fell below the
      // fold. Now the link list gives up its space first and the panel stays put.
      const list = document.createElement("div");
      list.className = "dk-items";
      // Rites do NOT go in the scroller. They carry the soul / raisable-dead
      // badge, and the scroller is by design the first thing to surrender
      // space — so a rite in here is exactly the row that scrolls out of sight
      // on a laptop, taking the reading with it. A screenshot caught this; the
      // suite was green, because scrolled-away is not missing.
      const rites = items.filter((it) => it.type === "host");
      for (const item of items) {
        if (item.type === "host") continue;
        list.appendChild(this._itemButton(item));
      }
      if (!items.length) {
        const empty = document.createElement("button");
        empty.type = "button";
        empty.className = "dk-btn";
        empty.title = "Add your first quick menu entry";
        empty.append(this._span("dk-icon", "＋"), this._span("dk-text", "Add a link"));
        empty.addEventListener("click", () => this._openForm());
        list.appendChild(empty);
      }
      this.rail.appendChild(list);

      if (rites.length) {
        const box = document.createElement("div");
        box.className = "dk-rites";
        for (const item of rites) box.appendChild(this._itemButton(item));
        // The cost inputs, under the rite that spends them — same shape as the
        // game's own price quote under Heal all.
        // Its own class, not .dk-quote: that one is the GAME's price quote
        // under Heal all, and two different things sharing a selector is how a
        // test starts reading the wrong number.
        const detail = document.createElement("div");
        detail.className = "dk-rite-quote";
        detail.dataset.role = "souls-detail";
        box.appendChild(detail);
        this.rail.appendChild(box);
      }

      if (this.settings.heroes?.enabled) this.rail.appendChild(this._heroSection());

      const sep = document.createElement("div");
      sep.className = "dk-sep";
      const tools = document.createElement("div");
      tools.className = "dk-tools";
      tools.append(
        this._toolButton("＋", "Add the current page to the quick menu", () => this._openForm()),
        this._toolButton("⚙", "Configure the quick menu", () => this._openOptions())
      );
      this.rail.append(sep, tools);
      this._paintPending();
      this._paintSouls();
      this._paintHealing();
      this._positionToasts();

      if (!this.form.hidden) this._closeForm();
    }

    // --- hero panel ----------------------------------------------------------
    /**
     * HP for every hero, read from /heroes — one GET, works on any page, and
     * never mutates anything. The heal button is the single exception and is
     * explicit about it.
     */
    _heroSection() {
      const box = document.createElement("div");
      box.className = "dk-heroes" + (this.refreshing ? " dk-refreshing" : "");

      const sep = document.createElement("div");
      sep.className = "dk-sep";
      box.appendChild(sep);

      // Only ever seen on the very first run, before anything is cached.
      if (!this.heroes) {
        const loading = document.createElement("div");
        loading.className = "dk-hero";
        loading.append(this._span("dk-icon", "⛑"), this._span("dk-hero-name", "Reading heroes…"));
        box.appendChild(loading);
        return box;
      }

      // The game's own "heal all", mirrored. It brews the draughts itself and
      // prices the job, so the quote shown here is its arithmetic, not ours.
      if (this.healAll && this.healAll.available) {
        const all = document.createElement("button");
        all.type = "button";
        all.className = "dk-healall";
        all.append(this._span("dk-icon", "💚"), this._span("dk-text", "Heal all"));
        all.title = this.healAll.summary || "Mend every wounded hero";
        all.addEventListener("click", () => this._healAll(all));
        box.appendChild(all);

        if (this.healAll.summary && !this.settings.dock.collapsed) {
          const quote = document.createElement("div");
          quote.className = "dk-quote";
          quote.textContent = this.healAll.summary;
          box.appendChild(quote);
        }
      }

      for (const hero of this.heroes) {
        const row = document.createElement("div");
        row.className = "dk-hero";
        row.append(
          this._span("dk-icon", hero.icon || "🗡"),
          this._span("dk-hero-name", hero.name),
          this._span("dk-hero-hp", `${hero.hp}/${hero.maxHp}`)
        );

        box.appendChild(row);

        const bar = document.createElement("div");
        bar.className = "dk-bar";
        const fill = document.createElement("div");
        const frac = SEN.heroes.hpFraction(hero);
        fill.className = "dk-bar-fill" + (frac < 0.34 ? " dk-bad" : frac < 0.85 ? " dk-hurt" : "");
        fill.style.width = `${Math.round(frac * 100)}%`;
        bar.appendChild(fill);
        box.appendChild(bar);

        // One button per way of healing, but only for someone who needs it.
        if (SEN.heroes.isDamaged(hero)) box.appendChild(this._healMethods(hero));
      }

      // Which siege the heal acts on. Hidden unless there is a real choice.
      const siege = document.createElement("button");
      siege.type = "button";
      siege.className = "dk-siege";
      const active = this.sieges || [];
      const chosen = (active.includes(this.settings.heroes.siege) && this.settings.heroes.siege) || active[0] || "";
      if (!active.length) {
        siege.textContent = "No active siege";
        siege.title = "Provisions healing needs a siege you are committed to";
        siege.disabled = true;
        siege.hidden = this.heroes === null;
      } else {
        siege.textContent = `Heals from: ${chosen.replace(/^The /, "")}`;
        siege.title = "Click to draw heals from a different active siege";
        siege.hidden = active.length < 2 && !chosen;
      }
      siege.addEventListener("click", () => this._cycleSiege());
      box.appendChild(siege);

      return box;
    }

    /**
     * One button per way of healing, each naming itself and its price.
     *
     * A single "heal" button once spent the scarcest elixir — a Wardenbalm,
     * +50 HP — closing a 79 HP wound, because nothing told the user which
     * method it would pick. Naming each method is the fix: the choice is
     * always theirs, and always priced before it is made.
     */
    _healMethods(hero) {
      const gap = hero.maxHp - hero.hp;
      const strip = document.createElement("div");
      strip.className = "dk-methods";

      const add = (glyph, title, enabled, run, key) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "dk-method";
        button.textContent = glyph;
        button.title = title;
        button.disabled = !enabled;
        // The key survives a re-render, which the element does not: a heal
        // takes seconds, and the roster re-reads underneath it. Without this
        // the spinner on hero three vanished the moment hero one came back.
        button.dataset.healKey = `${hero.name}::${key}`;
        button.dataset.glyph = glyph;
        if (enabled) button.addEventListener("click", () => run(button));
        strip.appendChild(button);
      };

      // Siege provisions: cheap, but only inside a siege you are committed to.
      const siege = (this.sieges || []).includes(this.settings.heroes.siege)
        ? this.settings.heroes.siege
        : (this.sieges || [])[0] || "";
      add(
        "⛑",
        siege
          ? `Siege provisions · from ${siege} · spends 4 of this champion's resource`
          : "Siege provisions · needs a siege you are committed to",
        Boolean(siege),
        (button) => this._heal(hero, button, { kind: "siege", siege }),
        "siege"
      );

      for (const elixir of this.elixirs || []) {
        // Flag an elixir that would be wasted on a small wound — exactly the
        // mistake the old single button made.
        const overkill = elixir.mend && elixir.mend > gap + 15 ? " · more than this wound needs" : "";
        const supply =
          elixir.held > 0
            ? `you hold ${elixir.held}`
            : elixir.canCraft
              ? `none held — brews one for ${elixir.cost}`
              : "none held, and not enough materials to brew";
        add(
          elixir.icon,
          `${elixir.name} · +${elixir.mend} HP · ${supply}${overkill}`,
          Boolean(elixir.canUse),
          (button) => this._heal(hero, button, { kind: "elixir", elixir }),
          `elixir:${elixir.key}`
        );
      }
      return strip;
    }

    /**
     * Fetch the roster in the background. Whatever is already on screen stays
     * there, dimmed, until this lands — so navigating between pages never
     * blanks the panel.
     */
    async _refreshHeroes() {
      if (this.refreshing) return;
      this.refreshing = true;
      this._paintRefreshing();
      try {
        const [roster, sieges] = await Promise.all([
          SEN.heroes.loadRoster(),
          SEN.heroes.loadSieges().catch(() => []),
        ]);
        this.heroes = roster.heroes;
        this.healAll = roster.healAll;
        this.sieges = sieges;
        // Only worth a third request when there is actually something to heal.
        this.elixirs = roster.heroes.some(SEN.heroes.isDamaged)
          ? await SEN.heroes.loadElixirs().catch(() => [])
          : [];
        await store.set(HEROES_KEY, {
          heroes: roster.heroes,
          healAll: roster.healAll,
          elixirs: this.elixirs,
          sieges,
          at: Date.now(),
        });
        this.refreshing = false;
        this.render();
      } catch (e) {
        // A request killed by navigating away is routine, not a fault: every
        // in-game click is a full page load, so a refresh started moments
        // earlier is cancelled and rejects as "Failed to fetch". Saying nothing
        // is correct — the cached roster is still on screen and the next page
        // will refresh it.
        //
        // Anything else stays quiet too, but is logged: a failed read means
        // /heroes moved or we are not on Wardenfall, and a toast on every page
        // load would be noise. The loud path is _heal(), where something was
        // actually at stake.
        if (!SEN.heroes.isAbort(e)) console.warn("[Seneschal] could not read heroes:", e);
        this.refreshing = false;
        if (!this.heroes) {
          this.heroes = [];
          this.render();
        } else {
          this._paintRefreshing();
        }
      }
    }

    /**
     * Toggle the "updating" look directly, without re-rendering — a rebuild
     * here would throw away the rows we are deliberately keeping on screen.
     */
    _paintRefreshing() {
      const box = this.rail.querySelector(".dk-heroes");
      if (box) box.classList.toggle("dk-refreshing", this.refreshing);
    }

    /** Rotate through the active sieges; the first is the default. */
    async _cycleSiege() {
      if (!this.sieges || this.sieges.length < 2) return;
      const current = this.settings.heroes.siege || this.sieges[0];
      const next = this.sieges[(this.sieges.indexOf(current) + 1) % this.sieges.length];
      this.settings = { ...this.settings, heroes: { ...this.settings.heroes, siege: next } };
      this.render();
      await store.set(SEN.config.STORAGE_KEY, this.settings);
      this.toast(`Heals now draw from ${next}.`);
    }

    /**
     * The only thing in the extension that spends anything, so it asks first,
     * says exactly what it cost, and VERIFIES against the server rather than
     * assuming the click worked.
     */
    async _heal(hero, button, method) {
      // The button is disabled at full health, but the guard is repeated here
      // so a stale row cannot spend provisions on a hero who does not need it.
      if (!SEN.heroes.isDamaged(hero)) {
        this.toast(`${hero.name} is already at full health.`);
        return;
      }

      // The method was chosen by the user, never inferred — and it is priced
      // in the confirm, including when an elixir has to be brewed first.
      const cost =
        method.kind === "siege"
          ? `4 provisions from ${method.siege}`
          : method.elixir.held > 0
            ? `one ${method.elixir.name} (+${method.elixir.mend} HP)`
            : `${method.elixir.cost} to brew a ${method.elixir.name} (+${method.elixir.mend} HP)`;
      const go = await this._ask({
        title: `Heal ${hero.name}?`,
        body: `${hero.hp}/${hero.maxHp} HP. This spends ${cost}.`,
        confirmLabel: "Heal",
      });
      if (!go) return;

      // Re-entry is guarded by the KEY, not by disabling the button. A disabled
      // method button is drawn at 30% opacity — the same as one you cannot use
      // — so marking work in flight that way made a heal in progress look like
      // a heal that was unavailable. That is what "no loading indicator" was.
      const key = button.dataset.healKey;
      if (this.healing.has(key)) return;

      // Each heal owns its own line, so five of them in flight read as five
      // things happening rather than one message replacing another.
      const live = this.toast(`Healing ${hero.name}…`, { busy: true });
      this.healing.set(key, live);
      this._paintHealing();

      try {
        const out =
          method.kind === "siege"
            ? await SEN.heroes.heal({ heroName: hero.name, siege: method.siege })
            : await SEN.heroes.healWithElixir({ heroName: hero.name, key: method.elixir.key });
        if (out.healed) {
          const how = out.elixir ? ` with ${out.brewed ? "a freshly brewed " : ""}${out.elixir}` : "";
          live.update(`${hero.name}: ${out.before} → ${out.after}/${out.maxHp}${how}.`);
        } else {
          // Loud: a click that changed nothing means the button moved, the
          // siege ended, or the server refused. If the frame can say WHY, say
          // that instead of leaving you to guess.
          const why = out.blocked ? ` — ${out.blocked}` : "";
          live.update(`Heal did not take${why}. ${hero.name} is still ${out.before}/${out.maxHp}.`, true);
        }
      } catch (e) {
        console.warn("[Seneschal] heal failed:", e);
        live.update(`Could not heal ${hero.name}: ${e.message}`, true);
      } finally {
        this.healing.delete(key);
        this._paintHealing();
        // Re-read once the LAST heal lands, not after each. Refreshing between
        // concurrent heals re-renders the rows out from under the ones still
        // running, and costs a fetch per hero for a roster that is about to
        // change again anyway.
        if (!this.healing.size) this._refreshHeroes();
      }
    }

    /**
     * Repaint which heals are in flight.
     *
     * Keyed by hero + method rather than held on the element, because the
     * roster re-renders while heals are running and every button identity is
     * replaced. Same reasoning as _paintPending for menu entries.
     */
    _paintHealing() {
      if (!this.rail) return;
      for (const button of this.rail.querySelectorAll(".dk-method")) {
        const busy = this.healing.has(button.dataset.healKey);
        button.classList.toggle("dk-busy", busy);
        button.setAttribute("aria-busy", busy ? "true" : "false");
        if (busy && !button.querySelector(".dk-spinner")) {
          button.textContent = "";
          const spin = document.createElement("span");
          spin.className = "dk-spinner";
          button.appendChild(spin);
        } else if (!busy && button.querySelector(".dk-spinner")) {
          button.textContent = button.dataset.glyph || "";
        }
      }
    }

    // --- asking --------------------------------------------------------------

    /**
     * Ask a yes/no question in the dock's own panel, beside the rail.
     *
     * NEVER `confirm()`. Native dialogs are a hard no in this extension: they
     * are browser chrome, so they read as the browser speaking rather than us,
     * they cannot be styled or placed, they freeze the page and every timer on
     * it, and in an automated browser they hang the session outright. Anything
     * that needs an answer asks here.
     *
     * Questions QUEUE rather than replace one another. Only one is ever on
     * screen — two open panels beside the rail would be unreadable, and worse,
     * ambiguous about which one Enter answers — but firing five heal buttons in
     * a row used to answer the first four "no" without saying so. You pressed
     * five buttons and one hero got healed. They now line up and are asked in
     * the order you clicked.
     *
     * @returns {Promise<boolean>}
     */
    _ask({ title, body, confirmLabel = "Confirm" }) {
      return new Promise((resolve) => {
        this.askQueue.push({ title, body, confirmLabel, resolve });
        if (!this.askResolve) this._pumpAsk();
      });
    }

    /** Put the next queued question on screen, if nothing is being asked. */
    _pumpAsk() {
      const next = this.askQueue.shift();
      if (!next) return;
      this.askResolve = next.resolve;
      this.askTitleEl.textContent = next.title;
      this.askBodyEl.textContent = next.body || "";
      this.askBodyEl.hidden = !next.body;
      this.askYes.textContent = next.confirmLabel;
      this.ask.hidden = false;
      this.askYes.focus();
    }

    /** Settle the open question and show the next. Safe when nothing is open. */
    _closeAsk(answer) {
      if (this.ask) this.ask.hidden = true;
      const resolve = this.askResolve;
      this.askResolve = null;
      if (resolve) resolve(answer);
      if (this.askQueue.length) this._pumpAsk();
    }

    /** Answer everything still waiting with "no". Nothing queued ever spends. */
    _drainAsks() {
      const waiting = this.askQueue.splice(0);
      for (const q of waiting) q.resolve(false);
    }

    _span(className, text) {
      const el = document.createElement("span");
      el.className = className;
      el.textContent = text;
      return el;
    }

    /**
     * Mark an entry as in-flight, or clear it with null. Stored as state and
     * reapplied by _paintPending, because _render() rebuilds the whole rail
     * and would otherwise drop the indicator mid-hunt.
     */
    _setPending(pending) {
      this.pending = pending;
      this._paintPending();
      if (pending) {
        // Uses the toast's existing role="status", so it is announced rather
        // than being a purely visual spinner.
        this.busyToast(`${pending.label}…`);
      } else {
        this._clearBusyToast();
      }
    }

    _paintPending() {
      if (!this.rail) return;
      for (const btn of this.rail.querySelectorAll('.dk-btn[data-busy="true"]')) {
        btn.removeAttribute("data-busy");
        btn.removeAttribute("aria-busy");
        const icon = btn.querySelector(".dk-icon");
        if (icon && icon.dataset.glyph !== undefined) {
          icon.textContent = icon.dataset.glyph;
          delete icon.dataset.glyph;
          icon.classList.remove("dk-spinner");
        }
      }
      if (!this.pending) return;

      const btn = [...this.rail.querySelectorAll(".dk-btn")]
        .find((b) => b.dataset.id === this.pending.id);
      if (!btn) return; // entry was deleted mid-hunt; the toast still reports
      btn.setAttribute("data-busy", "true");
      btn.setAttribute("aria-busy", "true");
      const icon = btn.querySelector(".dk-icon");
      if (icon) {
        // Stash the glyph so it can be restored exactly, emoji included.
        icon.dataset.glyph = icon.textContent;
        icon.textContent = "";
        icon.classList.add("dk-spinner");
      }
    }

    /** Like toast(), but stays up until the hunt ends rather than timing out. */
    busyToast(message) {
      if (this.busyHandle) {
        this.busyHandle.update(message);
        return this.busyHandle;
      }
      this.busyHandle = this.toast(message, { busy: true });
      return this.busyHandle;
    }

    _clearBusyToast() {
      if (!this.busyHandle) return;
      this.busyHandle.dismiss();
      this.busyHandle = null;
    }

    _itemButton(item) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dk-btn";
      btn.dataset.id = item.id;
      btn.dataset.type = item.type;
      const fallbackIcon = item.type === "url" ? "•" : item.type === "host" ? "👻" : "◈";
      btn.title = this._itemTitle(item);
      btn.append(this._span("dk-icon", item.icon || fallbackIcon), this._span("dk-text", item.label));
      if (item.type === "host") {
        // Filled in by _paintSouls, which also runs after every re-render.
        const badge = this._span("dk-count", "");
        badge.dataset.role = "souls";
        btn.appendChild(badge);
      }
      btn.addEventListener("click", () => this.activate(item));
      return btn;
    }

    _itemTitle(item) {
      if (item.type === "url") return `${item.label} — ${item.path}`;
      if (item.type === "menu") return `${item.label} — menu entry "${item.match}"`;
      const size = SEN.config.clampSouls(item.souls);
      const base = `${item.label} — raise a spectral host of ${SEN.necro.formatCount(size)}`;
      if (!this.souls) return `${base}\nSoul balance not read yet`;
      const n = SEN.necro;
      const lines = [base];
      if (this.souls.host != null) {
        lines.push(
          `Standing host: ${n.formatCount(this.souls.host)} ghosts${this.souls.armed ? " (armed)" : " (not armed)"}`
        );
      }
      const pool = this.souls.dead == null ? "" : `, ${n.formatCount(this.souls.dead)} raisable dead`;
      lines.push(`${n.formatCount(this.souls.souls)} souls${pool}`);
      lines.push(`Read ${n.formatAge(this.souls.at)}`);
      return lines.join("\n");
    }

    /**
     * Write the cached balance onto every host entry. Separate from render()
     * because the balance updates on a poll and re-rendering the whole rail
     * four times a minute would fight with the pending spinner.
     */
    /**
     * The rail badge: souls and raisable dead, short-form.
     *
     * An em dash for "nothing read yet" rather than a zero — zero souls is a
     * real and actionable state, and showing it before we have looked would be
     * a lie about a number that gates a spend.
     */
    _soulsBadge() {
      if (!this.souls) return "—";
      const n = SEN.necro;
      // The HOST you have standing is the headline: it is the thing this
      // button manages, and the one number that says whether you need to act
      // at all. Souls and the pool are what it costs, and they go underneath.
      // A host that could not be read shows nothing rather than 0 — "you have
      // none" is exactly the reading that talks you into raising a second one.
      if (this.souls.host == null) return `${n.formatShort(this.souls.souls)}💀`;
      return `${n.formatShort(this.souls.host)}⚔${this.souls.armed ? "" : "·"}`;
    }

    /** The line under the rite: what a raise would draw on. */
    _soulsDetail() {
      if (!this.souls) return "";
      const n = SEN.necro;
      const bits = [`${n.formatCount(this.souls.souls)} souls`];
      if (this.souls.dead != null) bits.push(`${n.formatCount(this.souls.dead)} raisable`);
      return bits.join(" · ");
    }

    _paintSouls() {
      if (!this.rail) return;
      const fresh = this.souls && Date.now() - (this.souls.at || 0) < SOULS_FRESH_MS;
      const detail = this.rail.querySelector('[data-role="souls-detail"]');
      if (detail) {
        detail.textContent = this._soulsDetail();
        detail.hidden = !detail.textContent || this.settings.dock.collapsed;
      }
      for (const btn of this.rail.querySelectorAll('.dk-btn[data-type="host"]')) {
        const badge = btn.querySelector('[data-role="souls"]');
        if (!badge) continue;
        // Both currencies, because neither one alone tells you what you can
        // raise: souls are the catalyst, the fallen are the pool, and no
        // amount of sacrificing turns one into the other.
        badge.textContent = this._soulsBadge();
        badge.classList.toggle("dk-stale", !fresh);
        const item = this.settings.dock.items.find((it) => it.id === btn.dataset.id);
        if (item) btn.title = this._itemTitle(item);
      }
    }

    /**
     * Notice the balance whenever the rites panel is on screen.
     *
     * This is a poll rather than an observer because the number changes for
     * reasons that are not DOM mutations we can attribute (a raid resolving
     * elsewhere), and it costs one textContent read with a substring guard.
     * It does not run at all unless a host entry is configured, so users who
     * do not use the feature pay nothing.
     */
    _watchSouls() {
      clearInterval(this.soulsTimer);
      const look = () => {
        if (!this.settings.dock.items.some((it) => it.type === "host")) return;
        const reading = SEN.necro.readBalance(document);
        if (reading) this._recordSouls(reading);
      };
      look();
      this.soulsTimer = setInterval(look, SOULS_POLL_MS);
    }

    /**
     * Re-read what the rail displays, after a rite has changed it.
     *
     * The balance comes off whatever page is on screen when it happens to be
     * the rites; the standing host has no rendered source at all and needs its
     * own fetch. Both are caches, and both are allowed to fail quietly — a
     * stale badge is greyed, and a badge that cannot be read shows nothing
     * rather than a wrong number.
     */
    async _refreshRites() {
      const host = await SEN.necro.loadGhostHost();
      if (host) {
        this.souls = { ...(this.souls || { souls: 0 }), host: host.size, armed: host.armed, at: Date.now() };
        this._paintSouls();
        await store.set(SOULS_KEY, this.souls);
      }
    }

    _recordSouls(reading) {
      // Keep the standing host: it comes from a different source on a different
      // schedule, and a balance poll must not blank it.
      const kept = this.souls && this.souls.host != null
        ? { host: this.souls.host, armed: this.souls.armed }
        : {};
      const next = { ...kept, ...reading, at: Date.now() };
      const same =
        this.souls &&
        this.souls.souls === next.souls &&
        this.souls.dead === next.dead &&
        this.souls.disturbance === next.disturbance;
      this.souls = next;
      this._paintSouls();
      // Only persist a real change: writing every four seconds would churn
      // storage and wake every other tab's onChanged listener for nothing.
      if (!same) store.set(SOULS_KEY, next);
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
      // A rite spends resources and takes several steps; a second click
      // partway through would start a parallel run against the same page.
      if (this.running) return;
      if (item.type === "host") return this._raiseHost(item);
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
        this.toast(`Quick menu: "${path}" is not a usable link.`, true);
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
        this.toast(`Quick menu: "${item.label}" has a bad pattern — ${parsed.error}`, true);
        return;
      }

      const here = this._findNavMatch(item.match);
      if (here) {
        here.click();
        return;
      }
      if (!item.door) {
        this.toast(`Quick menu: nothing here is called "${item.match}", and "${item.label}" has no door set.`, true);
        return;
      }

      // Two belts: the in-memory watcher handles same-document SPA routing,
      // the sessionStorage record survives a full reload.
      const pending = { id: item.id, match: item.match, label: item.label, expires: Date.now() + RESOLVE_MS };
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
      // A rite pending from an older build: rites no longer navigate at all,
      // so there is nothing to resume and clicking the nav entry it names would
      // just move the user for no reason. Drop it.
      if (pending.rite) {
        session.clear(PENDING_KEY);
        this._setPending(null);
        return;
      }
      // A reload eats part of the budget; give the fresh page a full window.
      this._watchFor({ ...pending, expires: Date.now() + RESOLVE_MS });
    }

    /**
     * Hunt for a nav entry matching `pending.match` until it appears or the
     * deadline passes, then click it. A MutationObserver catches the sub-nav
     * swap; the interval is a backstop for a render that mutates nothing we
     * can see.
     *
     * @param {Object} pending
     * @param {boolean} [quiet] suppress the not-found toast, for callers that
     *   report the failure in their own words (the rite flow).
     * @returns {Promise<Element|null>} the element clicked, or null.
     */
    _watchFor(pending, quiet = false) {
      this._stopWatching();
      // Walking the door and waiting for the control can take the better part
      // of RESOLVE_MS, during which nothing on screen moves. Without this the
      // click reads as having done nothing.
      this._setPending(pending);

      return new Promise((resolve) => {
        const finish = (found) => {
          this._stopWatching();
          session.clear(PENDING_KEY);
          this._setPending(null);
          if (found) {
            found.click();
            resolve(found);
            return;
          }
          // LOUD failure. A pattern that stopped matching after a patch must
          // not look like a button that simply does nothing — hence the
          // warning styling and the longer dwell, not a plain confirmation.
          const message = `Quick menu: could not find a menu entry matching "${pending.match}".`;
          console.warn("[Seneschal]", message);
          if (!quiet) this.toast(message, true);
          resolve(null);
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
      });
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

    // --- rites ---------------------------------------------------------------

    /**
     * Raise a spectral host.
     *
     * The one thing in this extension that SPENDS something, so the shape is
     * deliberately: reach the panel → read it → work out the consequences →
     * show them → only then click. Every step can bail, and bailing is loud.
     * Nothing here acts on a number it has not read off the live page.
     */
    async _raiseHost(item) {
      this.running = true;
      const busy = (message) => this._setPending({ id: item.id, label: message });
      const refuse = (message) => {
        console.warn("[Seneschal]", message);
        this.toast(`Raise host: ${message}`, true);
      };

      try {
        busy("Reading the rites…");
        // Read the panel in a hidden frame rather than walking the user to it.
        // Loading a page and selecting a control costs GETs only (finding 11),
        // so this cannot disturb what is on screen — and being sent to
        // /necromancy and abandoned there was never the point of the button.
        const scope = await this._openRites();
        if (!scope) {
          refuse(
            "could not reach the rites page to read the soul balance. The game may have moved it again."
          );
          return;
        }
        const { doc, close } = scope;
        this._riteScope = close;

        const reading = SEN.necro.parseBalance(SEN.necro.blockText(doc.body));
        if (!reading) {
          refuse("reached the rites page but found no soul balance on it.");
          return;
        }

        const host = SEN.necro.findRiteCard("host", doc);
        if (!host) {
          refuse("no Spectral Host rite on this page, or it sits too close to another rite to tell them apart.");
          return;
        }
        const hostButton = SEN.necro.performButton(host);
        if (!hostButton) {
          refuse("found the Spectral Host rite but not the button that performs it.");
          return;
        }
        // A disabled button is the game's own refusal — it knows the balance
        // and the pool better than we do. Report that rather than clicking a
        // no-op and then blaming the balance for not moving.
        if (SEN.necro.isBlocked(hostButton)) {
          refuse(
            `the game has the Spectral Host button disabled right now (it reads "${SEN.scanner.labelOf(hostButton)}"). Nothing was performed.`
          );
          return;
        }

        // How the size of the host gets decided. If we cannot tell, we stop:
        // performing a rite without knowing what it spends is the one thing
        // this must never do.
        const sizing = this._sizing(host, hostButton);
        if (sizing.kind === "unknown") {
          refuse(
            "the Spectral Host rite has no size field and its button does not say what it costs, so there is no way to know what performing it would spend."
          );
          return;
        }
        const want = sizing.kind === "fixed" ? sizing.cost : SEN.config.clampSouls(item.souls);

        // The rate converting a host size into a price is stated on the card
        // itself ("Costs 1 dead + 1 soul per 1,000 raised"). Read it; never
        // assume it. Assuming one soul per ghost overstated a 10,000 host by a
        // factor of a thousand, and the only thing that stopped that becoming
        // forty sacrifices was an unrelated wording difference on another
        // button. plan() refuses outright when this comes back null.
        const rate = SEN.necro.parseHostRate(SEN.necro.blockText(host.el));
        if (!rate) {
          refuse(
            "the Spectral Host rite does not say what it costs per ghost raised, so there is no way to price the click. Nothing was performed."
          );
          return;
        }
        const deadHave = reading.dead;

        const harvest = SEN.necro.findRiteCard("harvest", doc);
        const harvestButton = harvest ? SEN.necro.performButton(harvest) : null;
        const perHarvest = harvestButton
          ? SEN.necro.parseSoulDelta(SEN.scanner.labelOf(harvestButton))
          : null;

        const plan = SEN.necro.plan({
          have: reading.souls,
          want,
          rate,
          deadHave,
          perHarvest: perHarvest && perHarvest > 0 ? perHarvest : null,
          disturbance: reading.disturbance,
          tolerance: reading.tolerance,
          raiseDisturb: SEN.necro.parseDisturbDelta(host.el.textContent),
          harvestDisturb: harvest ? SEN.necro.parseDisturbDelta(harvest.el.textContent) : null,
        });

        this._setPending(null);
        const choice = await this._confirmRite(plan, sizing);
        if (!choice) return; // cancelled, or dismissed

        const target = choice === "raise-less" ? plan.canRaiseInstead : plan.want;
        const harvests = choice === "harvest" ? plan.harvests : 0;
        // The frame the plan was read from is deliberately CLOSED before
        // performing. Its document has been sitting open while the user read
        // the sheet, so its buttons are as stale as the numbers on them; the
        // rite reopens and re-reads, and refuses if the balance moved.
        close();
        this._riteScope = null;
        await this._performRite({ item, target, harvests, sizing, busy, expectSouls: reading.souls });
      } catch (err) {
        const message = (err && err.message) || String(err);
        console.warn("[Seneschal] raise host:", err);
        this.toast(`Raise host: ${message}`, true);
      } finally {
        if (this._riteScope) {
          this._riteScope();
          this._riteScope = null;
        }
        this.running = false;
        this._setPending(null);
      }
    }

    /**
     * Open the rites in a hidden frame and hand back its document.
     *
     * @returns {Promise<{doc:Document, close:Function}|null>}
     */
    async _openRites() {
      let frame = null;
      try {
        frame = SEN.heroes.openFrame(SEN.necro.RITES_PATH);
        await frame.ready;
        await sleep(SEN.heroes.SETTLE_MS);
        const doc = frame.el.contentDocument;
        if (!doc || !doc.body) throw new Error("no document in the rites frame");
        const close = frame.close;
        return { doc, close };
      } catch (e) {
        if (frame) frame.close();
        if (!SEN.heroes.isAbort(e)) console.warn("[Seneschal] rites frame:", e);
        return null;
      }
    }

    /**
     * How this rite decides how many ghosts to raise.
     *   input   — a field we can set, so the configured size applies
     *   fixed   — no field, but the button states its cost, so the rite has one
     *             size and we can still tell the user exactly what it spends
     *   unknown — neither; refuse
     */
    _sizing(card, button) {
      const input = SEN.necro.sizeInput(card);
      if (input) return { kind: "input", input };
      const delta = SEN.necro.parseSoulDelta(SEN.scanner.labelOf(button));
      if (delta != null && delta < 0) return { kind: "fixed", cost: Math.abs(delta) };
      return { kind: "unknown" };
    }

    /**
     * The rites used to be reached by NAVIGATING to them — walk the door, hunt
     * the nav label, and leave the user standing on /necromancy whether or not
     * they wanted to be there. That whole path is gone: _openRites loads the
     * page in a hidden frame instead, so the button performs a rite rather than
     * performing a page change. The `match` and `door` fields on a host entry
     * are kept only as the record of where the panel is; RITES_PATH is what is
     * actually loaded.
     */

    /**
     * Wait for a rite to actually change the balance.
     * @returns {Object|null} the new reading, or null if nothing moved — which
     *   the caller must treat as "stop", never as "click it again".
     */
    async _awaitSoulChange(before, doc = document, ms = RITE_SETTLE_MS) {
      const stop = Date.now() + ms;
      for (;;) {
        await sleep(150);
        const reading = SEN.necro.parseBalance(SEN.necro.blockText(doc.body));
        if (reading && reading.souls !== before) {
          // Only a reading of the page the USER is on belongs in the cache; a
          // frame's numbers are the same account, so record either.
          this._recordSouls(reading);
          return reading;
        }
        if (Date.now() >= stop) return null;
      }
    }

    /**
     * Do the thing the user just approved.
     *
     * The harvest loop re-finds its button every pass (the panel re-renders
     * after each rite, so a held reference goes stale) and stops dead the
     * first time a click fails to move the balance. That check is the
     * difference between "the yield was smaller than advertised" and "we are
     * clicking something that is not the harvest button, forty times".
     */
    async _performRite({ item, target, harvests, sizing, busy, expectSouls }) {
      // Reopened fresh: the frame the plan was read from sat open while the
      // user read the sheet, so every button in it is as stale as the numbers
      // that were on it. This one is seconds old and is re-read before it acts.
      busy("Opening the rites…");
      const scope = await this._openRites();
      if (!scope) throw new Error("could not reach the rites to perform them.");
      const { doc, close } = scope;
      this._riteScope = close;

      try {
        let done = 0;
        let expect = expectSouls;
        for (let i = 0; i < harvests; i++) {
          busy(`Soul-Harvest ${i + 1} of ${harvests}…`);
          const card = SEN.necro.findRiteCard("harvest", doc);
          const button = card ? SEN.necro.performButton(card) : null;
          if (!button) {
            throw new Error(
              `the Soul-Harvest button vanished after ${done} sacrifice${done === 1 ? "" : "s"} — stopped, nothing raised.`
            );
          }
          if (SEN.necro.isBlocked(button)) {
            throw new Error(
              `the Soul-Harvest button is disabled after ${done} sacrifice${done === 1 ? "" : "s"} — stopped, nothing raised.`
            );
          }
          const before = (SEN.necro.parseBalance(SEN.necro.blockText(doc.body)) || {}).souls;
          button.click();
          const after = await this._awaitSoulChange(before, doc);
          if (!after) {
            throw new Error(
              `Soul-Harvest ${i + 1} did not change the balance — stopped after ${done} sacrifice${done === 1 ? "" : "s"}, nothing raised.`
            );
          }
          expect = after.souls;
          done += 1;
        }

        busy(`Raising ${SEN.necro.formatCount(target)}…`);
        const out = await SEN.necro.raiseInFrame({ want: target, expectSouls: expect, doc });
        this._setPending(null);
        if (!out.raised) {
          const why = out.blocked ? ` — ${out.blocked}` : "";
          this.toast(
            `Raise host: clicked Spectral Host but the balance did not move${why}${done ? ` (${done} sacrifice${done === 1 ? "" : "s"} were made)` : ""}.`,
            true
          );
          return;
        }
        this.toast(
          `Raised ${SEN.necro.formatCount(out.want)} ghosts — ${SEN.necro.formatCount(out.spent)} souls spent, ${SEN.necro.formatCount(out.after)} left.`
        );
        this._refreshRites();
      } finally {
        if (this._riteScope) {
          this._riteScope();
          this._riteScope = null;
        }
      }
    }

    // --- confirmation sheet ---------------------------------------------------

    /** Build the modal for a plan and wait for the user's answer. */
    _confirmRite(plan, sizing) {
      const n = SEN.necro;
      const readings = [["Souls", n.formatCount(plan.have)]];
      // The dead are the other half of the price and are NOT interchangeable
      // with souls — no sacrifice refills the pool — so the sheet shows both
      // rather than letting "souls" stand in for the whole cost.
      if (plan.deadHave != null) readings.push(["Raisable dead", n.formatCount(plan.deadHave)]);
      if (plan.cost) readings.push(["This rite costs", n.priceOf(plan)]);
      if (plan.disturbance != null) {
        readings.push([
          "Disturbance",
          plan.tolerance != null
            ? `${n.formatCount(plan.disturbance)} / ${n.formatCount(plan.tolerance)}`
            : n.formatCount(plan.disturbance),
        ]);
      }

      let body = n.describe(plan);
      if (sizing.kind === "fixed") {
        body += " This rite has one size and does not take a number, so the size in your settings does not apply.";
      }

      const warnings = [];
      if (plan.disturbanceWarning) {
        warnings.push(
          `This would take Disturbance to ${n.formatCount(plan.disturbanceAfter)}, past the ${n.formatCount(plan.tolerance)} the grounds tolerate — they turn Haunted.`
        );
      }
      if (plan.kind === "harvest") {
        warnings.push("Soul-Harvest sacrifices living veterans. It cannot be undone.");
      }

      const actions = [];
      if (plan.kind === "raise") {
        actions.push({ id: "raise", label: `Raise ${n.formatCount(plan.want)}`, kind: "primary" });
      } else if (plan.kind === "harvest") {
        actions.push({
          id: "harvest",
          label: `Sacrifice ${plan.harvests}×, then raise`,
          kind: "danger",
        });
        if (plan.canRaiseInstead > 0 && sizing.kind === "input") {
          actions.push({ id: "raise-less", label: `Raise ${n.formatCount(plan.canRaiseInstead)} instead` });
        }
      } else if (plan.canRaiseInstead > 0 && sizing.kind === "input") {
        actions.push({ id: "raise-less", label: `Raise ${n.formatCount(plan.canRaiseInstead)} instead`, kind: "primary" });
      }

      return this._openSheet({
        title: "Raise a spectral host",
        readings,
        body,
        warnings,
        actions,
        // On anything destructive or refused, Cancel holds focus so Enter is
        // never the key that spends something.
        focus: plan.kind === "raise" ? "primary" : "cancel",
      });
    }

    /**
     * Show the sheet. Resolves with an action id, or null for cancel.
     * Only one can be open at a time — activate() gates on `running`.
     */
    _openSheet({ title, readings = [], body = "", warnings = [], actions = [], focus = "cancel" }) {
      const sheet = this.sheet;
      sheet.querySelector("h2").textContent = title;

      const dl = sheet.querySelector(".dk-read");
      dl.textContent = "";
      for (const [term, value] of readings) {
        const pair = document.createElement("div");
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = value;
        pair.append(dt, dd);
        dl.appendChild(pair);
      }
      dl.hidden = !readings.length;

      sheet.querySelector(".dk-sheet-body").textContent = body;
      const warn = sheet.querySelector(".dk-sheet-warn");
      warn.textContent = warnings.join(" ");
      warn.hidden = !warnings.length;

      const bar = sheet.querySelector(".dk-sheet-actions");
      bar.textContent = "";

      return new Promise((resolve) => {
        let settled = false;
        const close = (value) => {
          if (settled) return;
          settled = true;
          document.removeEventListener("keydown", onKey, true);
          this.scrim.hidden = true;
          resolve(value);
        };

        const onKey = (e) => {
          if (e.key !== "Escape") return;
          e.preventDefault();
          // The game handles keys too, and a re-render mid-dialog is exactly
          // the kind of thing that eats the click that follows.
          e.stopPropagation();
          close(null);
        };
        document.addEventListener("keydown", onKey, true);

        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "dk-cancel";
        cancel.textContent = "Cancel";
        cancel.addEventListener("click", () => close(null));

        const made = actions.map((action) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "dk-primary" + (action.kind === "danger" ? " dk-danger" : "");
          btn.textContent = action.label;
          btn.addEventListener("click", () => close(action.id));
          return btn;
        });

        bar.append(cancel, ...made);
        this.scrim.hidden = false;
        // Clicking away is a cancel, but only on the scrim itself — a click
        // that started inside the sheet must not dismiss it.
        this.scrim.onclick = (e) => {
          if (e.target === this.scrim) close(null);
        };

        const preferred = focus === "primary" ? made[0] || cancel : cancel;
        preferred.focus();
      });
    }

    // --- add form ------------------------------------------------------------
    _openForm() {
      // One panel beside the rail at a time. Opening the add form abandons any
      // question in flight AND anything queued behind it — walking away from a
      // heal you were asked about must not leave four more waiting to pounce.
      this._drainAsks();
      this._closeAsk(false);
      this.form.hidden = false;
      this._showError("");
      const label = this.wrap.querySelector("#dk-label");
      label.value = this._guessLabel();
      this.wrap.querySelector("#dk-path").value = location.pathname + location.search;
      this.wrap.querySelector("#dk-match").value = "";
      this.wrap.querySelector("#dk-door").value = "";
      this.wrap.querySelector("#dk-souls").value = String(SEN.config.SOULS_DEFAULT);
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
        // `data-for` holds a space-separated list: a host entry needs the same
        // match/door fields a menu entry does.
        field.hidden = !field.dataset.for.split(/\s+/).includes(type);
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
        souls: this.wrap.querySelector("#dk-souls").value,
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

    /** Press the game's own heal-all, quoting its own price back to you. */
    async _healAll(button) {
      const go = await this._ask({
        title: "Heal every wounded hero?",
        // The game's own costing, quoted verbatim — it picks the elixirs and
        // does the arithmetic, and a second implementation would eventually
        // disagree with it.
        body: this.healAll?.summary || "",
        confirmLabel: "Heal all",
      });
      if (!go) return;

      button.disabled = true;
      button.classList.add("dk-busy");
      try {
        const out = await SEN.heroes.healAll();
        if (out.healed) {
          this.toast(`Mended ${out.wounded} hero${out.wounded === 1 ? "" : "es"}, +${out.gained} HP.`);
        } else {
          const why = out.blocked ? ` — ${out.blocked}` : " — nothing changed.";
          this.toast(`Heal all did not take${why}`, true);
        }
      } catch (e) {
        console.warn("[Seneschal] heal all failed:", e);
        this.toast(`Could not heal all: ${e.message}`, true);
      } finally {
        button.classList.remove("dk-busy");
        this._refreshHeroes();
      }
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
        this.toast("Open the Seneschal options from chrome://extensions to configure the quick menu.", true);
      }
    }

    // --- toasts --------------------------------------------------------------

    /**
     * Post a message beside the rail. Several can be up at once.
     *
     * A single slot was fine while every message answered a click you had just
     * made. It stopped being fine the moment actions ran CONCURRENTLY: healing
     * five heroes lands five results seconds apart, and each one overwrote the
     * last, so you saw one line and had no idea the other four had happened.
     *
     * @param {string} message
     * @param {boolean|{warning?:boolean, busy?:boolean}} [opts] `true` still
     *   means "warning", so the fifteen existing call sites read unchanged.
     * @returns {{update:Function, dismiss:Function, el:Element}} a handle, so a
     *   slow action can post "Healing X…" and later become its own result
     *   rather than leaving a stale line and adding a second one.
     */
    toast(message, opts = false) {
      const { warning = false, busy = false } =
        typeof opts === "boolean" ? { warning: opts } : opts || {};

      const el = document.createElement("div");
      el.className = "dk-toast" + (warning ? " dk-warn" : "");
      const spinner = document.createElement("span");
      spinner.className = "dk-spinner dk-toast-spin";
      const text = document.createElement("span");
      text.className = "dk-toast-text";
      text.textContent = message;
      if (busy) el.appendChild(spinner);
      el.appendChild(text);

      // Newest at the bottom, nearest the eye's last stop. Oldest goes when the
      // stack is full, so a burst of results can never march off screen.
      this.toastStack.appendChild(el);
      while (this.toastStack.children.length > MAX_TOASTS) {
        this.toastStack.firstElementChild.remove();
      }
      this._positionToasts();

      let timer = null;
      const arm = (ms) => {
        clearTimeout(timer);
        timer = setTimeout(() => handle.dismiss(), ms);
      };
      const handle = {
        el,
        /** Turn a "…in flight" line into its own result, in place. */
        update(next, nextOpts = false) {
          const o = typeof nextOpts === "boolean" ? { warning: nextOpts } : nextOpts || {};
          text.textContent = next;
          el.classList.toggle("dk-warn", Boolean(o.warning));
          if (o.busy) {
            if (!spinner.isConnected) el.insertBefore(spinner, text);
            clearTimeout(timer);
          } else {
            spinner.remove();
            arm(o.warning ? TOAST_WARNING_MS : TOAST_MS);
          }
          return handle;
        },
        dismiss() {
          clearTimeout(timer);
          el.remove();
        },
      };
      // A busy toast has no deadline: it is up because something is still
      // happening, and it comes down when that thing reports.
      if (!busy) arm(warning ? TOAST_WARNING_MS : TOAST_MS);
      return handle;
    }

    /**
     * Sit the stack BESIDE the rail rather than in a screen corner.
     *
     * Measured, because the rail's width is its content's: it changes when the
     * menu changes, when it collapses, and when the hero panel appears. CSS
     * alone cannot follow that, so the rail's own box drives the offset and the
     * stack tracks whichever edge the rail is pinned to.
     */
    _positionToasts() {
      if (!this.toastStack || !this.rail) return;
      // getBoundingClientRect forces layout, and this runs on every render
      // (CLAUDE.md finding 6). Nothing to place means nothing to measure.
      if (!this.toastStack.children.length) return;
      const r = this.rail.getBoundingClientRect();
      const side = this.settings.dock.side === "left" ? "left" : "right";
      this.toastStack.classList.toggle("dk-toasts-left", side === "left");
      const gap = 12;
      if (side === "left") {
        this.toastStack.style.left = `${Math.round(r.right + gap)}px`;
        this.toastStack.style.right = "auto";
      } else {
        this.toastStack.style.right = `${Math.round(window.innerWidth - r.left + gap)}px`;
        this.toastStack.style.left = "auto";
      }
      // Bottom-aligned with the rail, growing upward, so a new message never
      // shifts the ones already being read.
      this.toastStack.style.bottom = `${Math.max(8, Math.round(window.innerHeight - r.bottom))}px`;
    }
  }

  SEN.Dock = Dock;
})();
