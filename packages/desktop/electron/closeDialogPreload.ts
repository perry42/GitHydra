// SPDX-License-Identifier: GPL-3.0-or-later
import { contextBridge, ipcRenderer } from "electron";
import { CLOSE_DIALOG_CHANNELS, type CloseDialogChoice } from "./closeDialogChannels";

// specs/edit-in-diff.md FR-535: the entire surface of the close prompt (reason, ready, respond); main validates the sender and the enum again.
contextBridge.exposeInMainWorld("closeDialog", {
  getReason: (): Promise<string> => ipcRenderer.invoke(CLOSE_DIALOG_CHANNELS.getReason),
  ready: (): Promise<void> => ipcRenderer.invoke(CLOSE_DIALOG_CHANNELS.ready),
  respond: (choice: CloseDialogChoice): Promise<void> => ipcRenderer.invoke(CLOSE_DIALOG_CHANNELS.respond, choice),
});
