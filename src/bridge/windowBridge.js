// src/bridge/windowBridge.js
const { ipcMain, BrowserWindow } = require('electron');
const windowManager = require('../window/windowManager');

module.exports = {
  initialize() {
    ipcMain.handle('toggle-content-protection', () => windowManager.toggleContentProtection());
    ipcMain.handle('resize-header-window', (event, args) => windowManager.resizeHeaderWindow(args));
    ipcMain.handle('get-content-protection-status', () => windowManager.getContentProtectionStatus());
    ipcMain.handle('open-shortcut-editor', () => windowManager.openShortcutEditor());
    ipcMain.on('show-settings-window', (event, bounds) => windowManager.showSettingsWindow(bounds));
    ipcMain.on('hide-settings-window', () => windowManager.hideSettingsWindow());
    ipcMain.on('cancel-hide-settings-window', () => windowManager.cancelHideSettingsWindow());
    ipcMain.handle('open-login-page', () => windowManager.openLoginPage());
    ipcMain.handle('move-window-step', (event, direction) => windowManager.moveWindowStep(direction));
    ipcMain.on('close-shortcut-editor', () => windowManager.closeWindow('shortcut-settings'));

    // Newly moved handlers from windowManager
    ipcMain.on('header-state-changed', (event, state) => windowManager.handleHeaderStateChanged(state));
    ipcMain.on('header-animation-finished', (event, state) => windowManager.handleHeaderAnimationFinished(state));
    ipcMain.handle('get-header-position', () => windowManager.getHeaderPosition());
    ipcMain.handle('move-header', (event, newX, newY) => windowManager.moveHeader(newX, newY));
    ipcMain.handle('move-header-to', (event, newX, newY) => windowManager.moveHeaderTo(newX, newY));
    ipcMain.handle('adjust-window-height', (event, targetHeight) => windowManager.adjustWindowHeight(event.sender, targetHeight));
    ipcMain.handle('toggle-all-windows-visibility', () => windowManager.toggleAllWindowsVisibility());
    // ipcMain.on('animation-finished', (event) => windowManager.handleAnimationFinished(event.sender));
    // ipcMain.handle('ask:closeAskWindow', () => windowManager.closeAskWindow());
  },

  notifyFocusChange(win, isFocused) {
    win.webContents.send('window:focus-change', isFocused);
  }
};