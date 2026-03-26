import { EventEmitter } from 'events';
import { dataContext } from '../FlowSync/context';
import { fsManager } from './fsService';
import { TerminalType } from './shell/builtInShells';

/**
 * Workspace settings stored in workspace/.flow/settings.json
 */
export interface WorkspaceSettings {
  show_system_skills: boolean;
  default_terminal: TerminalType;
  buffer_sync_updates: boolean;
}

/**
 * Events emitted by WorkspaceSetting
 */
export enum WorkspaceSettingEvent {
  SETTINGS_CHANGED = 'settings_changed',
  SETTINGS_LOADED = 'settings_loaded',
}

const DEFAULT_SETTINGS: WorkspaceSettings = {
  show_system_skills: true,
  default_terminal: TerminalType.BUILTIN_XTERM,
  buffer_sync_updates: false,
};

const DEBOUNCE_MS = 500;

/**
 * WorkspaceSetting - Manages workspace settings with auto-save and EventEmitter pattern
 *
 * Settings are persisted to workspace/.flow/settings.json
 * Changes are debounced to avoid excessive file writes
 */
export class WorkspaceSetting extends EventEmitter {
  private _settings: WorkspaceSettings = { ...DEFAULT_SETTINGS };
  private _loaded = false;
  private _saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private _pendingSave = false;
  private _version = 0;

  /**
   * Check if settings have been loaded
   */
  get isLoaded(): boolean {
    return this._loaded;
  }

  /**
   * Version counter for React useSyncExternalStore
   * Increments on every settings change
   */
  get version(): number {
    return this._version;
  }

  /**
   * Get the show_system_skills setting
   */
  get showSystemSkills(): boolean {
    return this._settings.show_system_skills;
  }

  /**
   * Set the show_system_skills setting
   * Triggers debounced auto-save
   */
  set showSystemSkills(value: boolean) {
    if (this._settings.show_system_skills !== value) {
      this._settings.show_system_skills = value;
      this._handleUpdate();
    }
  }

  /**
   * Get the default_terminal setting
   */
  get defaultTerminal(): TerminalType {
    return this._settings.default_terminal;
  }

  /**
   * Set the default_terminal setting
   * Triggers debounced auto-save
   */
  set defaultTerminal(value: TerminalType) {
    if (this._settings.default_terminal !== value) {
      this._settings.default_terminal = value;
      this._handleUpdate();
    }
  }

  /**
   * Buffer PTY writes between DEC 2026 BSU/ESU markers to prevent
   * visible scroll jumps during Claude Code's TUI redraws.
   */
  get bufferSyncUpdates(): boolean {
    return this._settings.buffer_sync_updates;
  }

  set bufferSyncUpdates(value: boolean) {
    if (this._settings.buffer_sync_updates !== value) {
      this._settings.buffer_sync_updates = value;
      this._handleUpdate();
    }
  }

  /**
   * Get all settings as a read-only object
   */
  get settings(): Readonly<WorkspaceSettings> {
    return { ...this._settings };
  }

  /**
   * Get the settings file path from desktop_info
   */
  private get settingsPath(): string | null {
    return dataContext.bootstrapInfo?.desktop_info?.paths?.settings ?? null;
  }

  /**
   * Get the compute node TypeId for file operations
   */
  private get computeNodeTypeId() {
    return dataContext.computeNode?.typeId ?? null;
  }

  /**
   * Load settings from settings.json file
   */
  async loadJson(): Promise<void> {
    const typeId = this.computeNodeTypeId;
    const path = this.settingsPath;

    if (!typeId || !path) {
      console.warn('[WorkspaceSetting] Cannot load: no compute node or settings path');
      this._loaded = true;
      this.emit(WorkspaceSettingEvent.SETTINGS_LOADED, this._settings);
      return;
    }

    try {
      const content = await fsManager.download(typeId, path);
      if (typeof content === 'string') {
        const parsed = JSON.parse(content) as Partial<WorkspaceSettings>;
        this._settings = { ...DEFAULT_SETTINGS, ...parsed };
      }
    } catch (error) {
      console.warn('[WorkspaceSetting] Load failed, using defaults:', error);
      this._settings = { ...DEFAULT_SETTINGS };
    }

    this._loaded = true;
    this._version++;
    this.emit(WorkspaceSettingEvent.SETTINGS_LOADED, this._settings);
  }

  /**
   * Save settings to settings.json file
   */
  async saveJson(): Promise<void> {
    const typeId = this.computeNodeTypeId;
    const path = this.settingsPath;

    if (!typeId || !path) {
      console.warn('[WorkspaceSetting] Cannot save: no compute node or settings path');
      return;
    }

    try {
      const content = JSON.stringify(this._settings, null, 2);
      await fsManager.writeFile(typeId, path, content);
      this.emit(WorkspaceSettingEvent.SETTINGS_CHANGED, this._settings);
    } catch (error) {
      console.error('[WorkspaceSetting] Save failed:', error);
    }
  }

  /**
   * Internal handler for property updates - schedules debounced save
   * Only schedules if no save is already pending
   */
  private _handleUpdate(): void {
    // Increment version for React useSyncExternalStore
    this._version++;

    // Only schedule if no save is pending
    if (this._pendingSave) {
      return;
    }

    this._pendingSave = true;

    // Clear existing timeout if any
    if (this._saveTimeout) {
      clearTimeout(this._saveTimeout);
    }

    // Schedule debounced save
    this._saveTimeout = setTimeout(() => {
      this._pendingSave = false;
      this._saveTimeout = null;
      void this.saveJson();
    }, DEBOUNCE_MS);
  }

  /**
   * Update multiple settings at once
   * Triggers a single debounced save
   */
  update(updates: Partial<WorkspaceSettings>): void {
    let changed = false;

    if (updates.show_system_skills !== undefined && updates.show_system_skills !== this._settings.show_system_skills) {
      this._settings.show_system_skills = updates.show_system_skills;
      changed = true;
    }

    if (updates.default_terminal !== undefined && updates.default_terminal !== this._settings.default_terminal) {
      this._settings.default_terminal = updates.default_terminal;
      changed = true;
    }

    if (changed) {
      this._handleUpdate();
    }
  }

  /**
   * Reset settings to defaults
   */
  reset(): void {
    this._settings = { ...DEFAULT_SETTINGS };
    this._handleUpdate();
  }
}

/**
 * Singleton instance of WorkspaceSetting
 */
export const workspaceSetting = new WorkspaceSetting();
