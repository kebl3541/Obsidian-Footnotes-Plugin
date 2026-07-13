import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";
import {
  FootnoteDefinition,
  FootnoteSnapshot,
  definitionLabelOnLine,
  findDefinition,
  insertFootnoteAt,
  nearestReference,
  nextNumericLabel,
  nthReferencedLabel,
  referenceAt,
  renderDefinition,
  snapshotFootnotes,
  tidyFootnotes,
} from "./footnotes";

interface FootnoteEditorSettings {
  // When true, new footnotes are numbered 1, 2, 3...; otherwise you're prompted
  // for a custom label before the note is inserted.
  autoNumber: boolean;
  // When true, clicking a footnote marker opens the edit popup instead of just
  // previewing / jumping to the definition at the end of the note.
  clickToEdit: boolean;
  // Word-like discipline: deleting a definition removes its markers (and vice
  // versa), numeric footnotes stay numbered in reading order, and the
  // definitions block stays sorted.
  autoTidy: boolean;
}

const DEFAULT_SETTINGS: FootnoteEditorSettings = {
  autoNumber: true,
  clickToEdit: true,
  autoTidy: true,
};

// How long the note must be quiet before tidying runs. Long enough not to
// fight a half-typed edit, short enough to feel immediate.
const TIDY_DEBOUNCE_MS = 700;

// The slice of Obsidian's command registry we touch when taking over the
// built-in insert-footnote command (not part of the public typings).
interface CommandLike {
  editorCallback?: (editor: Editor, view: MarkdownView) => unknown;
  callback?: () => unknown;
  checkCallback?: (checking: boolean) => boolean | void;
  editorCheckCallback?: (checking: boolean, editor: Editor, view: MarkdownView) => boolean | void;
}

export default class FootnoteEditorPlugin extends Plugin {
  settings: FootnoteEditorSettings = DEFAULT_SETTINGS;
  // Pre-edit footnote state per file, so a deletion can be recognized for
  // what it was once the editor goes quiet.
  private snapshots = new Map<string, FootnoteSnapshot>();
  private tidyTimer: number | null = null;
  private applyingTidy = false;
  private coreInsert: { cmd: CommandLike; backup: CommandLike } | null = null;
  // Where the context menu was opened. Ctrl+click on macOS opens the menu
  // WITHOUT moving the text cursor, so menu-driven inserts must anchor to
  // the click, not to a possibly stale cursor.
  private lastCtxClick: { x: number; y: number; ts: number } | null = null;

  async onload() {
    await this.loadSettings();

    // Take over Obsidian's built-in "Insert footnote" while this plugin is
    // enabled: hotkeys, the command palette entry, and toolbar buttons that
    // call it all go through the atomic insert (marker born with its final
    // reading-order number). Restored untouched on unload.
    const registry = (
      this.app as unknown as {
        commands?: { commands?: Record<string, CommandLike> };
      }
    ).commands?.commands;
    const core = registry?.["editor:insert-footnote"];
    if (core) {
      this.coreInsert = {
        cmd: core,
        backup: {
          editorCallback: core.editorCallback,
          callback: core.callback,
          checkCallback: core.checkCallback,
          editorCheckCallback: core.editorCheckCallback,
        },
      };
      core.callback = undefined;
      core.checkCallback = undefined;
      core.editorCheckCallback = undefined;
      core.editorCallback = (editor: Editor) => {
        void this.debugLog("insert via CORE editor:insert-footnote");
        this.insertFootnote(editor);
      };
    }

    this.addCommand({
      id: "insert-footnote",
      name: "Insert footnote at cursor",
      editorCallback: (editor) => this.insertFootnote(editor),
    });

    this.addCommand({
      id: "edit-footnote-at-cursor",
      name: "Edit footnote at cursor",
      editorCallback: (editor) => this.editFootnoteAtCursor(editor),
    });

    this.addRibbonIcon("edit", "Insert footnote", () => {
      const editor = this.app.workspace.activeEditor?.editor;
      if (editor) this.insertFootnote(editor);
    });

    // Click a footnote number anywhere (Live Preview or Reading view) to edit it
    // in place. Capture phase so we can stop the default jump-to-definition.
    // Registered per-window so popout windows work too.
    const registerClickHandler = (doc: Document) =>
      this.registerDomEvent(
        doc,
        "click",
        (evt) => this.handleFootnoteClick(evt),
        { capture: true }
      );
    registerClickHandler(activeDocument);
    this.registerEvent(
      this.app.workspace.on("window-open", (win) =>
        registerClickHandler(win.doc)
      )
    );

    const recordCtx = (evt: MouseEvent) => {
      this.lastCtxClick = { x: evt.clientX, y: evt.clientY, ts: Date.now() };
    };
    this.registerDomEvent(activeDocument, "contextmenu", recordCtx, { capture: true });
    this.registerEvent(
      this.app.workspace.on("window-open", (win) =>
        this.registerDomEvent(win.doc, "contextmenu", recordCtx, { capture: true })
      )
    );

    // The editor context menu carries Obsidian's own "Insert footnote" item,
    // which does not go through the command we took over. Swap its action for
    // the atomic insert so the right-click path also produces a footnote born
    // with its final reading-order number.
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        if (!this.settings.autoNumber || !this.settings.autoTidy) return;
        interface MenuItemLike {
          titleEl?: HTMLElement;
          dom?: HTMLElement;
          callback?: () => unknown;
          onClick?: (cb: () => unknown) => unknown;
          submenu?: { items?: MenuItemLike[] } | null;
        }
        const run = () => {
          void this.debugLog("insert via CONTEXT MENU (core item, intercepted)");
          // Anchor to where the menu was opened; a macOS Ctrl+click opens
          // the menu without ever moving the text cursor there.
          const ctx = this.lastCtxClick;
          if (ctx && Date.now() - ctx.ts < 10000) {
            const cm = (
              editor as unknown as {
                cm?: { posAtCoords: (c: { x: number; y: number }) => number | null };
              }
            ).cm;
            const pos = cm?.posAtCoords({ x: ctx.x, y: ctx.y });
            if (pos !== null && pos !== undefined) {
              editor.setCursor(editor.offsetToPos(pos));
            }
          }
          this.insertFootnote(editor);
        };
        // The core item lives in the "Insert" submenu ("Insert ▸ Footnote"),
        // so walk the whole tree; titles vary between the two placements.
        const walk = (items: MenuItemLike[] | undefined, depth: number) => {
          if (!items || depth > 3) return;
          for (const it of items) {
            const title = (it.titleEl?.textContent ?? it.dom?.textContent ?? "")
              .trim()
              .toLowerCase();
            if (title === "insert footnote" || title === "footnote") {
              if (typeof it.onClick === "function") it.onClick(run);
              else it.callback = run;
            }
            walk(it.submenu?.items, depth + 1);
          }
        };
        const patch = () =>
          walk((menu as unknown as { items?: MenuItemLike[] }).items, 0);
        patch();
        // Core may append its items around plugin handlers; catch both orders.
        window.setTimeout(patch, 0);
      })
    );

    // Word-like tidying: watch for edits, and once the note goes quiet,
    // reconcile markers, definitions, numbering, and definition order.
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.captureBaseline())
    );
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.captureBaseline())
    );
    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, info) => {
        if (!this.settings.autoTidy || this.applyingTidy) return;
        const path = info.file?.path;
        if (!path) return;
        if (!this.snapshots.has(path)) {
          this.snapshots.set(path, snapshotFootnotes(editor.getValue().split("\n")));
          return;
        }
        if (this.tidyTimer !== null) window.clearTimeout(this.tidyTimer);
        this.tidyTimer = window.setTimeout(() => {
          this.tidyTimer = null;
          const mapping = this.tidyNow(editor, path);
          if (mapping.size > 0) {
            void this.debugLog(
              `WATCHER renumbered {${[...mapping.entries()].map(([a, b]) => `${a}→${b}`).join(",")}} in ${path} — an insert bypassed the plugin`
            );
          }
        }, TIDY_DEBOUNCE_MS);
      })
    );
    this.app.workspace.onLayoutReady(() => this.captureBaseline());

    this.addSettingTab(new FootnoteEditorSettingTab(this.app, this));
  }

  private captureBaseline() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const path = view?.file?.path;
    if (!view || !path) return;
    this.snapshots.set(path, snapshotFootnotes(view.editor.getValue().split("\n")));
  }

  // Run one tidy pass now. Returns the renumbering map so callers can follow
  // a label they just inserted.
  private tidyNow(editor: Editor, path: string | null): Map<string, string> {
    const prev = path ? this.snapshots.get(path) ?? null : null;
    const result = tidyFootnotes(prev, editor.getValue());
    if (result.changed) {
      this.applyingTidy = true;
      try {
        this.replaceWholeDoc(editor, result.text);
      } finally {
        this.applyingTidy = false;
      }
      for (const label of result.removedRefs) {
        new Notice(`Removed the marker of deleted footnote [^${label}].`);
      }
      for (const label of result.removedDefs) {
        new Notice(`Removed footnote [^${label}]; its last marker was deleted.`);
      }
    }
    if (path) {
      this.snapshots.set(path, snapshotFootnotes(editor.getValue().split("\n")));
    }
    return result.mapping;
  }

  private activeFilePath(): string | null {
    return this.app.workspace.getActiveViewOfType(MarkdownView)?.file?.path ?? null;
  }

  // Apply a whole-document rewrite as one minimal edit, so the cursor and
  // scroll position survive and it lands as a single undo step.
  private replaceWholeDoc(editor: Editor, next: string) {
    const cur = editor.getValue();
    if (next === cur) return;
    let p = 0;
    while (p < cur.length && p < next.length && cur[p] === next[p]) p++;
    let curEnd = cur.length;
    let nextEnd = next.length;
    while (curEnd > p && nextEnd > p && cur[curEnd - 1] === next[nextEnd - 1]) {
      curEnd--;
      nextEnd--;
    }
    editor.replaceRange(
      next.slice(p, nextEnd),
      editor.offsetToPos(p),
      editor.offsetToPos(curEnd)
    );
  }

  onunload() {
    if (this.coreInsert) {
      Object.assign(this.coreInsert.cmd, this.coreInsert.backup);
      this.coreInsert = null;
    }
  }

  // Temporary diagnostics: one line per footnote-relevant event, appended to
  // debug.log in the plugin folder. Removed once the "5 then 1" report is
  // reproduced and understood.
  async debugLog(line: string) {
    try {
      const p = `${this.app.vault.configDir}/plugins/${this.manifest.id}/debug.log`;
      const stamp = new Date().toISOString().slice(11, 23);
      await this.app.vault.adapter.append(p, `[${stamp}] ${line}\n`);
    } catch {
      // never let diagnostics break the feature
    }
  }

  // Public interop surface: other plugins (the AI co-editor, notably) can
  // normalize a whole document's footnotes — reading-order numbering and a
  // sorted definitions block — before showing or applying text of their own.
  tidyText(text: string): string {
    return tidyFootnotes(null, text).text;
  }

  async loadSettings() {
    const saved = (await this.loadData()) as Partial<FootnoteEditorSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ---- Commands -----------------------------------------------------------

  private insertFootnote(editor: Editor) {
    // Auto-numbered inserts are ONE atomic edit: the document is transformed
    // in memory — marker in place, definition added, everything renumbered in
    // reading order — and written back in a single transaction. The footnote
    // is born with its final number; no intermediate label ever appears.
    if (this.settings.autoNumber && this.settings.autoTidy) {
      const offset = editor.posToOffset(this.footnoteAnchor(editor));
      const result = insertFootnoteAt(editor.getValue(), offset);
      void this.debugLog(
        `atomic insert at offset ${offset}: label=${result.label}, mapping={${[...(result.mapping?.entries?.() ?? [])].map(([a, b]) => `${a}→${b}`).join(",")}}`
      );
      this.applyingTidy = true;
      try {
        this.replaceWholeDoc(editor, result.text);
      } finally {
        this.applyingTidy = false;
      }
      // Park the cursor right after the new marker (its label occurs first
      // at the insertion point, since numbering is positional).
      const m = new RegExp(`\\[\\^${result.label}\\](?!:)`).exec(result.text);
      if (m) editor.setCursor(editor.offsetToPos(m.index + m[0].length));
      const path = this.activeFilePath();
      if (path) this.snapshots.set(path, snapshotFootnotes(result.text.split("\n")));
      this.openEditor(editor, result.label);
      return;
    }

    const doInsert = (label: string) => {
      const lines = editor.getValue().split("\n");
      if (this.labelExists(lines, label)) {
        new Notice(`Footnote [^${label}] already exists.`);
        return;
      }

      // 1. Drop the reference where the cursor is.
      const cursor = this.footnoteAnchor(editor);
      editor.replaceRange(`[^${label}]`, cursor);

      // 2. Create an empty definition at the end of the note.
      this.appendDefinition(editor, label, "");

      // 3. Open the popup so the text is written without leaving this spot.
      this.openEditor(editor, label);
    };

    if (this.settings.autoNumber) {
      const lines = editor.getValue().split("\n");
      doInsert(nextNumericLabel(lines));
    } else {
      new LabelPromptModal(this.app, (label) => {
        const clean = label.trim();
        if (clean) doInsert(clean);
      }).open();
    }
  }

  private editFootnoteAtCursor(editor: Editor) {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);

    // The cursor is either on a `[^label]` reference or on a definition line.
    const ref = referenceAt(line, cursor.ch);
    const label = ref?.label ?? definitionLabelOnLine(line);

    if (!label) {
      new Notice("Place the cursor on a footnote marker, then try again.");
      return;
    }

    this.openEditor(editor, label);
  }

  // Where a new footnote marker should go. A cursor at the start of a line
  // usually means the click resolved past the previous line's text (common
  // just under a heading, whose tall spacing swallows nearby clicks). A
  // marker never belongs at the start of any line — footnotes attach to what
  // precedes them — so snap to the end of the nearest previous non-empty
  // line whenever the cursor sits at column 0.
  private footnoteAnchor(editor: Editor): { line: number; ch: number } {
    const cur = editor.getCursor();
    if (cur.ch !== 0 || cur.line === 0) return cur;
    let l = cur.line - 1;
    while (l >= 0 && editor.getLine(l).trim() === "") l--;
    if (l < 0) return cur;
    return { line: l, ch: editor.getLine(l).length };
  }

  // Open the edit popup for `label`, pre-filled with its current text.
  private openEditor(editor: Editor, label: string) {
    // Settle any pending debounced tidy first, so the numbering can't shift
    // underneath the open popup (the popup addresses its footnote by label).
    if (this.tidyTimer !== null) {
      window.clearTimeout(this.tidyTimer);
      this.tidyTimer = null;
      if (this.settings.autoTidy) {
        const mapping = this.tidyNow(editor, this.activeFilePath());
        label = mapping.get(label) ?? label;
      }
    }
    const lines = editor.getValue().split("\n");
    const def = findDefinition(lines, label);

    new FootnoteModal(this.app, {
      label,
      initial: def?.content ?? "",
      onSubmit: (content) => this.writeDefinition(editor, label, content),
      onDelete: () => this.deleteFootnote(editor, label),
    }).open();
  }

  // Clicking a rendered footnote marker opens the editor in place.
  private handleFootnoteClick(evt: MouseEvent) {
    if (!this.settings.clickToEdit) return;

    const target = evt.target as HTMLElement | null;
    const refEl = target?.closest(
      ".cm-footref, .footnote-ref"
    ) as HTMLElement | null;
    if (!refEl) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const editor = view.editor;

    let label: string | null = null;

    // Live Preview: map the clicked element to a source position and read the
    // exact label from the underlying text (works for named footnotes too).
    // `cm` is the underlying CodeMirror 6 EditorView; not in Obsidian's public
    // typings, so we describe just the surface we use.
    interface EditorViewLike {
      contentDOM: HTMLElement;
      posAtDOM(node: Node): number;
    }
    const cm = (editor as unknown as { cm?: EditorViewLike }).cm;
    try {
      if (cm && cm.contentDOM.contains(refEl)) {
        const pos = cm.posAtDOM(refEl);
        const p = editor.offsetToPos(pos);
        label = nearestReference(editor.getLine(p.line), p.ch)?.label ?? null;
      }
    } catch {
      // fall through to index-based resolution
    }

    // Reading view (or if the above failed): resolve by the displayed number.
    if (!label) {
      const num = parseInt((refEl.textContent || "").replace(/[^0-9]/g, ""), 10);
      if (!Number.isNaN(num)) {
        label = nthReferencedLabel(editor.getValue().split("\n"), num);
      }
    }

    if (!label) return;

    // Prevent Obsidian's default jump-to-definition / preview.
    evt.preventDefault();
    evt.stopPropagation();

    this.openEditor(editor, label);
  }

  // ---- Editor mutations ---------------------------------------------------

  private labelExists(lines: string[], label: string): boolean {
    return lines.some((l) => definitionLabelOnLine(l) === label);
  }

  // Write `content` to the definition for `label`, creating it if missing.
  // The cursor / scroll position in the body is left untouched.
  private writeDefinition(editor: Editor, label: string, content: string) {
    const lines = editor.getValue().split("\n");
    const def = findDefinition(lines, label);
    const rendered = renderDefinition(label, content);

    if (def) {
      this.replaceLines(editor, def, rendered);
    } else {
      this.appendDefinition(editor, label, content);
    }
    if (this.settings.autoTidy) this.tidyNow(editor, this.activeFilePath());
  }

  private replaceLines(
    editor: Editor,
    def: FootnoteDefinition,
    rendered: string
  ) {
    editor.replaceRange(
      rendered,
      { line: def.startLine, ch: 0 },
      { line: def.endLine, ch: editor.getLine(def.endLine).length }
    );
  }

  private appendDefinition(editor: Editor, label: string, content: string) {
    const rendered = renderDefinition(label, content);
    const lastLine = editor.lastLine();
    const lastText = editor.getLine(lastLine);
    const end = { line: lastLine, ch: lastText.length };

    // Ensure the definition lands on its own line, with a blank separator
    // from ordinary body text when needed.
    let prefix = "\n";
    if (lastText.trim() !== "" && !this.lastLineIsDefinition(editor, lastLine)) {
      prefix = "\n\n";
    }
    editor.replaceRange(prefix + rendered, end);
  }

  private lastLineIsDefinition(editor: Editor, lastLine: number): boolean {
    // True if the note already ends inside a footnotes block, so we don't
    // insert an extra blank line between stacked definitions.
    for (let i = lastLine; i >= 0; i--) {
      const t = editor.getLine(i);
      if (definitionLabelOnLine(t)) return true;
      if (t.trim() === "" || /^[ \t]+\S/.test(t)) continue;
      return false;
    }
    return false;
  }

  // Remove the definition block and every reference to `label`, in one undo.
  private deleteFootnote(editor: Editor, label: string) {
    const lines = editor.getValue().split("\n");
    const changes: { from: { line: number; ch: number }; to: { line: number; ch: number }; text: string }[] = [];

    // References on each line (delete right-to-left so columns stay valid).
    for (let i = 0; i < lines.length; i++) {
      const marker = `[^${label}]`;
      let idx = lines[i].indexOf(marker);
      const hits: number[] = [];
      while (idx !== -1) {
        // Skip the definition head (marker immediately followed by ":").
        if (lines[i][idx + marker.length] !== ":") hits.push(idx);
        idx = lines[i].indexOf(marker, idx + 1);
      }
      for (const at of hits) {
        changes.push({
          from: { line: i, ch: at },
          to: { line: i, ch: at + marker.length },
          text: "",
        });
      }
    }

    // The definition block itself, including its trailing newline.
    const def = findDefinition(lines, label);
    if (def) {
      const from =
        def.startLine > 0
          ? { line: def.startLine - 1, ch: lines[def.startLine - 1].length }
          : { line: def.startLine, ch: 0 };
      const to = { line: def.endLine, ch: lines[def.endLine].length };
      changes.push({ from, to, text: "" });
    }

    // Apply bottom-to-top so earlier positions remain valid.
    changes.sort((a, b) =>
      b.from.line - a.from.line || b.from.ch - a.from.ch
    );
    editor.transaction({ changes });
    new Notice(`Deleted footnote [^${label}].`);
    if (this.settings.autoTidy) this.tidyNow(editor, this.activeFilePath());
  }
}

// ---- Popup for editing a single footnote ---------------------------------

interface FootnoteModalOptions {
  label: string;
  initial: string;
  onSubmit: (content: string) => void;
  onDelete: () => void;
}

class FootnoteModal extends Modal {
  private opts: FootnoteModalOptions;
  private textarea!: HTMLTextAreaElement;

  constructor(app: App, opts: FootnoteModalOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Footnote [^${this.opts.label}]`);

    this.textarea = contentEl.createEl("textarea", {
      cls: "footnote-inline-editor-textarea",
    });
    this.textarea.value = this.opts.initial;
    this.textarea.placeholder = "Footnote text…";
    this.textarea.rows = 6;

    // Cmd/Ctrl+Enter saves; Esc (handled by Modal) cancels.
    this.textarea.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.submit();
      }
    });

    const buttons = contentEl.createDiv({
      cls: "footnote-inline-editor-buttons",
    });

    const save = buttons.createEl("button", { text: "Save" });
    save.addClass("mod-cta");
    save.addEventListener("click", () => this.submit());

    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());

    const del = buttons.createEl("button", { text: "Delete" });
    del.addClass("mod-warning");
    del.addEventListener("click", () => {
      this.opts.onDelete();
      this.close();
    });

    window.setTimeout(() => {
      this.textarea.focus();
      this.textarea.setSelectionRange(
        this.textarea.value.length,
        this.textarea.value.length
      );
    }, 0);
  }

  private submit() {
    this.opts.onSubmit(this.textarea.value);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---- Small prompt for a custom label -------------------------------------

class LabelPromptModal extends Modal {
  private onDone: (label: string) => void;

  constructor(app: App, onDone: (label: string) => void) {
    super(app);
    this.onDone = onDone;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("New footnote label");

    const input = contentEl.createEl("input", { type: "text" });
    input.placeholder = "e.g. note1";
    input.addClass("footnote-inline-editor-input");

    const submit = () => {
      this.onDone(input.value);
      this.close();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    });

    const buttons = contentEl.createDiv({
      cls: "footnote-inline-editor-buttons",
    });
    const ok = buttons.createEl("button", { text: "Continue" });
    ok.addClass("mod-cta");
    ok.addEventListener("click", submit);

    window.setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

// ---- Settings ------------------------------------------------------------

class FootnoteEditorSettingTab extends PluginSettingTab {
  plugin: FootnoteEditorPlugin;

  constructor(app: App, plugin: FootnoteEditorPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Auto-number footnotes")
      .setDesc(
        "Insert footnotes as [^1], [^2], … automatically. Turn off to be prompted for a custom label each time."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoNumber).onChange(async (v) => {
          this.plugin.settings.autoNumber = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Keep footnotes tidy automatically")
      .setDesc(
        "Behave like Word: deleting a definition also removes its in-text markers (and deleting the last marker removes the definition), numbered footnotes stay in reading order, and the definitions at the bottom stay sorted. Named footnotes like [^note] keep their labels."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoTidy).onChange(async (v) => {
          this.plugin.settings.autoTidy = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Click footnote number to edit")
      .setDesc(
        "Clicking a footnote marker opens the edit popup instead of previewing or jumping to the definition at the end of the note."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.clickToEdit).onChange(async (v) => {
          this.plugin.settings.clickToEdit = v;
          await this.plugin.saveSettings();
        })
      );
  }
}
