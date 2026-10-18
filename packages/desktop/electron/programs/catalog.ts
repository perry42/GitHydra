// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * specs/external-programs.md FR-618..620: GitHydra's OWN list of editors, built from public facts (Windows Uninstall
 * DisplayName/Publisher and executable names, macOS bundle identifiers, Linux command names and flatpak ids). The reference
 * for WHICH facts to look for is the editor lists of GitHub Desktop (MIT); nothing is copied from its source, only the idea that
 * these products exist and where their vendors install them (oss-licensing-guardrails: facts, not code).
 */
export interface EditorDef {
  id: string;
  name: string;
  /** Several versions may be installed side by side (JetBrains): keep the newest two, each as its own program. */
  versioned?: boolean;
  win?: {
    /** DisplayName prefixes (case-insensitive). The LONGEST matching prefix across the catalog wins. */
    names: string[];
    /** Publisher prefixes (case-insensitive); both name and publisher must match. */
    publishers: string[];
    /** Known executable paths relative to InstallLocation, tried in order. Never DisplayIcon. */
    exes: string[];
    /** JetBrains Toolbox: `%LOCALAPPDATA%\JetBrains\Toolbox\apps\<dir>\ch-*\<build>\<exe>` */
    toolbox?: { dirs: string[]; exe: string };
  };
  mac?: { bundleIds: string[] };
  linux?: {
    commands: string[];
    /** Flatpak application ids: exported launchers live in the flatpak `exports/bin` folders. */
    flatpak?: string[];
  };
}

const JB = "JetBrains";

function jetbrains(id: string, name: string, names: string[], exe: string, toolboxDirs: string[], bundleIds: string[], commands: string[], flatpak: string[]): EditorDef {
  return {
    id,
    name,
    versioned: true,
    win: { names, publishers: [JB], exes: [`bin\\${exe}`], toolbox: { dirs: toolboxDirs, exe: `bin\\${exe}` } },
    mac: { bundleIds },
    linux: { commands, flatpak },
  };
}

export const EDITORS: readonly EditorDef[] = [
  {
    id: "vscode",
    name: "Visual Studio Code",
    win: { names: ["Microsoft Visual Studio Code"], publishers: ["Microsoft"], exes: ["Code.exe"] },
    mac: { bundleIds: ["com.microsoft.VSCode"] },
    linux: { commands: ["code"], flatpak: ["com.visualstudio.code"] },
  },
  {
    id: "vscode-insiders",
    name: "Visual Studio Code Insiders",
    win: { names: ["Microsoft Visual Studio Code Insiders"], publishers: ["Microsoft"], exes: ["Code - Insiders.exe"] },
    mac: { bundleIds: ["com.microsoft.VSCodeInsiders"] },
    linux: { commands: ["code-insiders"], flatpak: [] },
  },
  {
    id: "vscodium",
    name: "VSCodium",
    win: { names: ["VSCodium"], publishers: ["VSCodium"], exes: ["VSCodium.exe"] },
    mac: { bundleIds: ["com.vscodium"] },
    linux: { commands: ["codium", "vscodium"], flatpak: ["com.vscodium.codium"] },
  },
  {
    id: "cursor",
    name: "Cursor",
    win: { names: ["Cursor"], publishers: ["Anysphere"], exes: ["Cursor.exe"] },
    mac: { bundleIds: ["com.todesktop.230313mzl4w4u92"] },
    linux: { commands: ["cursor"] },
  },
  {
    id: "windsurf",
    name: "Windsurf",
    win: { names: ["Windsurf"], publishers: ["Codeium", "Exafunction", "Windsurf"], exes: ["Windsurf.exe"] },
    mac: { bundleIds: ["com.exafunction.windsurf"] },
    linux: { commands: ["windsurf"] },
  },
  {
    id: "zed",
    name: "Zed",
    win: { names: ["Zed"], publishers: ["Zed Industries"], exes: ["Zed.exe", "zed.exe"] },
    mac: { bundleIds: ["dev.zed.Zed", "dev.zed.Zed-Preview"] },
    linux: { commands: ["zed", "zeditor", "zed-editor"], flatpak: ["dev.zed.Zed"] },
  },
  {
    id: "sublime-text",
    name: "Sublime Text",
    win: { names: ["Sublime Text"], publishers: ["Sublime HQ"], exes: ["sublime_text.exe"] },
    mac: { bundleIds: ["com.sublimetext.4", "com.sublimetext.3"] },
    linux: { commands: ["subl", "sublime_text"], flatpak: ["com.sublimetext.three"] },
  },
  {
    id: "notepad-plus-plus",
    name: "Notepad++",
    win: { names: ["Notepad++"], publishers: ["Notepad++ Team"], exes: ["notepad++.exe"] },
  },
  jetbrains("intellij-idea", "IntelliJ IDEA", ["IntelliJ IDEA"], "idea64.exe", ["IDEA-U", "IDEA-C"], ["com.jetbrains.intellij", "com.jetbrains.intellij.ce"], ["idea", "intellij-idea-ultimate", "intellij-idea-community"], ["com.jetbrains.IntelliJ-IDEA-Community", "com.jetbrains.IntelliJ-IDEA-Ultimate"]),
  jetbrains("pycharm", "PyCharm", ["PyCharm"], "pycharm64.exe", ["PyCharm-P", "PyCharm-C"], ["com.jetbrains.pycharm", "com.jetbrains.pycharm.ce"], ["pycharm", "pycharm-community", "pycharm-professional"], ["com.jetbrains.PyCharm-Community", "com.jetbrains.PyCharm-Professional"]),
  jetbrains("webstorm", "WebStorm", ["WebStorm"], "webstorm64.exe", ["WebStorm"], ["com.jetbrains.WebStorm"], ["webstorm"], ["com.jetbrains.WebStorm"]),
  jetbrains("phpstorm", "PhpStorm", ["PhpStorm"], "phpstorm64.exe", ["PhpStorm"], ["com.jetbrains.PhpStorm"], ["phpstorm"], ["com.jetbrains.PhpStorm"]),
  jetbrains("rider", "Rider", ["JetBrains Rider", "Rider"], "rider64.exe", ["Rider"], ["com.jetbrains.rider"], ["rider"], ["com.jetbrains.Rider"]),
  jetbrains("goland", "GoLand", ["GoLand"], "goland64.exe", ["GoLand"], ["com.jetbrains.goland"], ["goland"], ["com.jetbrains.GoLand"]),
  jetbrains("clion", "CLion", ["CLion"], "clion64.exe", ["CLion"], ["com.jetbrains.CLion"], ["clion"], ["com.jetbrains.CLion"]),
  jetbrains("rubymine", "RubyMine", ["RubyMine"], "rubymine64.exe", ["RubyMine"], ["com.jetbrains.rubymine"], ["rubymine"], ["com.jetbrains.RubyMine"]),
  jetbrains("rustrover", "RustRover", ["RustRover"], "rustrover64.exe", ["RustRover"], ["com.jetbrains.rustrover"], ["rustrover"], ["com.jetbrains.RustRover"]),
  jetbrains("dataspell", "DataSpell", ["DataSpell"], "dataspell64.exe", ["DataSpell"], ["com.jetbrains.DataSpell"], ["dataspell"], ["com.jetbrains.DataSpell"]),
  {
    id: "android-studio",
    name: "Android Studio",
    versioned: true,
    win: { names: ["Android Studio"], publishers: ["Google"], exes: ["bin\\studio64.exe"] },
    mac: { bundleIds: ["com.google.android.studio"] },
    linux: { commands: ["studio", "android-studio"], flatpak: ["com.google.AndroidStudio"] },
  },
  {
    id: "pulsar",
    name: "Pulsar",
    win: { names: ["Pulsar"], publishers: ["Pulsar"], exes: ["Pulsar.exe"] },
    mac: { bundleIds: ["dev.pulsar-edit.pulsar"] },
    linux: { commands: ["pulsar"], flatpak: ["dev.pulsar_edit.Pulsar"] },
  },
  {
    id: "brackets",
    name: "Brackets",
    win: { names: ["Brackets"], publishers: ["brackets.io", "Adobe", "Brackets"], exes: ["Brackets.exe"] },
    mac: { bundleIds: ["io.brackets.appshell"] },
    linux: { commands: ["brackets"] },
  },
  {
    id: "typora",
    name: "Typora",
    win: { names: ["Typora"], publishers: ["typora.io", "Typora"], exes: ["Typora.exe"] },
    mac: { bundleIds: ["abnerworks.Typora"] },
    linux: { commands: ["typora"] },
  },
  {
    id: "gvim",
    name: "gVim",
    win: { names: ["Vim "], publishers: ["Vim", "Bram Moolenaar"], exes: ["gvim.exe"] },
    mac: { bundleIds: ["org.vim.MacVim"] },
    linux: { commands: ["gvim"] },
  },
  {
    id: "neovim-gui",
    name: "Neovim GUI",
    mac: { bundleIds: ["com.neovide.neovide", "com.qvacua.VimR"] },
    linux: { commands: ["nvim-qt", "neovide", "goneovim"], flatpak: ["com.neovide.neovide"] },
  },
  {
    id: "emacs",
    name: "Emacs",
    win: { names: ["GNU Emacs"], publishers: ["Free Software Foundation", "GNU"], exes: ["bin\\runemacs.exe"] },
    mac: { bundleIds: ["org.gnu.Emacs", "org.gnu.EmacsMac"] },
    linux: { commands: ["emacs"], flatpak: ["org.gnu.emacs"] },
  },
  {
    id: "kate",
    name: "Kate",
    win: { names: ["Kate"], publishers: ["KDE"], exes: ["bin\\kate.exe"] },
    mac: { bundleIds: ["org.kde.kate"] },
    linux: { commands: ["kate"], flatpak: ["org.kde.kate"] },
  },
  { id: "gedit", name: "gedit", linux: { commands: ["gedit"], flatpak: ["org.gnome.gedit"] } },
  { id: "gnome-text-editor", name: "GNOME Text Editor", linux: { commands: ["gnome-text-editor"], flatpak: ["org.gnome.TextEditor"] } },
  { id: "mousepad", name: "Mousepad", linux: { commands: ["mousepad"], flatpak: ["org.xfce.mousepad"] } },
  {
    id: "lite-xl",
    name: "Lite XL",
    win: { names: ["Lite XL"], publishers: ["Lite XL"], exes: ["lite-xl.exe"] },
    mac: { bundleIds: ["com.litexl.lite-xl"] },
    linux: { commands: ["lite-xl"], flatpak: ["com.litexl.lite-xl"] },
  },
];

export function editorById(id: string): EditorDef | undefined {
  return EDITORS.find((e) => e.id === id);
}
