import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { FSEntry, fsManager, fsStore, TypeId } from '@sdk';
import { BreadcrumbChevron } from '@src/components/ui/breadcrumb';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { ScrollArea } from '@src/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@src/components/ui/context-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { useFS } from '@src/hooks/useFS';
import {
  ArrowUp,
  ClipboardPaste,
  Copy,
  Download,
  Edit2,
  ExternalLink,
  File,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  RefreshCw,
  Scissors,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ShareToConversationDialog } from '@src/components/share-to-conversation/ShareToConversationDialog';
import { writeBrowseableDrag } from '@src/components/browseable-tree/drag';
import { attachMultiDragGhost, buildRowDragItem } from './drag-payload';
import { fileShareSource } from '@src/hooks/share-sources';
import { FileItem, SimpleFileManagerProps, SortDirection, SortField } from './types';
import { formatBytes } from '@src/utils/format-bytes';

function formatDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getFileIcon(item: FileItem) {
  if (item.type === 'folder') {
    return <Folder className="h-4 w-4 text-blue-500" />;
  }
  const ext = item.name.split('.').pop()?.toLowerCase();
  if (['md', 'txt', 'json', 'yaml', 'yml'].includes(ext || '')) {
    return <FileText className="h-4 w-4 text-gray-500" />;
  }
  return <File className="h-4 w-4 text-gray-400" />;
}

// Text-friendly file extensions that can be opened in the editor
const EDITABLE_EXTENSIONS = new Set([
  // Web
  'html',
  'htm',
  'css',
  'scss',
  'sass',
  'less',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'json',
  'xml',
  'svg',
  // Native
  'c',
  'h',
  'cpp',
  'cc',
  'cxx',
  'hpp',
  'hxx',
  'rs',
  'go',
  'swift',
  'm',
  'mm',
  // JVM
  'java',
  'scala',
  'sc',
  'kt',
  'kts',
  'clj',
  'cljs',
  'cljc',
  // .NET
  'cs',
  'fs',
  'fsx',
  'fsi',
  'vb',
  // Scripting
  'py',
  'pyw',
  'pyi',
  'rb',
  'php',
  'phtml',
  'pl',
  'pm',
  'lua',
  // Functional
  'hs',
  'lhs',
  'scm',
  'ss',
  'r',
  'rdata',
  'rds',
  // Data & Config
  'sql',
  'yaml',
  'yml',
  'toml',
  'dockerfile',
  // Shell
  'sh',
  'bash',
  'zsh',
  'profile',
  'ps1',
  'psm1',
  'psd1',
  'bat',
  'cmd',
  // Text & Docs
  'md',
  'markdown',
  'mdo',
  'txt',
  'log',
  'csv',
  'tsv',
  // Config
  'ini',
  'cfg',
  'conf',
  'env',
  'gitignore',
  'editorconfig',
  // Other
  'graphql',
  'gql',
  'sparql',
  'makefile',
  'cmake',
]);

function isEditableFile(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  // Check extension
  if (EDITABLE_EXTENSIONS.has(ext)) return true;
  // Check common extensionless files
  const baseName = fileName.toLowerCase();
  if (['dockerfile', 'makefile', 'cmakelists.txt', 'gemfile', 'rakefile', 'procfile'].includes(baseName)) {
    return true;
  }
  return false;
}

function normalizeFsPath(path: string): string {
  if (!path) return '/';
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`;
  return withLeadingSlash.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const maybeStatus = (error as { response?: { status?: unknown } }).response?.status;
  return typeof maybeStatus === 'number' ? maybeStatus : null;
}

function formatFsErrorMessage(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') {
    return fallback;
  }

  const err = error as {
    message?: unknown;
    response?: {
      status?: unknown;
      data?: {
        message?: unknown;
        detail?: unknown;
      };
    };
  };

  const status = typeof err.response?.status === 'number' ? err.response.status : null;
  const apiMessage =
    typeof err.response?.data?.message === 'string'
      ? err.response.data.message
      : typeof err.response?.data?.detail === 'string'
        ? err.response.data.detail
        : null;

  if (status === 403) {
    return apiMessage || 'Not allowed: you do not have permission to access this location.';
  }

  if (apiMessage) {
    return apiMessage;
  }

  if (typeof err.message === 'string' && err.message.trim().length > 0) {
    return err.message;
  }

  return fallback;
}

function fsItemToFileItem(fsItem: FSEntry, currentPath: string): FileItem {
  const name = fsItem.relativePath?.split('/').pop() || fsItem.name || '';
  // Use relativePath for the full path, fallback to constructed path if relativePath is not available
  const itemPath = fsItem.relativePath || (currentPath === '/' ? `/${name}` : `${currentPath}/${name}`);
  return {
    id: fsItem.relativePath || name,
    name,
    type: fsItem.is_dir ? 'folder' : 'file',
    size: fsItem.size || 0,
    modifiedAt: fsItem.last_modified ? new Date(fsItem.last_modified * 1000) : new Date(),
    path: itemPath,
    fsItem,
  };
}

export function SimpleFileManager({
  typeId,
  initialPath = '/',
  onFileSelect,
  onPathChange,
  filterDefinitions,
  enabledFilters,
  compact = false,
  className = '',
  onFsMutated,
  isPathHighlighted,
}: SimpleFileManagerProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [currentPath, setCurrentPath] = useState(() => normalizeFsPath(initialPath));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [clipboard, setClipboard] = useState<{ items: FileItem[]; operation: 'copy' | 'cut' } | null>(null);
  // Absolute node path of the file being shared; non-null opens the dialog.
  const [sharePath, setSharePath] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const typeidObj = useMemo(() => new TypeId(typeId.type, typeId.id), [typeId.type, typeId.id]);
  const shareSource = useMemo(
    () => (sharePath ? fileShareSource({ computeNodeTypeId: typeidObj, absPath: sharePath }) : null),
    [sharePath, typeidObj],
  );

  // Use shared browse cache from fsStore
  const fs = useFS(typeidObj);
  const browseResult = fs?.browse(currentPath);

  // Derive files from shared cache (reactive!)
  const files = useMemo(() => {
    if (!browseResult) return [];
    let items = browseResult.items.map((fsItem) => fsItemToFileItem(fsItem, currentPath));

    // Apply filter definitions based on enabled filter names
    if (filterDefinitions && enabledFilters && enabledFilters.length > 0) {
      const activeFilterDefs = filterDefinitions.filter((f) => enabledFilters.includes(f.name));
      if (activeFilterDefs.length > 0) {
        items = items.filter((item) => activeFilterDefs.every((f) => f.filterFn(item)));
      }
    }

    return items;
  }, [browseResult, currentPath, filterDefinitions, enabledFilters]);

  // Sync currentPath with initialPath when it changes (e.g., browser back/forward navigation)
  useEffect(() => {
    setCurrentPath(normalizeFsPath(initialPath));
    setSelectedItems(new Set());
  }, [initialPath]);

  // Dialogs
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [showNewFileDialog, setShowNewFileDialog] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [renameItem, setRenameItem] = useState<FileItem | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [newFileName, setNewFileName] = useState('');
  const [newItemName, setNewItemName] = useState('');
  // Target folder for tree actions (when creating file/folder via hover action)
  const [targetFolderPath, setTargetFolderPath] = useState<string | null>(null);

  // Ensure files are loaded for the current directory (uses cache if available)
  const ensureFilesLoaded = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fetch and cache - component will re-render when browseCache updates
      // Uses fsStore directly to avoid dependency on unstable fs object
      await fsStore.getState().listDirectory(typeidObj, currentPath);
    } catch (err) {
      if (getErrorStatus(err) === 403) {
        console.warn('[SimpleFileManager] Permission denied while loading files:', err);
      } else {
        console.error('[SimpleFileManager] Failed to load files:', err);
      }
      setError(formatFsErrorMessage(err, 'Failed to load files'));
    } finally {
      setLoading(false);
    }
  }, [typeidObj, currentPath]);

  // Force refresh - invalidates cache and fetches fresh data
  const refreshFiles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Invalidate cache first, then fetch fresh data
      fsStore.getState().invalidate(typeidObj, currentPath, 'browse');
      await fsStore.getState().listDirectory(typeidObj, currentPath);
    } catch (err) {
      if (getErrorStatus(err) === 403) {
        console.warn('[SimpleFileManager] Permission denied while refreshing files:', err);
      } else {
        console.error('[SimpleFileManager] Failed to refresh files:', err);
      }
      setError(formatFsErrorMessage(err, 'Failed to refresh files'));
    } finally {
      setLoading(false);
    }
  }, [typeidObj, currentPath]);

  // Load files on mount and when path changes
  useEffect(() => {
    void ensureFilesLoaded();
  }, [ensureFilesLoaded]);

  const buildVfsPath = useCallback(
    (path: string) => {
      const normalizedPath = normalizeFsPath(path);
      if (normalizedPath === '/') {
        return `${typeidObj.toString()}/`;
      }
      return `${typeidObj.toString()}/${normalizedPath.replace(/^\/+/, '')}`;
    },
    [typeidObj],
  );

  // Navigation - only notify parent when user explicitly navigates
  const navigateToPath = useCallback(
    (path: string) => {
      const normalizedPath = normalizeFsPath(path);
      setCurrentPath(normalizedPath);
      setSelectedItems(new Set());
      // Notify parent of path change (for URL sync)
      onPathChange?.(buildVfsPath(normalizedPath));
    },
    [onPathChange, buildVfsPath],
  );

  const navigateUp = useCallback(() => {
    if (currentPath === '/') return;
    const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
    navigateToPath(parentPath);
  }, [currentPath, navigateToPath]);

  const handleItemDoubleClick = useCallback(
    (item: FileItem) => {
      if (item.type === 'folder') {
        navigateToPath(item.path);
      } else {
        onFileSelect?.(buildVfsPath(item.path));
      }
    },
    [navigateToPath, onFileSelect, buildVfsPath],
  );

  // Sorting
  const sortedFiles = useMemo(() => {
    const sorted = [...files].sort((a, b) => {
      // Folders first
      if (a.type !== b.type) {
        return a.type === 'folder' ? -1 : 1;
      }

      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'size':
          comparison = a.size - b.size;
          break;
        case 'modifiedAt':
          comparison = a.modifiedAt.getTime() - b.modifiedAt.getTime();
          break;
        case 'type':
          comparison = a.name.localeCompare(b.name);
          break;
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [files, sortField, sortDirection]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  // Selection
  const handleItemClick = useCallback(
    (item: FileItem, e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey) {
        // Toggle selection
        setSelectedItems((prev) => {
          const next = new Set(prev);
          if (next.has(item.id)) {
            next.delete(item.id);
          } else {
            next.add(item.id);
          }
          return next;
        });
      } else if (e.shiftKey && selectedItems.size > 0) {
        // Range selection
        const firstSelected = Array.from(selectedItems)[0];
        const startIdx = sortedFiles.findIndex((f) => f.id === firstSelected);
        const endIdx = sortedFiles.findIndex((f) => f.id === item.id);
        const [from, to] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
        const range = sortedFiles.slice(from, to + 1).map((f) => f.id);
        setSelectedItems(new Set(range));
      } else {
        setSelectedItems(new Set([item.id]));
      }
    },
    [selectedItems, sortedFiles],
  );

  // File operations
  const handleNewFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    try {
      // Use targetFolderPath if set (from tree action), otherwise use currentPath
      const basePath = targetFolderPath || currentPath;
      const folderPath = basePath === '/' ? `/${newFolderName}` : `${basePath}/${newFolderName}`;
      await fsManager.mkdir(typeidObj, folderPath);
      setShowNewFolderDialog(false);
      setNewFolderName('');
      setTargetFolderPath(null);
      // Invalidate browse cache for the parent folder
      fsStore.getState().invalidate(typeidObj, basePath, 'browse');
      await ensureFilesLoaded();
      onFsMutated?.(basePath);
    } catch (err) {
      console.error('[SimpleFileManager] Failed to create folder:', err);
      setError(formatFsErrorMessage(err, 'Failed to create folder'));
    }
  }, [newFolderName, currentPath, targetFolderPath, typeidObj, ensureFilesLoaded, onFsMutated]);

  const handleNewFile = useCallback(async () => {
    if (!newFileName.trim()) return;
    try {
      // Use targetFolderPath if set (from tree action), otherwise use currentPath
      const basePath = targetFolderPath || currentPath;
      const filePath = basePath === '/' ? `/${newFileName}` : `${basePath}/${newFileName}`;
      await fsManager.writeFile(typeidObj, filePath, '');
      setShowNewFileDialog(false);
      setNewFileName('');
      setTargetFolderPath(null);
      // Invalidate browse cache for the parent folder
      fsStore.getState().invalidate(typeidObj, basePath, 'browse');
      await ensureFilesLoaded();
      onFsMutated?.(basePath);
    } catch (err) {
      console.error('[SimpleFileManager] Failed to create file:', err);
      setError(formatFsErrorMessage(err, 'Failed to create file'));
    }
  }, [newFileName, currentPath, targetFolderPath, typeidObj, ensureFilesLoaded, onFsMutated]);

  const handleRename = useCallback(async () => {
    if (!renameItem || !newItemName.trim()) return;
    try {
      await fsManager.rename(typeidObj, renameItem.path, newItemName);
      setShowRenameDialog(false);
      setRenameItem(null);
      setNewItemName('');
      // Invalidate browse cache for the current folder
      fsStore.getState().invalidate(typeidObj, currentPath, 'browse');
      await ensureFilesLoaded();
      onFsMutated?.(currentPath);
    } catch (err) {
      console.error('[SimpleFileManager] Failed to rename:', err);
      setError(formatFsErrorMessage(err, 'Failed to rename'));
    }
  }, [renameItem, newItemName, typeidObj, currentPath, ensureFilesLoaded, onFsMutated]);

  const handleDelete = useCallback(async () => {
    const itemsToDelete = sortedFiles.filter((f) => selectedItems.has(f.id));
    if (itemsToDelete.length === 0) return;
    try {
      for (const item of itemsToDelete) {
        await fsManager.delete(typeidObj, item.path);
      }
      setShowDeleteDialog(false);
      setSelectedItems(new Set());
      // Invalidate browse cache for the current folder
      fsStore.getState().invalidate(typeidObj, currentPath, 'browse');
      await ensureFilesLoaded();
      onFsMutated?.(currentPath);
    } catch (err) {
      console.error('[SimpleFileManager] Failed to delete:', err);
      setError(formatFsErrorMessage(err, 'Failed to delete'));
    }
  }, [selectedItems, sortedFiles, typeidObj, currentPath, ensureFilesLoaded, onFsMutated]);

  const handleUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const fileList = e.target.files;
      if (!fileList || fileList.length === 0) return;
      try {
        const filesArray = Array.from(fileList);
        const uploads = await fsStore.getState().uploadFiles(typeidObj, currentPath, filesArray);
        // Wait for all uploads to complete
        await Promise.all(uploads.map((u) => u.waitForCompletion()));
        // Invalidate browse cache to refresh file list
        fsStore.getState().invalidate(typeidObj, currentPath, 'browse');
        await ensureFilesLoaded();
        onFsMutated?.(currentPath);
      } catch (err) {
        console.error('[SimpleFileManager] Failed to upload:', err);
        setError(formatFsErrorMessage(err, 'Failed to upload'));
      } finally {
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [typeidObj, currentPath, ensureFilesLoaded, onFsMutated],
  );

  const handleDownload = useCallback(async () => {
    const itemsToDownload = sortedFiles.filter((f) => selectedItems.has(f.id) && f.type === 'file');
    for (const item of itemsToDownload) {
      try {
        const blob = await fsManager.download(typeidObj, item.path, { asBlob: true });
        const url = URL.createObjectURL(blob as Blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = item.name;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('[SimpleFileManager] Failed to download:', err);
      }
    }
  }, [selectedItems, sortedFiles, typeidObj]);

  const handleCopy = useCallback(() => {
    const items = sortedFiles.filter((f) => selectedItems.has(f.id));
    setClipboard({ items, operation: 'copy' });
  }, [selectedItems, sortedFiles]);

  const handleCut = useCallback(() => {
    const items = sortedFiles.filter((f) => selectedItems.has(f.id));
    setClipboard({ items, operation: 'cut' });
  }, [selectedItems, sortedFiles]);

  const handlePaste = useCallback(async () => {
    if (!clipboard) return;
    try {
      // Collect source parent paths for invalidation (for cut operations)
      const sourceParentPaths = new Set<string>();
      for (const item of clipboard.items) {
        const destPath = currentPath === '/' ? `/${item.name}` : `${currentPath}/${item.name}`;
        if (clipboard.operation === 'copy') {
          await fsManager.copy(typeidObj, item.path, destPath);
        } else {
          // Track source parent path for cache invalidation
          const sourceParent = item.path.substring(0, item.path.lastIndexOf('/')) || '/';
          sourceParentPaths.add(sourceParent);
          await fsManager.move(typeidObj, item.path, destPath);
        }
      }
      if (clipboard.operation === 'cut') {
        setClipboard(null);
        // Invalidate source parent paths for cut operations
        sourceParentPaths.forEach((path) => fsStore.getState().invalidate(typeidObj, path, 'browse'));
      }
      // Invalidate destination folder
      fsStore.getState().invalidate(typeidObj, currentPath, 'browse');
      await ensureFilesLoaded();
      sourceParentPaths.forEach((path) => onFsMutated?.(path));
      onFsMutated?.(currentPath);
    } catch (err) {
      console.error('[SimpleFileManager] Failed to paste:', err);
      setError(formatFsErrorMessage(err, 'Failed to paste'));
    }
  }, [clipboard, currentPath, typeidObj, ensureFilesLoaded, onFsMutated]);

  const handleOpenInEditor = useCallback(
    (item: FileItem) => {
      // Construct full VFS path with typeId for cross-context file opening
      const vfsPath = buildVfsPath(item.path);
      navigation.openEditor(vfsPath);
    },
    [navigation, buildVfsPath],
  );

  // Breadcrumb
  const breadcrumbs = useMemo(() => {
    const parts = currentPath.split('/').filter(Boolean);
    // Always use '/' as the path for home button to navigate to VFS root
    const crumbs = [{ name: t`Home`, path: '/' }];
    let path = '';
    for (const part of parts) {
      path += `/${part}`;
      crumbs.push({ name: part, path });
    }
    return crumbs;
  }, [currentPath, t]);

  const startRename = useCallback((item: FileItem) => {
    setRenameItem(item);
    setNewItemName(item.name);
    setShowRenameDialog(true);
  }, []);

  const selectedCount = selectedItems.size;
  const hasSelection = selectedCount > 0;
  const selectedFile = selectedCount === 1 ? sortedFiles.find((f) => selectedItems.has(f.id)) : null;

  return (
    <div className={`flex h-full flex-col bg-background ${className}`}>
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b bg-muted/30 px-2 py-1">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-testid="file-manager-navigate-up-button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={navigateUp}
                disabled={currentPath === '/'}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <Trans>Go up</Trans>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-testid="file-manager-refresh-button"
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => void refreshFiles()}
                disabled={loading}
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <Trans>Refresh</Trans>
            </TooltipContent>
          </Tooltip>

          {!compact && (
            <>
              <div className="mx-1 h-4 w-px bg-border" />

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid="file-manager-new-folder-button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setShowNewFolderDialog(true)}
                  >
                    <FolderPlus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <Trans>New folder</Trans>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid="file-manager-new-file-button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setShowNewFileDialog(true)}
                  >
                    <FilePlus className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <Trans>New file</Trans>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid="file-manager-upload-button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <Trans>Upload files</Trans>
                </TooltipContent>
              </Tooltip>

              <div className="mx-1 h-4 w-px bg-border" />

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid="file-manager-copy-button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={handleCopy}
                    disabled={!hasSelection}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <Trans>Copy</Trans>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid="file-manager-cut-button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={handleCut}
                    disabled={!hasSelection}
                  >
                    <Scissors className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <Trans>Cut</Trans>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid="file-manager-paste-button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => void handlePaste()}
                    disabled={!clipboard}
                  >
                    <ClipboardPaste className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <Trans>Paste</Trans>
                </TooltipContent>
              </Tooltip>

              <div className="mx-1 h-4 w-px bg-border" />

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid="file-manager-rename-button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => selectedFile && startRename(selectedFile)}
                    disabled={selectedCount !== 1}
                  >
                    <Edit2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <Trans>Rename</Trans>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid="file-manager-download-button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => void handleDownload()}
                    disabled={!hasSelection}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <Trans>Download</Trans>
                </TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid="file-manager-delete-button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    onClick={() => setShowDeleteDialog(true)}
                    disabled={!hasSelection}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <Trans>Delete</Trans>
                </TooltipContent>
              </Tooltip>
            </>
          )}
        </TooltipProvider>

        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => void handleUpload(e)} />
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 border-b px-3 py-1.5 text-sm">
        <TooltipProvider>
          {breadcrumbs.map((crumb, idx) => (
            <span key={crumb.path} className="flex items-center gap-1">
              {/* Shares the address bar's chevron so the path trail mirrors in
                  RTL exactly as the breadcrumb above it does. */}
              {idx > 0 && <BreadcrumbChevron className="h-3 w-3 text-muted-foreground" />}
              <button
                data-testid={idx === 0 ? 'file-manager-home-button' : `file-manager-breadcrumb-${idx}`}
                onClick={() => navigateToPath(crumb.path)}
                className={`hover:text-primary ${idx === breadcrumbs.length - 1 ? 'font-medium text-foreground' : 'text-muted-foreground'}`}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </TooltipProvider>
      </div>

      {/* Error message */}
      {error && (
        <div className="border-b border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-yellow-900/50 dark:bg-yellow-950/30 dark:text-yellow-500">
          {error}
          <button onClick={() => setError(null)} className="ms-2 underline hover:no-underline">
            <Trans>Dismiss</Trans>
          </button>
        </div>
      )}

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* File list */}
        <ScrollArea className="flex-1">
          <Table>
            {!compact && (
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[45%] cursor-pointer" onClick={() => handleSort('name')}>
                    <Trans>Name</Trans> {sortField === 'name' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </TableHead>
                  <TableHead className="w-[15%] cursor-pointer" onClick={() => handleSort('size')}>
                    <Trans>Size</Trans> {sortField === 'size' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </TableHead>
                  <TableHead className="w-[25%] cursor-pointer" onClick={() => handleSort('modifiedAt')}>
                    <Trans>Modified</Trans> {sortField === 'modifiedAt' && (sortDirection === 'asc' ? '↑' : '↓')}
                  </TableHead>
                  <TableHead className="w-[15%]">
                    <Trans>Actions</Trans>
                  </TableHead>
                </TableRow>
              </TableHeader>
            )}
            <TableBody>
              {loading && files.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={compact ? 1 : 4} className="text-center text-muted-foreground">
                    <Trans>Loading...</Trans>
                  </TableCell>
                </TableRow>
              ) : sortedFiles.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={compact ? 1 : 4} className="text-center text-muted-foreground">
                    <Trans>Empty folder</Trans>
                  </TableCell>
                </TableRow>
              ) : (
                sortedFiles.map((item) => {
                  const highlighted = !!isPathHighlighted?.(item.path, item.type === 'folder');
                  return (
                    <ContextMenu key={item.id}>
                      <ContextMenuTrigger asChild>
                        <TableRow
                          className={`cursor-pointer select-none ${selectedItems.has(item.id) ? 'bg-primary/10' : ''}`}
                          onClick={(e) => handleItemClick(item, e)}
                          onDoubleClick={() => handleItemDoubleClick(item)}
                          // Rows carry the same FsDragItem payload the
                          // navigator's Files tree writes, so they can drop
                          // anywhere it can — e.g. onto a context-folder row
                          // (copy into the folder). Without `draggable` the
                          // browser falls back to text selection on drag.
                          // Dragging a row that is part of the current
                          // multi-selection drags the WHOLE selection.
                          draggable
                          onDragStart={(e) => {
                            const dragItem = buildRowDragItem(item, selectedItems, sortedFiles, typeidObj);
                            writeBrowseableDrag(e, dragItem);
                            if (dragItem.items?.length) {
                              // Multi-selection: ghost lists every dragged name.
                              attachMultiDragGhost(
                                e,
                                dragItem.items.map((en) => en.label),
                              );
                            } else {
                              // Single row: ghost is just the icon + name, not
                              // the full-width table row.
                              const ghost = e.currentTarget.querySelector('[data-drag-ghost]');
                              if (ghost instanceof HTMLElement) e.dataTransfer.setDragImage(ghost, 12, 12);
                            }
                          }}
                        >
                          <TableCell>
                            {/* w-fit + data-drag-ghost: this compact icon+name
                                block is what setDragImage shows while dragging,
                                instead of the full-width row. */}
                            <div
                              data-drag-ghost
                              className={`flex w-fit max-w-full items-center gap-2 ${highlighted ? 'text-amber-600 dark:text-amber-400' : ''}`}
                            >
                              {getFileIcon(item)}
                              <span className="truncate">{item.name}</span>
                            </div>
                          </TableCell>
                          {!compact && (
                            <>
                              <TableCell className="text-muted-foreground">
                                {item.size ? formatBytes(item.size) : '-'}
                              </TableCell>
                              <TableCell className="text-muted-foreground">{formatDate(item.modifiedAt)}</TableCell>
                              <TableCell>
                                {item.type === 'file' && isEditableFile(item.name) && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleOpenInEditor(item);
                                        }}
                                      >
                                        <ExternalLink className="h-4 w-4" />
                                      </Button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <Trans>Open in Editor</Trans>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </TableCell>
                            </>
                          )}
                        </TableRow>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        {item.type === 'folder' && (
                          <>
                            <ContextMenuItem onClick={() => handleItemDoubleClick(item)}>
                              <Trans>Open</Trans>
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                          </>
                        )}
                        <ContextMenuItem onClick={() => startRename(item)}>
                          <Trans>Rename</Trans>
                        </ContextMenuItem>
                        <ContextMenuItem onClick={handleCopy}>
                          <Trans>Copy</Trans>
                        </ContextMenuItem>
                        <ContextMenuItem onClick={handleCut}>
                          <Trans>Cut</Trans>
                        </ContextMenuItem>
                        {item.type === 'file' && (
                          <>
                            <ContextMenuItem onClick={() => void handleDownload()}>
                              <Trans>Download</Trans>
                            </ContextMenuItem>
                            <ContextMenuItem onClick={() => setSharePath(item.path)}>
                              <Trans>Share to conversation</Trans>
                            </ContextMenuItem>
                          </>
                        )}
                        <ContextMenuSeparator />
                        <ContextMenuItem className="text-destructive" onClick={() => setShowDeleteDialog(true)}>
                          <Trans>Delete</Trans>
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between border-t bg-muted/30 px-3 py-1 text-xs text-muted-foreground">
        {/* Counted with `plural`, not "N item(s)": the count and its noun have to
            agree, and a language picks the form — so the number cannot be glued
            to an English word here and still read correctly once translated. */}
        <span>
          <Plural value={sortedFiles.length} one="# item" other="# items" />
          {hasSelection && (
            <>
              {' '}
              <Trans>({selectedCount} selected)</Trans>
            </>
          )}
        </span>
        {clipboard && (
          <span className="text-primary">
            {clipboard.operation === 'copy' ? (
              <Plural value={clipboard.items.length} one="# item copied" other="# items copied" />
            ) : (
              <Plural value={clipboard.items.length} one="# item cut" other="# items cut" />
            )}
          </span>
        )}
      </div>

      {shareSource && <ShareToConversationDialog open onClose={() => setSharePath(null)} source={shareSource} />}

      {/* New Folder Dialog */}
      {showNewFolderDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-80 rounded-lg bg-background p-4 shadow-lg">
            <h3 className="mb-3 text-sm font-medium">
              <Trans>New Folder</Trans>
            </h3>
            <Input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder={t`Folder name`}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleNewFolder();
                if (e.key === 'Escape') {
                  setShowNewFolderDialog(false);
                  setTargetFolderPath(null);
                }
              }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowNewFolderDialog(false);
                  setTargetFolderPath(null);
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button size="sm" onClick={() => void handleNewFolder()} disabled={!newFolderName.trim()}>
                <Trans>Create</Trans>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* New File Dialog */}
      {showNewFileDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-80 rounded-lg bg-background p-4 shadow-lg">
            <h3 className="mb-3 text-sm font-medium">
              <Trans>New File</Trans>
            </h3>
            <Input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder={t`File name`}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleNewFile();
                if (e.key === 'Escape') {
                  setShowNewFileDialog(false);
                  setTargetFolderPath(null);
                }
              }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowNewFileDialog(false);
                  setTargetFolderPath(null);
                }}
              >
                <Trans>Cancel</Trans>
              </Button>
              <Button size="sm" onClick={() => void handleNewFile()} disabled={!newFileName.trim()}>
                <Trans>Create</Trans>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Dialog */}
      {showRenameDialog && renameItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-80 rounded-lg bg-background p-4 shadow-lg">
            <h3 className="mb-3 text-sm font-medium">
              <Trans>Rename</Trans>
            </h3>
            <Input
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              placeholder={t`New name`}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRename();
                if (e.key === 'Escape') setShowRenameDialog(false);
              }}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowRenameDialog(false)}>
                <Trans>Cancel</Trans>
              </Button>
              <Button size="sm" onClick={() => void handleRename()} disabled={!newItemName.trim()}>
                <Trans>Rename</Trans>
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Dialog - for file list selection only (the tree deletes through its own toolbar) */}
      {showDeleteDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-80 rounded-lg bg-background p-4 shadow-lg">
            <h3 className="mb-3 text-sm font-medium">
              <Trans>Delete {selectedCount} item(s)?</Trans>
            </h3>
            <p className="text-sm text-muted-foreground">
              <Trans>This action cannot be undone.</Trans>
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowDeleteDialog(false)}>
                <Trans>Cancel</Trans>
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void handleDelete()}>
                <Trans>Delete</Trans>
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
