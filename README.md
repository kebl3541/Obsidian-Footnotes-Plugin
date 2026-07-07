# Footnote Inline Editor

[![Downloads](https://img.shields.io/github/downloads/kebl3541/Obsidian-Footnotes-Plugin/total?style=flat&logo=github&label=Downloads&color=success)](https://github.com/kebl3541/Obsidian-Footnotes-Plugin/releases)
[![GitHub stars](https://img.shields.io/github/stars/kebl3541/Obsidian-Footnotes-Plugin?style=flat&logo=github&label=Stars)](https://github.com/kebl3541/Obsidian-Footnotes-Plugin/stargazers)
[![Latest release](https://img.shields.io/github/v/release/kebl3541/Obsidian-Footnotes-Plugin?style=flat&label=Release)](https://github.com/kebl3541/Obsidian-Footnotes-Plugin/releases/latest)

<p align="center">If this plugin adds value for you and you would like to help support
continued development, please use the buttons below:</p>

<p align="center">
<a href="https://www.paypal.com/donate/?business=berlin.philosophy%40gmail.com&no_recurring=0&currency_code=EUR"><img src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-200px.png" alt="PayPal" height="42"></a>
&nbsp;&nbsp;
<a href="https://buymeacoffee.com/philosophizer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" height="52"></a>
</p>

<p align="center">…and if this plugin makes your day a little easier, please give it a ⭐ on <a href="https://github.com/kebl3541/Obsidian-Footnotes-Plugin">GitHub</a> — it helps others find it!</p>



An Obsidian plugin to **add footnotes and edit their text in a popup** — without
scrolling to the bottom of your note to find the definition.

## What it does

- **Click to edit** — click any footnote number in your text (Live Preview or
  Reading view) and the edit popup opens pre-filled with the note's text. Save
  and it's written back in place; you never leave the spot you were reading.
- **Insert footnote at cursor** — drops an auto-numbered `[^1]` where you're
  typing, creates the matching `[^1]: …` definition at the end of the note, and
  immediately opens a small popup so you can write the note text. Your cursor
  never leaves the spot you were writing.
- **Edit footnote at cursor** — keyboard alternative to clicking: put your
  cursor on any footnote marker (either the `[^1]` in the body *or* its
  definition at the bottom) and run the command.
- **Delete** — the popup's Delete button removes the definition and every
  reference to that footnote in one undoable step.

Multi-line footnotes are supported (they're stored with the 4-space indentation
Obsidian expects for continuation lines).

## Usage

Both actions are Obsidian commands — run them from the Command Palette
(`Cmd/Ctrl+P`) or bind a hotkey under **Settings → Hotkeys**:

- `Footnote Inline Editor: Insert footnote at cursor`
- `Footnote Inline Editor: Edit footnote at cursor`

There's also a ribbon button (pencil icon) for inserting a footnote.

In the popup, **Cmd/Ctrl+Enter** saves and **Esc** cancels.

### Settings

- **Auto-number footnotes** (on by default) — new footnotes are numbered
  `1, 2, 3, …`. Turn it off to be prompted for a custom label each time.
- **Click footnote number to edit** (on by default) — clicking a marker opens
  the edit popup instead of previewing or jumping to the definition.

## Install into your vault (manual)

This plugin isn't in the community store, so install it manually:

1. Build it (already done if `main.js` is present):
   ```bash
   npm install
   npm run build
   ```
2. Create a folder in your vault:
   `<YourVault>/.obsidian/plugins/footnote-inline-editor/`
3. Copy **`main.js`**, **`manifest.json`**, and **`styles.css`** into it.
4. In Obsidian: **Settings → Community plugins**, make sure Restricted Mode is
   off, then enable **Footnote Inline Editor**.

To develop with live rebuilds, run `npm run dev` and symlink or copy the folder
into your vault's plugins directory.

## Layout

- `src/footnotes.ts` — pure functions that locate and rewrite footnote
  references and definitions.
- `src/main.ts` — the plugin, the edit popup, click handling, and the settings
  tab.

## Publishing to the community plugin store

1. Push this repo to GitHub (public).
2. Create a GitHub release whose tag is exactly the version in `manifest.json`
   (e.g. `1.1.0`), and attach `main.js`, `manifest.json`, and `styles.css` as
   release assets.
3. Fork [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases),
   add an entry to `community-plugins.json`, and open a pull request.
4. Full checklist: [Obsidian docs — Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin).

## Support

If this plugin adds value for you and you would like to help support continued
development, please use the buttons below:

<a href="https://www.paypal.com/donate/?business=berlin.philosophy%40gmail.com&no_recurring=0&currency_code=EUR"><img src="https://www.paypalobjects.com/webstatic/mktg/Logo/pp-logo-200px.png" alt="PayPal" height="42"></a>
&nbsp;&nbsp;
<a href="https://buymeacoffee.com/philosophizer"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy me a coffee" height="52"></a>


## License

MIT
