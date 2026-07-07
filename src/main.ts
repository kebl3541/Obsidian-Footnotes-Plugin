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
  definitionLabelOnLine,
  findDefinition,
  nearestReference,
  nextNumericLabel,
  nthReferencedLabel,
  referenceAt,
  renderDefinition,
} from "./footnotes";

interface FootnoteEditorSettings {
  // When true, new footnotes are numbered 1, 2, 3...; otherwise you're prompted
  // for a custom label before the note is inserted.
  autoNumber: boolean;
  // When true, clicking a footnote marker opens the edit popup instead of just
  // previewing / jumping to the definition at the end of the note.
  clickToEdit: boolean;
}

const DEFAULT_SETTINGS: FootnoteEditorSettings = {
  autoNumber: true,
  clickToEdit: true,
};

export default class FootnoteEditorPlugin extends Plugin {
  settings: FootnoteEditorSettings = DEFAULT_SETTINGS;

  async onload() {
    await this.loadSettings();

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

    this.addSettingTab(new FootnoteEditorSettingTab(this.app, this));
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
    const doInsert = (label: string) => {
      const lines = editor.getValue().split("\n");
      if (this.labelExists(lines, label)) {
        new Notice(`Footnote [^${label}] already exists.`);
        return;
      }

      // 1. Drop the reference where the cursor is.
      const cursor = editor.getCursor();
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

  // Open the edit popup for `label`, pre-filled with its current text.
  private openEditor(editor: Editor, label: string) {
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
