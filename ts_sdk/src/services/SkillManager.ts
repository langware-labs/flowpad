import { TypeId } from '../models/TypeId';
import { Skill, SkillListItem } from '../models/skill/Skill';
import { SkillParser } from '../models/skill/SkillParser';
import { fsManager } from './fsService';

/**
 * Default skills folder path relative to project root
 */
export const SKILLS_FOLDER_PATH = '.claude/skills';

/**
 * Subfolder within a skill folder for reference files (analysis.md, analysis.json, etc.)
 */
export const SKILL_REFERENCES_FOLDER = 'references';

/**
 * Error thrown when skill loading fails (file not found, etc.)
 */
export class SkillLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillLoadError';
  }
}

/**
 * Manager for loading and accessing Claude Code skills via FS API
 */
export class SkillManager {
  private flowTypeId: TypeId;
  private basePath: string;

  constructor(flowTypeId: TypeId, basePath: string = SKILLS_FOLDER_PATH) {
    this.flowTypeId = flowTypeId;
    this.basePath = basePath;
  }

  /**
   * List all skill folders in the skills directory
   */
  async list(): Promise<SkillListItem[]> {
    try {
      const result = await fsManager.listDirectory(this.flowTypeId, this.basePath);

      return result.items
        .filter((item) => item.is_dir)
        .map((item) => {
          // FSItem.name returns full relative path, extract just the folder name
          const folderName = item.name.split('/').pop() || item.name;
          return {
            name: folderName,
            path: `${this.basePath}/${folderName}`,
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (error) {
      // If folder doesn't exist, return empty list
      console.warn('[SkillManager] Failed to list skills:', error);
      return [];
    }
  }

  /**
   * Load a skill by name
   * @throws {SkillLoadError} When SKILL.md file is not found
   * @throws {SkillParseError} When SKILL.md has invalid format
   */
  async get(name: string): Promise<Skill> {
    const skillPath = `${this.basePath}/${name}`;
    const skillMdPath = `${skillPath}/SKILL.md`;

    let rawContent: string;
    try {
      rawContent = (await fsManager.download(this.flowTypeId, skillMdPath)) as string;
    } catch (error) {
      throw new SkillLoadError(`SKILL.md not found at: ${name}/SKILL.md`);
    }

    // If the SKILL.md is empty, populate it with the default template
    if (!rawContent.trim()) {
      rawContent = SkillParser.createTemplate(name);
      await fsManager.writeFile(this.flowTypeId, skillMdPath, rawContent);
    }

    // SkillParser.parse throws SkillParseError with detailed message
    const { metadata, content } = SkillParser.parse(rawContent);

    return {
      path: skillPath,
      folderName: name,
      metadata,
      content,
      rawContent,
    };
  }

  /**
   * Create a new skill with default template
   */
  async create(name: string): Promise<Skill> {
    const skillPath = `${this.basePath}/${name}`;
    const skillMdPath = `${skillPath}/SKILL.md`;

    // Ensure base path exists first (e.g., .claude/skills)
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
            console.warn(`[SkillManager] Could not create parent directory ${currentPath}:`, error);
          }
        }
      }
    } catch (error) {
      console.warn('[SkillManager] Failed to check/create base path:', error);
    }

    // Create the skill folder (handle 409 Conflict if folder already exists)
    try {
      await fsManager.mkdir(this.flowTypeId, skillPath);
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
      console.log(`[SkillManager] Skill folder ${name} already exists, continuing...`);
    }

    // Create SKILL.md with template
    const template = SkillParser.createTemplate(name);
    await fsManager.writeFile(this.flowTypeId, skillMdPath, template);

    // Return the created skill
    const { metadata, content } = SkillParser.parse(template);

    return {
      path: skillPath,
      folderName: name,
      metadata,
      content,
      rawContent: template,
    };
  }

  /**
   * Update an existing skill's SKILL.md content
   */
  async update(name: string, rawContent: string): Promise<Skill> {
    const skillPath = `${this.basePath}/${name}`;
    const skillMdPath = `${skillPath}/SKILL.md`;

    // Validate the content parses correctly
    const { metadata, content } = SkillParser.parse(rawContent);

    // Write the file
    await fsManager.writeFile(this.flowTypeId, skillMdPath, rawContent);

    return {
      path: skillPath,
      folderName: name,
      metadata,
      content,
      rawContent,
    };
  }

  /**
   * Delete a skill folder
   */
  async delete(name: string): Promise<void> {
    const skillPath = `${this.basePath}/${name}`;
    await fsManager.delete(this.flowTypeId, skillPath);
  }

  /**
   * Check if a skill exists
   */
  async exists(name: string): Promise<boolean> {
    const skillPath = `${this.basePath}/${name}/SKILL.md`;
    return await fsManager.exists(this.flowTypeId, skillPath);
  }

  /**
   * List contents of a skill directory
   */
  async listContents(skillName: string, relativePath: string = ''): Promise<{ files: any[]; folders: any[] }> {
    const skillPath = `${this.basePath}/${skillName}`;
    const fullPath = relativePath ? `${skillPath}/${relativePath}` : skillPath;

    try {
      const result = await fsManager.listDirectory(this.flowTypeId, fullPath);

      const files = result.items
        .filter((item) => !item.is_dir)
        .map((item) => ({
          name: item.name.split('/').pop() || item.name,
          path: item.name,
          size: item.size,
        }));

      const folders = result.items
        .filter((item) => item.is_dir)
        .map((item) => ({
          name: item.name.split('/').pop() || item.name,
          path: item.name,
        }));

      return { files, folders };
    } catch (error) {
      console.warn(`[SkillManager] Failed to list contents of ${skillName}/${relativePath}:`, error);
      return { files: [], folders: [] };
    }
  }

  /**
   * Find the next available number for file/folder naming
   */
  private findNextNumber(items: { name: string }[], prefix: string, extension: string = ''): number {
    const pattern = new RegExp(`^${prefix}(\\d+)${extension.replace('.', '\\.')}$`);
    const numbers = items
      .map((item) => {
        const match = item.name.match(pattern);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter((n) => n > 0);

    return numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  }

  /**
   * Create a new file in the skill directory with auto-numbering
   */
  async createFile(skillName: string, relativePath: string = ''): Promise<{ name: string; path: string }> {
    const { files } = await this.listContents(skillName, relativePath);
    const nextNum = this.findNextNumber(files, 'file', '.md');
    const fileName = `file${nextNum}.md`;

    const skillPath = `${this.basePath}/${skillName}`;
    const fullPath = relativePath ? `${skillPath}/${relativePath}/${fileName}` : `${skillPath}/${fileName}`;

    await fsManager.writeFile(this.flowTypeId, fullPath, '# New File\n\nAdd your content here...\n');

    return {
      name: fileName,
      path: relativePath ? `${relativePath}/${fileName}` : fileName,
    };
  }

  /**
   * Create a new folder in the skill directory with auto-numbering
   */
  async createFolder(skillName: string, relativePath: string = ''): Promise<{ name: string; path: string }> {
    const { folders } = await this.listContents(skillName, relativePath);
    const nextNum = this.findNextNumber(folders, 'folder');
    const folderName = `folder${nextNum}`;

    const skillPath = `${this.basePath}/${skillName}`;
    const fullPath = relativePath ? `${skillPath}/${relativePath}/${folderName}` : `${skillPath}/${folderName}`;

    await fsManager.mkdir(this.flowTypeId, fullPath);

    return {
      name: folderName,
      path: relativePath ? `${relativePath}/${folderName}` : folderName,
    };
  }

  /**
   * Rename a file or folder within a skill
   */
  async renameItem(skillName: string, itemPath: string, newName: string): Promise<void> {
    const skillPath = `${this.basePath}/${skillName}`;
    const fullPath = `${skillPath}/${itemPath}`;

    await fsManager.rename(this.flowTypeId, fullPath, newName);
  }

  /**
   * Delete a file or folder within a skill
   */
  async deleteItem(skillName: string, itemPath: string): Promise<void> {
    const skillPath = `${this.basePath}/${skillName}`;
    const fullPath = `${skillPath}/${itemPath}`;

    await fsManager.delete(this.flowTypeId, fullPath);
  }
}
