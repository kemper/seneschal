/**
 * options.js — the quick menu editor.
 *
 * Holds a working copy of the config, validates it through src/config.js (the
 * same code the dock uses, so the editor can never accept something the dock
 * would then reject), and writes to chrome.storage.local. Open tabs pick the
 * change up live via chrome.storage.onChanged.
 *
 * Rows are only re-rendered on a STRUCTURAL change — add, remove, move, or a
 * change of type. Typing edits state in place, so the caret does not jump.
 */
(function () {
  "use strict";

  const CFG = globalThis.SEN.config;

  const els = {
    paletteEnabled: document.getElementById("palette-enabled"),
    enabled: document.getElementById("enabled"),
    heroesEnabled: document.getElementById("heroes-enabled"),
    sides: [...document.querySelectorAll('input[name="side"]')],
    items: document.getElementById("items"),
    add: document.getElementById("add"),
    exportBtn: document.getElementById("export"),
    importBtn: document.getElementById("import"),
    reset: document.getElementById("reset"),
    json: document.getElementById("json"),
    status: document.getElementById("status"),
  };

  let state = CFG.defaults();
  let saveTimer = null;

  // --- status ---------------------------------------------------------------
  function say(message, bad = false) {
    els.status.textContent = message;
    els.status.classList.toggle("bad", bad);
  }

  // --- persistence ----------------------------------------------------------
  async function load() {
    let stored = null;
    try {
      stored = (await chrome.storage.local.get(CFG.STORAGE_KEY))?.[CFG.STORAGE_KEY] ?? null;
    } catch {
      say("Could not read saved settings; showing the defaults.", true);
    }
    const { config, problems } = CFG.normalize(stored);
    state = config;
    if (problems.length) say(problems.join(" · "), true);
    renderAll();
  }

  /**
   * Save, but only if every row is currently valid — a half-typed path must
   * not wipe the entry out from under the user in another tab.
   */
  function save(reason) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const bad = state.dock.items.map((it) => CFG.validateItem(it)).filter((r) => !r.ok);
      if (bad.length) {
        say(`Not saved — ${bad.length} entr${bad.length === 1 ? "y" : "ies"} still needs attention.`, true);
        return;
      }
      try {
        await chrome.storage.local.set({ [CFG.STORAGE_KEY]: state });
        say(reason || "Saved.");
      } catch (e) {
        say(`Could not save: ${e.message}`, true);
      }
    }, 160);
  }

  // --- render ---------------------------------------------------------------
  function renderAll() {
    els.paletteEnabled.checked = state.palette.enabled;
    els.enabled.checked = state.dock.enabled;
    els.heroesEnabled.checked = state.heroes.enabled;
    for (const radio of els.sides) radio.checked = radio.value === state.dock.side;
    renderItems();
    els.json.value = JSON.stringify(state, null, 2);
  }

  function renderItems() {
    els.items.textContent = "";
    if (!state.dock.items.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No entries yet. Add one, or add pages from the ＋ button on the rail itself.";
      els.items.appendChild(empty);
      return;
    }
    state.dock.items.forEach((item, index) => els.items.appendChild(renderItem(item, index)));
  }

  function field(placeholder, value, onInput, label) {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder;
    input.value = value || "";
    input.setAttribute("aria-label", label || placeholder);
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  function renderItem(item, index) {
    const row = document.createElement("div");
    row.className = "item";

    const touch = () => {
      validateRow(row, item);
      els.json.value = JSON.stringify(state, null, 2);
      save();
    };

    row.appendChild(
      field("🏰", item.icon, (v) => {
        item.icon = v;
        touch();
      }, "Icon")
    );
    row.appendChild(
      field("Label", item.label, (v) => {
        item.label = v;
        touch();
      }, "Label")
    );

    const type = document.createElement("select");
    type.setAttribute("aria-label", "Entry type");
    for (const [value, text] of [["url", "Path"], ["menu", "Menu entry"]]) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = text;
      type.appendChild(opt);
    }
    type.value = item.type;
    type.addEventListener("change", () => {
      item.type = type.value;
      renderItems(); // structural: the target fields change shape
      save();
    });
    row.appendChild(type);

    const stack = document.createElement("div");
    stack.className = "stack";
    if (item.type === "url") {
      stack.appendChild(
        field("/market", item.path, (v) => {
          item.path = v;
          touch();
        }, "Path")
      );
    } else {
      stack.appendChild(
        field("craftables  or  /^hunt/i", item.match, (v) => {
          item.match = v;
          touch();
        }, "Menu entry name")
      );
      stack.appendChild(
        field("Open first, if needed: /empire", item.door, (v) => {
          item.door = v;
          touch();
        }, "Open first")
      );
    }
    row.appendChild(stack);

    const moves = document.createElement("div");
    moves.className = "moves";
    moves.append(
      iconButton("↑", "Move up", index > 0, () => move(index, -1)),
      iconButton("↓", "Move down", index < state.dock.items.length - 1, () => move(index, 1)),
      iconButton("✕", "Remove", true, () => remove(index))
    );
    row.appendChild(moves);

    const error = document.createElement("p");
    error.className = "error";
    row.appendChild(error);
    validateRow(row, item);
    return row;
  }

  function iconButton(glyph, title, enabled, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon";
    btn.textContent = glyph;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.disabled = !enabled;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function validateRow(row, item) {
    const result = CFG.validateItem(item);
    row.classList.toggle("invalid", !result.ok);
    row.querySelector(".error").textContent = result.ok ? "" : result.reason;
  }

  // --- mutations ------------------------------------------------------------
  function move(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= state.dock.items.length) return;
    const [item] = state.dock.items.splice(index, 1);
    state.dock.items.splice(target, 0, item);
    renderItems();
    els.json.value = JSON.stringify(state, null, 2);
    save("Reordered.");
  }

  function remove(index) {
    const [gone] = state.dock.items.splice(index, 1);
    renderItems();
    els.json.value = JSON.stringify(state, null, 2);
    save(`Removed "${gone.label}".`);
  }

  // --- wiring ---------------------------------------------------------------
  els.paletteEnabled.addEventListener("change", () => {
    state.palette.enabled = els.paletteEnabled.checked;
    els.json.value = JSON.stringify(state, null, 2);
    save(state.palette.enabled ? "Command palette on." : "Command palette off.");
  });

  els.heroesEnabled.addEventListener("change", () => {
    state.heroes.enabled = els.heroesEnabled.checked;
    els.json.value = JSON.stringify(state, null, 2);
    save(state.heroes.enabled ? "Hero panel on." : "Hero panel off.");
  });

  els.enabled.addEventListener("change", () => {
    state.dock.enabled = els.enabled.checked;
    els.json.value = JSON.stringify(state, null, 2);
    save(state.dock.enabled ? "Quick menu on." : "Quick menu hidden.");
  });

  for (const radio of els.sides) {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      state.dock.side = radio.value;
      els.json.value = JSON.stringify(state, null, 2);
      save(`Moved to the ${radio.value}.`);
    });
  }

  els.add.addEventListener("click", () => {
    state.dock.items.push({ id: CFG.newId(), icon: "", label: "", type: "url", path: "" });
    renderItems();
    els.json.value = JSON.stringify(state, null, 2);
    const inputs = els.items.querySelectorAll(".item:last-of-type input");
    if (inputs[1]) inputs[1].focus();
    say("Give the new entry a label and a path.");
  });

  els.exportBtn.addEventListener("click", async () => {
    els.json.value = JSON.stringify(state, null, 2);
    els.json.select();
    try {
      await navigator.clipboard.writeText(els.json.value);
      say("Copied to the clipboard.");
    } catch {
      say("Selected below — copy it with Cmd-C / Ctrl-C.");
    }
  });

  els.importBtn.addEventListener("click", () => {
    let parsed;
    try {
      parsed = JSON.parse(els.json.value);
    } catch (e) {
      say(`That is not valid JSON: ${e.message}`, true);
      return;
    }
    const { config, problems } = CFG.normalize(parsed);
    state = config;
    renderAll();
    save(problems.length ? `Imported. ${problems.join(" · ")}` : "Imported.");
  });

  els.reset.addEventListener("click", () => {
    state = CFG.defaults();
    renderAll();
    save("Reset to the default menu.");
  });

  load();
})();
