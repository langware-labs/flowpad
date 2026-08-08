import { TypeId } from '../models/TypeId';
import { ActivationRule, ActivationListItem } from '../models/activation/Activation';
import { ActivationParser } from '../models/activation/ActivationParser';
import { fsManager } from './fsService';

/**
 * Default activation rules folder path relative to project root
 */
export const ACTIVATION_RULES_PATH = '.flow/skill_rules';

/**
 * Error thrown when activation rule loading fails (file not found, etc.)
 */
export class ActivationLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivationLoadError';
  }
}

/**
 * Manager for loading and accessing activation rules via FS API
 */
export class ActivationManager {
  private flowTypeId: TypeId;
  private basePath: string;

  constructor(flowTypeId: TypeId, basePath: string = ACTIVATION_RULES_PATH) {
    this.flowTypeId = flowTypeId;
    this.basePath = basePath;
  }

  /**
   * List all activation rule folders in the rules directory
   */
  async list(): Promise<ActivationListItem[]> {
    try {
      const result = await fsManager.listDirectory(this.flowTypeId, this.basePath);

      return result.items
        .filter((item) => item.is_dir)
        .map((item) => {
          // FSEntry.name returns full relative path, extract just the folder name
          const folderName = item.name.split('/').pop() || item.name;
          return {
            name: folderName,
            path: `${this.basePath}/${folderName}`,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      // If folder doesn't exist, return empty list
      console.warn('[ActivationManager] Failed to list activation rules:', error);
      return [];
    }
  }

  /**
   * Check if an error is a 404 Not Found error
   */
  private is404Error(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return message.includes('404') || message.includes('not found');
    }
    return false;
  }

  /**
   * Load an activation rule by name
   * If rule.md is empty or missing (404), returns a template with default content
   * @throws {ActivationLoadError} When a non-404 error occurs
   */
  async get(name: string): Promise<ActivationRule> {
    const rulePath = `${this.basePath}/${name}`;
    const ruleMdPath = `${rulePath}/rule.md`;
    const triggerPyPath = `${rulePath}/trigger.py`;

    let rawRuleContent: string;
    let isNewOrEmpty = false;

    try {
      rawRuleContent = (await fsManager.download(this.flowTypeId, ruleMdPath)) as string;
      // Handle case where download returns empty string
      if (!rawRuleContent || rawRuleContent.trim() === '') {
        isNewOrEmpty = true;
        rawRuleContent = ActivationParser.createRuleTemplate(name);
      }
    } catch (error) {
      // Only use template for 404 errors (file not found)
      // Other errors (network, permissions, etc.) should be thrown
      if (this.is404Error(error)) {
        isNewOrEmpty = true;
        rawRuleContent = ActivationParser.createRuleTemplate(name);
      } else {
        throw new ActivationLoadError(`Failed to load rule.md: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Try to load trigger.py (optional)
    let triggerContent = '';
    try {
      triggerContent = (await fsManager.download(this.flowTypeId, triggerPyPath)) as string;
      // If trigger.py is empty, use template
      if (!triggerContent || triggerContent.trim() === '') {
        triggerContent = ActivationParser.createTriggerTemplate();
      }
    } catch (error) {
      // Only use template for 404 errors (file not found)
      // Other errors should be thrown
      if (this.is404Error(error)) {
        triggerContent = ActivationParser.createTriggerTemplate();
      } else {
        throw new ActivationLoadError(`Failed to load trigger.py: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    // Parse the rule content (either loaded or template)
    let metadata;
    let ruleContent;
    try {
      const parsed = ActivationParser.parse(rawRuleContent);
      metadata = parsed.metadata;
      ruleContent = parsed.content;
    } catch (error) {
      // If parsing fails (e.g., user has invalid content), use defaults
      metadata = { name, description: '', extra: {} };
      ruleContent = rawRuleContent;
    }

    return {
      path: rulePath,
      folderName: name,
      metadata,
      ruleContent,
      rawRuleContent,
      triggerContent,
      isNewOrEmpty,
    };
  }

  /**
   * Create a new activation rule with default templates
   */
  async create(name: string): Promise<ActivationRule> {
    const rulePath = `${this.basePath}/${name}`;
    const ruleMdPath = `${rulePath}/rule.md`;
    const triggerPyPath = `${rulePath}/trigger.py`;

    // Ensure base path exists first (e.g., .flow/skill_rules)
    try {
      const baseExists = await fsManager.exists(this.flowTypeId, this.basePath);
      if (!baseExists) {
        // Create parent directories recursively
        const pathParts = this.basePath.split('/').filter((p) => p);
        let currentPath = '';
        for (const part of pathParts) {
          currentPath += `/${part}`;
          try {
            const exists = await fsManager.exists(this.flowTypeId, currentPath);
            if (!exists) {
              await fsManager.mkdir(this.flowTypeId, currentPath);
            }
          } catch (error) {
            console.warn(`[ActivationManager] Could not create parent directory ${currentPath}:`, error);
          }
        }
      }
    } catch (error) {
      console.warn('[ActivationManager] Failed to check/create base path:', error);
    }

    // Create the activation rule folder (handle 409 Conflict if folder already exists)
    try {
      await fsManager.mkdir(this.flowTypeId, rulePath);
    } catch (error: unknown) {
      // Check if it's a 409 Conflict (folder already exists) - that's OK, continue
      const is409 =
        error instanceof Error &&
        (error.message.includes('409') ||
          error.message.includes('Conflict') ||
          error.message.includes('already exists'));
      if (!is409) {
        throw error;
      }
      console.log(`[ActivationManager] Activation rule folder ${name} already exists, continuing...`);
    }

    // Create rule.md with template
    const ruleTemplate = ActivationParser.createRuleTemplate(name);
    await fsManager.writeFile(this.flowTypeId, ruleMdPath, ruleTemplate);

    // Create trigger.py with template
    const triggerTemplate = ActivationParser.createTriggerTemplate();
    await fsManager.writeFile(this.flowTypeId, triggerPyPath, triggerTemplate);

    // Return the created activation rule
    const { metadata, content: ruleContent } = ActivationParser.parse(ruleTemplate);

    return {
      path: rulePath,
      folderName: name,
      metadata,
      ruleContent,
      rawRuleContent: ruleTemplate,
      triggerContent: triggerTemplate,
    };
  }

  /**
   * Update an existing activation rule's rule.md content
   */
  async updateRule(name: string, rawContent: string): Promise<ActivationRule> {
    const rulePath = `${this.basePath}/${name}`;
    const ruleMdPath = `${rulePath}/rule.md`;

    // Validate the content parses correctly
    const { metadata, content: ruleContent } = ActivationParser.parse(rawContent);

    // Write the file
    await fsManager.writeFile(this.flowTypeId, ruleMdPath, rawContent);

    // Load trigger content
    let triggerContent = '';
    try {
      const triggerPyPath = `${rulePath}/trigger.py`;
      triggerContent = (await fsManager.download(this.flowTypeId, triggerPyPath)) as string;
    } catch (error) {
      // trigger.py is optional
    }

    return {
      path: rulePath,
      folderName: name,
      metadata,
      ruleContent,
      rawRuleContent: rawContent,
      triggerContent,
    };
  }

  /**
   * Update an existing activation rule's trigger.py content
   */
  async updateTrigger(name: string, content: string): Promise<void> {
    const rulePath = `${this.basePath}/${name}`;
    const triggerPyPath = `${rulePath}/trigger.py`;

    // Write the file
    await fsManager.writeFile(this.flowTypeId, triggerPyPath, content);
  }

  /**
   * Delete an activation rule folder
   */
  async delete(name: string): Promise<void> {
    const rulePath = `${this.basePath}/${name}`;
    await fsManager.delete(this.flowTypeId, rulePath);
  }

  /**
   * Check if an activation rule exists
   */
  async exists(name: string): Promise<boolean> {
    const rulePath = `${this.basePath}/${name}/rule.md`;
    return await fsManager.exists(this.flowTypeId, rulePath);
  }
}
