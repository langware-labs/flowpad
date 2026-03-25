/**
 * CompletionOptions - Unified class for managing chat completion options
 *
 * This class manages chat completion options for a flow.
 *
 * Architecture:
 * - Setters set user values on state's Resolvable objects
 * - Provides setModelChoice() methods to set AI-detected values
 * - Emits change events for hooks to subscribe to
 */

import { EventEmitter } from 'events';
import { LabelInfo } from '../../models/LabelInfo';
import { labelsDedup } from '../../stores/ontology-store';
import { FlowMode, IChatOptions, IChatOptionsValues, IFlowState } from './flow-types';

export enum CompletionMessageType {
  TEXT = 'text',
  VOICE = 'voice',
}

/**
 * Events emitted by CompletionOptions
 */
export const CompletionOptionsEvents = {
  CHANGE: 'change',
} as const;

/**
 * Change event data
 */
export interface CompletionOptionsChangeEvent {
  field: string;
  value: any;
}

/**
 * Pure proxy to IFlowState for completion options
 * NO internal state - all state is delegated to IFlowState
 */
export class CompletionOptions extends EventEmitter {
  // Reference to state - ONLY state reference
  private _state: IFlowState;

  /**
   * Static defaults - Single source of truth for default values
   * Used when no flow exists (landing page scenario)
   */
  private static _defaults: ReturnType<typeof CompletionOptions.createDefaults> | null = null;

  private static createDefaults() {
    return {
      search: true,
      mode: { value: FlowMode.AGENT, model_choice: null },
      labels: { value: [], model_choice: null },
      autoUpdateLabels: { value: true, model_choice: null },
      userMessageType: CompletionMessageType.TEXT,
    };
  }

  static get defaults() {
    if (!this._defaults) {
      this._defaults = this.createDefaults();
    }
    return this._defaults;
  }

  /**
   * Create default values as flat IChatOptionsValues
   * Used for landing page local state initialization
   */
  static createDefaultValues(): IChatOptionsValues {
    return {
      search: true,
      mode: FlowMode.AGENT,
      labels: [],
      autoUpdateLabels: true,
    };
  }

  constructor(state: IFlowState) {
    super();
    this._state = state;
  }

  /**
   * Handle state change from Flow when chat_options is updated
   * Called by Flow when backend sends new chat_options state
   * @param chatOptions - The chat options to apply
   * @param applyValues - If true, applies full state including values (for initial load).
   *                      If false (default), only applies model_choice (for streaming updates).
   */
  setOptionsState(chatOptions: IChatOptions, applyValues: boolean = false): void {
    // For streaming updates, filter out values to preserve user's selections
    // For initial load, apply full state including values
    const optionsToApply = applyValues ? chatOptions : this.filterValues(chatOptions);

    for (const [propKey, propValue] of Object.entries(optionsToApply)) {
      // For object properties (IChatOptionType with value/model_choice), merge fully
      if (typeof propValue === 'object' && propValue !== null) {
        Object.assign(this._state.chat_options[propKey as keyof IChatOptions], propValue);
      } else {
        // For primitive properties (like search: boolean), assign directly
        (this._state.chat_options as unknown as Record<string, unknown>)[propKey] = propValue;
      }
    }
    this.resolveLabels();
    this.emitChange();
  }

  /**
   * Return a copy of chat options without any `value` keys
   */
  filterValues(chatOptions: IChatOptions): IChatOptions {
    const clone: Record<string, any> = JSON.parse(JSON.stringify(chatOptions));

    Object.keys(clone).forEach((propKey) => {
      const propValue = clone[propKey];

      if (propValue && propValue.hasOwnProperty('value')) {
        delete propValue.value;
      }
    });

    return clone as IChatOptions;
  }

  /**
   * Emit change event with entire chat_options state
   * Used by setters to notify subscribers of any change
   */
  private emitChange(): void {
    this.emit(CompletionOptionsEvents.CHANGE, {
      field: 'chat_options',
      value: this._state.chat_options,
    } as CompletionOptionsChangeEvent);
  }

  /**
   * Simple resolution: return model_choice if set, otherwise value
   */
  private resolve<T>(value: T, model_choice: T | null): T {
    if (!model_choice || typeof model_choice !== 'string') {
      return value;
    }
    if (typeof value !== 'string') {
      return value;
    }
    if (value.toLowerCase() === 'auto') {
      return model_choice;
    }
    return value;
  }

  /**
   * Resolve labels with ontology-aware merging
   * If auto_update_labels is true, merge model_choice into value with ontology deduplication
   */
  private resolveLabels(): void {
    const chatOptions = this._state.chat_options;
    if (!chatOptions?.labels || !chatOptions?.auto_update_labels) {
      return;
    }
    const autoUpdate = this.autoUpdateLabels;
    const modelChoice = chatOptions.labels.model_choice;

    if (!autoUpdate || !modelChoice) {
      return;
    }

    const currentValue = Array.isArray(chatOptions.labels.value) ? chatOptions.labels.value : [];

    // Find which ontologies are present in modelChoice using LabelInfo.parseLabel
    const modelOntologies = new Set<string>();
    for (const label of modelChoice) {
      const { ontology } = LabelInfo.parseLabel(label);
      if (ontology) {
        modelOntologies.add(ontology);
      }
    }

    // Filter currentValue to remove labels from conflicting ontologies
    const filteredValue = currentValue.filter((label: string) => {
      const { ontology } = LabelInfo.parseLabel(label);
      if (ontology) {
        return !modelOntologies.has(ontology);
      }
      return true;
    });

    // Merge: modelChoice first, then unique labels from filteredValue
    const merged = [...modelChoice];
    for (const item of filteredValue) {
      if (!merged.includes(item)) {
        merged.push(item);
      }
    }

    chatOptions.labels.value = merged;
  }

  get search(): boolean {
    return this._state.chat_options.search;
  }

  set search(value: boolean) {
    this._state.chat_options.search = value;
    this.emitChange();
  }

  get mode(): FlowMode {
    const opt = this._state.chat_options.mode;
    return this.resolve(opt.value, opt.model_choice);
  }

  set mode(value: FlowMode) {
    this._state.chat_options.mode.value = value;
    this.emitChange();
  }

  get labels(): string[] {
    const opt = this._state.chat_options.labels;
    return this.resolve(opt.value, opt.model_choice);
  }

  set labels(value: string[]) {
    this._state.chat_options.labels.value = value;
    this.emitChange();
  }

  get autoUpdateLabels(): boolean {
    const opt = this._state.chat_options.auto_update_labels;
    return this.resolve(opt.value, opt.model_choice);
  }

  set autoUpdateLabels(value: boolean) {
    this._state.chat_options.auto_update_labels.value = value;
    this.emitChange();
  }

  // ============================================================================
  // Value conversion methods for controlled components
  // ============================================================================

  /**
   * Convert current options to flat IChatOptionsValues
   * Used for controlled component value prop
   */
  toValues(): IChatOptionsValues {
    return {
      search: this.search,
      mode: this.mode,
      labels: this.labels,
      autoUpdateLabels: this.autoUpdateLabels,
    };
  }

  /**
   * Apply values from IChatOptionsValues
   * Used for controlled component onChange handler
   */
  applyValues(values: Partial<IChatOptionsValues>): void {
    if (values.search !== undefined) {
      this.search = values.search;
    }
    if (values.mode !== undefined) {
      this.mode = values.mode;
    }
    if (values.labels !== undefined) {
      this.labels = values.labels;
    }
    if (values.autoUpdateLabels !== undefined) {
      this.autoUpdateLabels = values.autoUpdateLabels;
    }
  }

  // ============================================================================
  // Convenience methods for label management
  // ============================================================================

  /**
   * Add a label
   * Automatically deduplicates and filters according to ontology rules:
   * - Removes exact duplicates
   * - Keeps only one label per ontology (replaces existing with new)
   * - Allows multiple custom/ad-hoc labels
   */
  addLabel(label: string): void {
    const currentLabels = this.labels;
    const newLabels = labelsDedup([label, ...currentLabels]);
    this._state.chat_options.labels.value = newLabels;
    this.emitChange();
  }

  /**
   * Remove a label
   */
  removeLabel(label: string): void {
    const currentLabels = Array.isArray(this.labels) ? this.labels : [];
    const newLabels = currentLabels.filter((l: string) => l !== label);
    this._state.chat_options.labels.value = newLabels;
    this.emitChange();
  }

  // ============================================================================
  // Reset to defaults
  // ============================================================================

  /**
   * Reset all options to defaults from CompletionOptions.defaults
   * Single source of truth for default values
   */
  resetToDefaults(): void {
    const defaults = CompletionOptions.defaults;
    this.mode = defaults.mode.value;
    this.search = defaults.search;
    // Note: labels and autoUpdateLabels are managed by state, intentionally not reset
  }

  // ============================================================================
  // Serialization for API calls
  // ============================================================================

  /**
   * This is used when sending completion requests to the backend
   */
  toApiRequest(
    processId: string,
    uploadedFilePaths?: string[],
    uiOnlyMessageText?: string,
    userMessageType?: CompletionMessageType,
  ): ICompletionOptions {
    return {
      processId,
      flowMode: this.mode,
      enableSearch: this.search,
      labels: this.labels,
      uploadedFilePaths,
      uiOnlyMessageText,
      userMessageType,
    };
  }
}

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * ICompletionOptions - The unified interface for API completion requests
 * This is what the backend expects and what should be used everywhere
 */
export interface ICompletionOptions {
  processId?: string;
  flowMode?: FlowMode;
  enableSearch?: boolean;
  labels?: string[];
  uploadedFilePaths?: string[];
  uiOnlyMessageText?: string;
  userMessageType?: CompletionMessageType;
  classifyOnly?: boolean;
  classifyPlannerSupported?: boolean;
  setActiveView?: boolean; // Default true - switches to Active view after sending message
}
