// Diff and syntax colours of the Git graph's file pane, from GitHub's "Dark High Contrast" theme
// (https://github.com/primer/github-vscode-theme, MIT, Copyright (c) 2020 Primer), with values from
// @primer/primitives 7.16.0 dist/json/colors/dark_high_contrast.json: diffBlob.*, fg.*, prettylights.syntax.*.
// Fixed on purpose: the app theme's ANSI colours are tuned for terminals, and a diff needs the same strong
// reds and greens on every theme.
export const diffPalette = {
  ground: "#0a0c10",
  text: "#f0f3f6",
  lineNumber: "#9ea7b3",
  added: { line: "#09b43a26", gutter: "#26cd4d38", word: "#09b43a66", sign: "#4ae168" },
  removed: { line: "#ff6a691a", gutter: "#ff6a6938", word: "#ff6a6966", sign: "#ff9492" },
  wordText: "#f0f3f6",
  hunk: { ground: "#409eff26", gutter: "#409eff66", text: "#91cbff" },
  syntax: { keyword: "#ff9492", string: "#addcff", number: "#91cbff", comment: "#bdc4cc", "": "#f0f3f6" },
};
