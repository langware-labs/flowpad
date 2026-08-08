import type { FSEntry } from '@sdk';
import { ExternalLink, File, FilePlus, Folder, FolderPlus, Link, Play, RefreshCw, Trash2 } from 'lucide-react';
import type { ComponentType, CSSProperties, ReactNode } from 'react';

/**
 * Action configuration for hover actions
 */
export interface ItemAction {
  /** Unique action identifier */
  name: string;
  /** Icon component to display */
  icon: ComponentType<{ className?: string }>;
  /** Tooltip text */
  tooltip: string;
  /** Handler called when action is clicked */
  onClick: (item: FSEntry, event: React.MouseEvent) => void | Promise<void>;
}

/**
 * Internal action config with visibility predicate
 */
type ActionConfig = ItemAction & {
  /** Determines if action should be visible for given item */
  isVisible?: (item: FSEntry) => boolean;
};

/**
 * Selection style configuration
 */
export interface SelectionStyle {
  /** CSS class to apply to selected items */
  className?: string;
  /** Inline styles to apply to selected items */
  style?: CSSProperties;
}

/**
 * Options for constructing an ItemHandler
 */
export interface ItemHandlerOptions {
  /**
   * Custom icon renderer for items.
   * If not provided, uses default folder/file icons with symlink indicator.
   */
  renderIcon?: (item: FSEntry) => ReactNode;

  /**
   * Custom item content renderer.
   * If not provided, renders item.name as text.
   * @param item - The FSEntry to render
   * @param level - Nesting level (0 = root)
   */
  renderItem?: (item: FSEntry, level: number) => ReactNode;

  /**
   * Array of action definitions that can appear on hover.
   * Use static factory methods like ItemHandler.createFileAction() to create these.
   */
  actions?: ActionConfig[];

  /**
   * Determines if an item can be selected.
   * Default: all items are selectable.
   */
  isSelectable?: (item: FSEntry) => boolean;

  /**
   * Returns custom selection styling for an item.
   * Default: uses 'bg-accent' class.
   */
  getSelectionStyle?: (item: FSEntry) => SelectionStyle;
}

/**
 * ItemHandler - Manages item rendering, actions, and selection behavior
 * for the DirectoryTree component.
 *
 * @example Basic usage with defaults
 * ```tsx
 * const handler = new ItemHandler({});
 * <DirectoryTree itemHandler={handler} />
 * ```
 *
 * @example With custom actions
 * ```tsx
 * const handler = new ItemHandler({
 *   actions: [
 *     ItemHandler.createFileAction(handleCreateFile),
 *     ItemHandler.deleteAction(handleDelete),
 *   ],
 * });
 * ```
 *
 * @example With custom rendering
 * ```tsx
 * const handler = new ItemHandler({
 *   renderIcon: (item) => <CustomIcon type={item.is_dir ? 'folder' : 'file'} />,
 *   renderItem: (item, level) => (
 *     <span className={level === 0 ? 'font-bold' : ''}>
 *       {item.name}
 *     </span>
 *   ),
 * });
 * ```
 */
export class ItemHandler {
  private readonly options: ItemHandlerOptions;

  constructor(options: ItemHandlerOptions = {}) {
    this.options = options;
  }

  // ─────────────────────────────────────────────────────────────────
  // RENDERING METHODS
  // ─────────────────────────────────────────────────────────────────

  /**
   * Renders the icon for an item.
   * Uses custom renderer if provided, otherwise defaults to folder/file icons.
   *
   * @param item - The FSEntry to render icon for
   * @returns React node representing the icon
   */
  renderIcon(item: FSEntry): ReactNode {
    if (this.options.renderIcon) {
      return this.options.renderIcon(item);
    }
    return this.defaultRenderIcon(item);
  }

  /**
   * Renders the content/label for an item.
   * Uses custom renderer if provided, otherwise returns item.name.
   *
   * @param item - The FSEntry to render
   * @param level - Nesting level (0 = root)
   * @returns React node representing the item content
   */
  renderItem(item: FSEntry, level: number): ReactNode {
    if (this.options.renderItem) {
      return this.options.renderItem(item, level);
    }
    // Use display_name if it's a short label (doesn't contain path separators)
    // This handles special labels like "Computer", "Workspace", etc.
    // Otherwise use item.name which extracts just the filename from the path
    if (item.display_name && !item.display_name.includes('/')) {
      return item.display_name;
    }
    return item.name;
  }

  // ─────────────────────────────────────────────────────────────────
  // COMPUTED METHODS
  // ─────────────────────────────────────────────────────────────────

  /**
   * Returns actions visible for a given item based on visibility predicates.
   * Filters the configured actions to only those applicable to this item.
   *
   * @param item - The FSEntry to get actions for
   * @returns Array of ItemAction objects visible for this item
   */
  getHoverActions(item: FSEntry): ItemAction[] {
    if (!this.options.actions) {
      return [];
    }

    return this.options.actions
      .filter((action) => {
        // If no visibility predicate, default to visible
        if (!action.isVisible) {
          return true;
        }
        return action.isVisible(item);
      })
      .map(({ name, icon, tooltip, onClick }) => ({
        name,
        icon,
        tooltip,
        onClick,
      }));
  }

  /**
   * Determines if an item can be selected.
   *
   * @param item - The FSEntry to check
   * @returns true if the item can be selected
   */
  isSelectable(item: FSEntry): boolean {
    if (this.options.isSelectable) {
      return this.options.isSelectable(item);
    }
    // Default: all items are selectable
    return true;
  }

  /**
   * Returns the selection style configuration for an item.
   * Allows different items to have different selection appearances.
   *
   * @param item - The FSEntry to get selection style for
   * @returns SelectionStyle object with className and/or style
   */
  getSelectionStyle(item: FSEntry): SelectionStyle {
    if (this.options.getSelectionStyle) {
      return this.options.getSelectionStyle(item);
    }
    // Default selection style
    return { className: 'bg-accent' };
  }

  // ─────────────────────────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────────────────────────

  /**
   * Default icon renderer - folder/file with symlink indicator
   */
  private defaultRenderIcon(item: FSEntry): ReactNode {
    return (
      <div className="relative flex items-center">
        {item.is_dir ? (
          <Folder className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        ) : (
          <File className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        )}
        {item.isSymlink && <Link className="absolute -right-1 -top-1 h-2 w-2 text-blue-500" />}
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // STATIC FACTORY METHODS
  // ─────────────────────────────────────────────────────────────────

  /**
   * Creates an action configuration for creating new files.
   * Visible on folders only.
   *
   * @param onClick - Handler called when action is clicked
   */
  static createFileAction(onClick: (item: FSEntry, e: React.MouseEvent) => void | Promise<void>): ActionConfig {
    return {
      name: 'create-file',
      icon: FilePlus,
      tooltip: 'New file',
      isVisible: (item) => item.is_dir ?? false,
      onClick,
    };
  }

  /**
   * Creates an action configuration for creating new folders.
   * Visible on folders only.
   *
   * @param onClick - Handler called when action is clicked
   */
  static createFolderAction(onClick: (item: FSEntry, e: React.MouseEvent) => void | Promise<void>): ActionConfig {
    return {
      name: 'create-folder',
      icon: FolderPlus,
      tooltip: 'New folder',
      isVisible: (item) => item.is_dir ?? false,
      onClick,
    };
  }

  /**
   * Creates an action configuration for deleting items.
   * Visible on all items.
   *
   * @param onClick - Handler called when action is clicked
   */
  static deleteAction(onClick: (item: FSEntry, e: React.MouseEvent) => void | Promise<void>): ActionConfig {
    return {
      name: 'delete',
      icon: Trash2,
      tooltip: 'Delete',
      isVisible: () => true,
      onClick,
    };
  }

  /**
   * Creates an action configuration for refreshing folders.
   * Visible on folders only.
   *
   * @param onClick - Handler called when action is clicked
   */
  static refreshAction(onClick: (item: FSEntry, e: React.MouseEvent) => void | Promise<void>): ActionConfig {
    return {
      name: 'refresh',
      icon: RefreshCw,
      tooltip: 'Refresh',
      isVisible: (item) => item.is_dir ?? false,
      onClick,
    };
  }

  /**
   * Creates an action configuration for opening items externally.
   * Visible on folders only.
   *
   * @param onClick - Handler called when action is clicked
   */
  static openAction(onClick: (item: FSEntry, e: React.MouseEvent) => void | Promise<void>): ActionConfig {
    return {
      name: 'open',
      icon: ExternalLink,
      tooltip: 'Open folder',
      isVisible: (item) => item.is_dir ?? false,
      onClick,
    };
  }

  /**
   * Creates an action configuration for running markdown files.
   * Visible on .md files.
   *
   * @param onClick - Handler called when action is clicked
   */
  static runSkillAction(onClick: (item: FSEntry, e: React.MouseEvent) => void | Promise<void>): ActionConfig {
    return {
      name: 'run-skill',
      icon: Play,
      tooltip: 'Run',
      isVisible: (item) => {
        if (item.is_dir || !item.name) return false;
        const fileName = item.name.toLowerCase();
        return fileName.endsWith('.md');
      },
      onClick,
    };
  }
}
