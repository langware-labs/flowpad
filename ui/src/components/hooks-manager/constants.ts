/**
 * Constants and enums for Hooks Manager UI
 */

/**
 * Tab identifiers in the Hooks Manager
 */
export enum HooksManagerTab {
  HOOKS = 'hooks',
  TRIGGERS = 'triggers',
}

/**
 * Toast message titles
 */
export enum ToastTitle {
  FAILED_TO_LOAD_HOOKS = 'Failed to Load Hooks',
  FAILED_TO_LOAD_TRIGGERS = 'Failed to Load Triggers',
  HOOK_DELETED = 'Hook Deleted',
  FAILED_TO_DELETE_HOOK = 'Failed to Delete Hook',
  HOOK_SAVED = 'Hook Saved',
  FAILED_TO_SAVE_HOOK = 'Failed to Save Hook',
  TRIGGER_DELETED = 'Trigger Deleted',
  FAILED_TO_DELETE_TRIGGER = 'Failed to Delete Trigger',
  TRIGGER_SAVED = 'Trigger Saved',
  FAILED_TO_SAVE_TRIGGER = 'Failed to Save Trigger',
}

/**
 * Toast message descriptions
 */
export enum ToastDescription {
  HOOK_DELETED = 'CLI hook deleted successfully',
  HOOK_SAVED = 'CLI hook saved successfully',
  TRIGGER_DELETED = 'Trigger deleted successfully',
  TRIGGER_SAVED = 'Trigger saved successfully',
}

/**
 * Error messages
 */
export enum ErrorMessage {
  COULD_NOT_LOAD_HOOKS = 'Could not load CLI hooks',
  COULD_NOT_LOAD_TRIGGERS = 'Could not load triggers',
  COULD_NOT_DELETE_HOOK = 'Could not delete hook',
  COULD_NOT_SAVE_HOOK = 'Could not save hook',
  COULD_NOT_DELETE_TRIGGER = 'Could not delete trigger',
  COULD_NOT_SAVE_TRIGGER = 'Could not save trigger',
  INVALID_JSON = 'Invalid JSON',
}
