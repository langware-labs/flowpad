/**
 * A resolvable value that can be set by user or auto-resolved by model.
 *
 * The value property holds the user's selection (can be "auto").
 * The modelChoice property holds the model's auto-selection (null if never resolved).
 * The resolved property returns the effective value (modelChoice if present, else value).
 */
export class Resolvable<T> {
  value: T | string;
  modelChoice: T | null;
  private resolveHandler?: (resolvable: Resolvable<T>) => T;

  constructor(value: T | string, modelChoice: T | null = null, resolveHandler?: (resolvable: Resolvable<T>) => T) {
    this.value = value;
    this.modelChoice = modelChoice;
    this.resolveHandler = resolveHandler;
  }

  /**
   * Get the auto-resolved value.
   * Resolution logic:
   * 1. If value is "auto" or "Auto" (user chose AUTO mode), return modelChoice if set, else value
   * 2. If value is NOT auto (user explicitly chose something), return value (user override)
   *
   * Note: Arrays do NOT auto-merge here. The merge happens explicitly in setModelChoice()
   * based on auto_update_labels setting.
   */
  get autoResolvedValue(): T {
    // Check if value is AUTO (case-insensitive: "auto" or "Auto")
    const isAutoValue =
      typeof this.value === 'string' && (this.value.toLowerCase() === 'auto' || this.value === 'Auto');

    // Only use modelChoice when value is AUTO
    if (isAutoValue && this.modelChoice !== null) {
      return this.modelChoice;
    }

    // Otherwise return value (user override or arrays)
    return this.value as T;
  }

  /**
   * Get the resolved value.
   * If a resolveHandler was provided, use it.
   * Otherwise, return the autoResolvedValue.
   */
  get resolved(): T {
    if (this.resolveHandler) {
      return this.resolveHandler(this);
    }
    return this.autoResolvedValue;
  }

  /**
   * Set the model's choice for this resolvable.
   * Pass null to clear the model choice.
   */
  setModelChoice(choice: T | null): void {
    this.modelChoice = choice;
  }

  /**
   * Clear the model's choice.
   */
  resetModelChoice(): void {
    this.modelChoice = null;
  }

  /**
   * Create from plain object (for deserialization).
   * Note: resolveHandler cannot be serialized, so it must be provided separately if needed.
   */
  static fromJSON<T>(
    json: { value: T | string; model_choice?: T | null },
    resolveHandler?: (resolvable: Resolvable<T>) => T,
  ): Resolvable<T> {
    return new Resolvable<T>(json.value, json.model_choice ?? null, resolveHandler);
  }

  /**
   * Convert to plain object (for serialization).
   */
  toJSON(): { value: T | string; model_choice: T | null } {
    return {
      value: this.value,
      model_choice: this.modelChoice,
    };
  }
}
