import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { FileUploadIndicator, FileUploadItem } from '@src/components/file-upload-indicator';
import { annotateImageFiles } from '@src/components/image-annotator/annotate-files';

import { useInputHistory } from '@src/hooks/use-input-history';
import { useLoginRequired, useResumeAfterLogin } from '@src/hooks/use-login-required';
import { useChatOptions } from '@src/hooks/useChatOptions';
import { useEditorStore } from '@src/store/use-editor-store';
import { useSendMessageStore } from '@src/store/use-send-message-store';
import { useVisitorMessageStore } from '@src/store/use-visitor-message-store';
import { trackEvent } from '@src/utils/analytics';
import {
  ActionInfo,
  config,
  dataContext,
  dataManager,
  AgenticProcess,
  FlowMode,
  ICompletionOptions,
  ISiteConfig,
  navigator,
  Project,
  TypeId,
  gitOriginFromUrl,
} from '@sdk';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@src/components/ui/dropdown-menu';
import { Input } from '@src/components/ui/input';
import { Textarea } from '@src/components/ui/textarea';
import { notify } from '@src/notifications';
import { useAuth, useProject } from '@sdk/react/hooks';
import { FileArchive, GitBranch, Loader2, Paperclip, Send, Settings2, Square } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useColorPalette } from '@src/hooks/useColorPalette';
import { hasGitHubRepoAccess } from '../utils/gitUtils';
import { DragDropOverlay } from './drag-drop-overlay';
import { GitHubConnectionDialog } from './GitHubConnectionDialog';
import LoginDialog, { ActionType } from './login-required-dialog';
import { ToolsPanel } from './tools';
import { useLingui } from '@lingui/react/macro';

// Constants for connection types
const CONNECTION_TYPES = {
  GIT: 'git',
  ZIP: 'zip',
} as const;

interface ChatInputProps {
  onSendMessage?: (message: string, options: ICompletionOptions) => void;
  onCancel?: () => void;
  disabled?: boolean;
  siteConfig?: ISiteConfig | null;
  detectedMode?: FlowMode | null;
  isFollowup?: boolean;
  codebaseConnectionEnabled?: boolean;
}

interface CodebaseConnection {
  name: string;
  type: 'zip' | 'git';
  isConnecting?: boolean;
  error?: string;
}

const ChatInput: React.FC<ChatInputProps> = ({
  onSendMessage,
  onCancel,
  disabled = false,
  siteConfig,
  isFollowup,
  codebaseConnectionEnabled = false,
}) => {
  const { agent } = useAgentContext();
  const { t } = useLingui();
  const isExecutionFlowEnabled = agent?.agent_config?.execution_enabled ?? true;
  // Use context as single source of truth for IDs
  const agentId = dataContext.agentTypeId?.id;
  const processId = dataContext.flowTypeId?.id;
  const [searchParams] = useSearchParams();
  const { someone, visitor } = useAuth();
  const navigate = useNavigate();
  const { project } = useProject();

  const [uploadingToFlowId, setUploadingToFlowId] = useState<string | undefined>(processId);
  const [uploadingToProjectId, setUploadingToProjectId] = useState<string | undefined>();
  const [message, setMessage] = useState('');
  const [rows, setRows] = useState(1);
  const [animateSubmit, setAnimateSubmit] = useState(false);
  const [uploadingFiles, setUploadingFiles] = useState<FileUploadItem[]>([]);
  const [codebaseConnection, setCodebaseConnection] = useState<CodebaseConnection | null>(null);
  const [gitUrl, setGitUrl] = useState('');
  const [isWaitingForOperations, setIsWaitingForOperations] = useState(false);
  const [pendingSubmission, setPendingSubmission] = useState<{
    message: string;
    options: ICompletionOptions;
    notifyId: string;
  } | null>(null);
  const [showGitHubDialog, setShowGitHubDialog] = useState(false);
  const [pendingGitUrl, setPendingGitUrl] = useState<string>('');
  const [pendingDefaultBranch, setPendingDefaultBranch] = useState<string | null>(null);
  const [isCheckingRepo, setIsCheckingRepo] = useState(false);
  const [isToolsPanelOpen, setIsToolsPanelOpen] = useState(false);
  const [isCodebaseDropdownOpen, setIsCodebaseDropdownOpen] = useState(false);
  const hasProcessedPrefillRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const zipFileInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const flowTypeId = useMemo(() => (processId ? new TypeId(AgenticProcess.type, processId) : null), [processId]);

  // Chat options - syncs with flow when available
  const { values: chatOptions, onChange: handleChatOptionsChange } = useChatOptions(flowTypeId);

  const { clearEditorContent } = useEditorStore();
  const { messageCount, messageCountVisitorId, incrementMessageCount } = useVisitorMessageStore();
  const { setPendingMessage } = useSendMessageStore();
  const inputHistory = useInputHistory();
  const {
    showLoginDialog,
    closeLoginDialog,
    requiresLogin,
    checkLoginAndProceed,
  } = useLoginRequired();
  useColorPalette(siteConfig);

  const currentFlowId = useMemo(() => {
    return processId || uploadingToFlowId;
  }, [processId, uploadingToFlowId]);

  const currentProjectId = useMemo(() => {
    return uploadingToProjectId || project?.typeId.id;
  }, [uploadingToProjectId, project?.typeId.id]);

  // Handle pending submission when operations complete
  useEffect(() => {
    if (!isWaitingForOperations || !pendingSubmission) {
      return;
    }

    const hasOngoingUploads = uploadingFiles.some((file) => file.isUploading);
    const hasOngoingCodebaseConnection = codebaseConnection?.isConnecting;
    if (hasOngoingUploads || hasOngoingCodebaseConnection) {
      return;
    }

    // All operations completed, proceed with submission
    if (!processId) {
      void navigate(`/agent/${agentId}/flow/${pendingSubmission.options.processId}`);
      clearEditorContent();
    }
    notify.dismiss(pendingSubmission.notifyId);
    setIsWaitingForOperations(false);
    onSendMessage?.(pendingSubmission.message, pendingSubmission.options);
    setMessage('');
    setUploadingFiles([]);
    setPendingSubmission(null);
  }, [
    isWaitingForOperations,
    pendingSubmission,
    uploadingFiles,
    codebaseConnection,
    onSendMessage,
    processId,
    navigate,
    agentId,
    clearEditorContent,
  ]);

  const createFlow = useCallback(async () => {
    if (!someone) {
      throw new Error('No one is logged in');
    }
    const { processId, projectId } = await dataContext.createProjectAndFlow({
      setContext: true,
      chatOptions: chatOptions,
    });
    setUploadingToFlowId(processId);
    setUploadingToProjectId(projectId);

    return { processId, projectId };
  }, [someone, chatOptions]);

  const addUploadingFiles = useCallback(
    async (incoming: File[]) => {
      // Let the user mark up captured images before they're attached.
      const files = await annotateImageFiles(incoming);
      // Cancelling the markup aborts the capture — nothing to upload.
      if (files.length === 0) return;
      const fileItems = files.map((file) => ({
        id: `${file.name}-${Date.now()}-${Math.random()}`,
        file,
        isUploading: true,
        uploadProgress: 0,
      }));

      setUploadingFiles((prev) => [...prev, ...fileItems]);

      let uploadingFlowId: string;
      let uploadingProjectId: string;
      if (currentFlowId && currentProjectId) {
        uploadingFlowId = currentFlowId;
        uploadingProjectId = currentProjectId;
      } else {
        const result = await createFlow();
        uploadingFlowId = result.processId;
        uploadingProjectId = result.projectId;
      }

      if (!currentProjectId) {
        const projectEntity = Project.getByIdFromCache(uploadingProjectId);
        if (projectEntity) {
          await projectEntity.setupComputeNode();
        } else {
          throw new Error('Project not found');
        }
      }

      async function uploadFile(fileUploadItem: FileUploadItem) {
        const actionInfo = new ActionInfo('fs', AgenticProcess.type, uploadingFlowId, 'POST');
        actionInfo.subpath = ['upload'];
        const formData = new FormData();
        formData.append('file', fileUploadItem.file);
        actionInfo.bodyParameters = formData;
        await dataManager.callAction(actionInfo);
        setUploadingFiles((prev) =>
          prev.map((item) => (item.id === fileUploadItem.id ? { ...item, isUploading: false } : item)),
        );
      }

      await Promise.all(fileItems.map(uploadFile));

      notify.success({
        title: t`Uploaded files`,
        message: files.map((file) => file.name).join(', '),
      });
    },
    [currentFlowId, currentProjectId, createFlow],
  );

  const removeUploadingFile = useCallback(
    async (fileId: string) => {
      // Mark the file as uploading again
      setUploadingFiles((prev) => prev.map((item) => (item.id === fileId ? { ...item, isUploading: true } : item)));

      const uploadFileItem = uploadingFiles.find((item) => item.id === fileId);
      if (!uploadFileItem) {
        return;
      }

      // Delete the file from the flow
      const actionInfo = new ActionInfo('fs', AgenticProcess.type, currentFlowId, 'DELETE');
      actionInfo.subpath = ['delete', uploadFileItem.file.name];
      await dataManager.callAction(actionInfo);

      // Remove the file from the list
      setUploadingFiles((prev) => prev.filter((item) => item.id !== fileId));
    },
    [uploadingFiles, currentFlowId],
  );

  // Extract repository name from Git URL or zip file name
  const getRepoNameFromUrl = useCallback((url: string): string => {
    try {
      // Handle zip files - remove .zip extension
      if (url.toLowerCase().endsWith('.zip')) {
        return url.replace(/\.zip$/i, '');
      }

      // Remove .git suffix if present
      const cleanUrl = url.replace(/\.git$/, '');
      const urlObj = new URL(cleanUrl);

      // Extract the last part of the path (repository name)
      const pathParts = urlObj.pathname.split('/').filter((part) => part.length > 0);
      if (pathParts.length >= 2) {
        return pathParts[pathParts.length - 1]; // Return the last part (repo name)
      }

      return url; // Fallback to full URL if parsing fails
    } catch {
      return url; // Fallback to full URL if parsing fails
    }
  }, []);

  const addZipUpload = useCallback(
    async (zipFile: File) => {
      try {
        const connection: CodebaseConnection = {
          name: zipFile.name,
          type: CONNECTION_TYPES.ZIP,
          isConnecting: true,
        };
        // Mark the connection as connecting
        setCodebaseConnection(connection);

        const { projectId: uploadingProjectId } =
          currentProjectId && currentFlowId
            ? { processId: currentFlowId, projectId: currentProjectId }
            : await createFlow();

        // Initialize flow with zip file in body parameters
        const actionInfo = new ActionInfo('initialize', Project.type, uploadingProjectId, 'POST');
        const formData = new FormData();
        formData.append('zipFile', zipFile);
        actionInfo.bodyParameters = formData;
        await dataManager.callAction(actionInfo);

        // Mark the connection as connected
        setCodebaseConnection((prev) => (prev ? { ...prev, isConnecting: false } : null));
      } catch (error) {
        console.error('Error uploading zip file:', error);
        setCodebaseConnection(null);
        notify.error({
          title: t`Zip Upload Failed`,
          message: t`Failed to upload the zip file. Please try again.`,
        });
      }
    },
    [createFlow, currentProjectId, currentFlowId],
  );

  const handleFilesDrop = useCallback(
    async (files: FileList) => {
      const isZipFile = (file: File) => {
        return (
          file.type === 'application/zip' ||
          file.type === 'application/x-zip-compressed' ||
          file.name.toLowerCase().endsWith('.zip')
        );
      };

      const zipFiles = Array.from(files).filter(isZipFile);
      const nonZipFiles = Array.from(files).filter((file) => !isZipFile(file));

      if (zipFiles.length > 0) {
        if (!codebaseConnectionEnabled) {
          notify.error({
            title: t`ZIP File Upload Not Allowed`,
            message: t`ZIP file upload is only available as a codebase connection`,
          });
          return;
        }
        if (zipFiles.length > 1) {
          notify.error({
            title: t`Multiple ZIP Files Not Allowed`,
            message: t`Only one ZIP file can be uploaded at a time`,
          });
          return;
        }
        await addZipUpload(zipFiles[0]);
      }
      if (nonZipFiles.length > 0) {
        await addUploadingFiles(nonZipFiles);
      }
    },
    [addUploadingFiles, addZipUpload, codebaseConnectionEnabled],
  );

  const isVisitorWithLimitReached = useMemo(
    () => visitor?.id === messageCountVisitorId && messageCount >= 3,
    [visitor?.id, messageCountVisitorId, messageCount],
  );

  const isDisabled = useMemo(() => disabled || isVisitorWithLimitReached, [disabled, isVisitorWithLimitReached]);

  useEffect(() => {
    if (isVisitorWithLimitReached) {
      trackEvent({ event: 'visitor_require_login_to_proceed' });
    }
  }, [isVisitorWithLimitReached]);

  const handleLoginClick = useCallback(() => {
    trackEvent({ event: 'login_clicked', event_source: 'login_to_proceed' });
    navigator.navigateToLogin();
  }, []);

  // After login, restore the message the user had typed for any gated action
  // (SEND / TOOLS / CODEBASE / FILES). We only restore — never auto-submit — so
  // the user can review and send themselves.
  useResumeAfterLogin(
    [ActionType.SEND, ActionType.TOOLS, ActionType.CODEBASE, ActionType.FILES],
    (pending) => {
      if (pending.message) setMessage(pending.message);
    },
  );

  const handleCodebaseButtonClick = useCallback(() => {
    // If user is logged in and has a codebase connection, do nothing (button is just for display)
  }, []);

  const handleCodebaseDropdownOpenChange = useCallback(
    (open: boolean) => {
      if (open && requiresLogin && !checkLoginAndProceed(ActionType.CODEBASE, message || undefined)) {
        return;
      }
      setIsCodebaseDropdownOpen(open);
    },
    [requiresLogin, checkLoginAndProceed, message],
  );

  const handleSubmit = useCallback(
    async (e?: React.FormEvent, overrideMessage?: string) => {
      e?.preventDefault();

      // If visitor has reached message limit, ignore submit
      if (isVisitorWithLimitReached) {
        return;
      }

      if ((!message.trim() || disabled) && !overrideMessage) {
        return;
      }
      const messageToSend = overrideMessage || message;

      // Check if login is required for this agent
      if (requiresLogin) {
        const completionOpts: ICompletionOptions = {
          processId: currentFlowId || '',
          flowMode: chatOptions.mode,
          enableSearch: chatOptions.search,
          uploadedFilePaths: uploadingFiles.map((item) => item.file.name),
          baseSkill: chatOptions.skill,
          labels: chatOptions.labels,
        };
        if (!checkLoginAndProceed(ActionType.SEND, messageToSend, completionOpts)) {
          return;
        }
      }

      // Add to history immediately when message is determined
      inputHistory.addToHistory(messageToSend);

      // Check if there are ongoing uploads or codebase connections
      const hasOngoingUploads = uploadingFiles.some((file) => file.isUploading);
      const hasOngoingCodebaseConnection = codebaseConnection?.isConnecting;

      if (hasOngoingUploads || hasOngoingCodebaseConnection) {
        // Show toast indicating we're waiting
        const waitingMessages = [];
        if (hasOngoingUploads) {
          const uploadingFileNames = uploadingFiles
            .filter((file) => file.isUploading)
            .map((file) => file.file.name)
            .join(', ');
          waitingMessages.push(`Uploading files: ${uploadingFileNames}`);
        }
        if (hasOngoingCodebaseConnection) {
          waitingMessages.push(`Connecting codebase: ${codebaseConnection?.name}`);
        }

        // Set waiting state and show a busy (spinner) toast
        setIsWaitingForOperations(true);
        const waitingId = `chat-waiting:${currentFlowId ?? 'new'}`;
        notify.busy({
          id: waitingId,
          title: t`Please wait...`,
          message: waitingMessages.join('. '),
        });

        // Store the pending submission and return early
        const sendingFlowId = currentFlowId;
        if (!sendingFlowId) {
          throw new Error('No flow ID found');
        }

        const completionOptions: ICompletionOptions = {
          processId: sendingFlowId,
          flowMode: chatOptions.mode,
          enableSearch: chatOptions.search,
          uploadedFilePaths: uploadingFiles.map((item) => item.file.name),
          baseSkill: chatOptions.skill,
          labels: chatOptions.labels,
        };
        if (pendingSubmission) notify.dismiss(pendingSubmission.notifyId);
        setPendingSubmission({ message: messageToSend, options: completionOptions, notifyId: waitingId });
        return;
      }

      const { processId: sendingFlowId } = currentFlowId ? { processId: currentFlowId } : await createFlow();

      const completionOptions: ICompletionOptions = {
        processId: sendingFlowId,
        flowMode: chatOptions.mode,
        enableSearch: chatOptions.search,
        uploadedFilePaths: uploadingFiles.map((item) => item.file.name),
        baseSkill: chatOptions.skill,
        labels: chatOptions.labels,
      };

      if (!processId) {
        // Coming from landing page - store pending message and navigate
        trackEvent({ event: 'flow_started' });
        setPendingMessage({ message: messageToSend, options: completionOptions });
        void navigate(`/agent/${agentId}/flow/${sendingFlowId}`);
        clearEditorContent();
        setMessage('');
        setUploadingFiles([]);
        return; // Don't send yet - ChatPanel will handle it
      }

      // Already in flow page - send immediately (followup message)
      onSendMessage?.(messageToSend, completionOptions);
      trackEvent({ event: 'message_sent' });

      if (visitor?.id) {
        incrementMessageCount(visitor.id);
      }

      setMessage('');
      setUploadingFiles([]);
    },
    [
      isVisitorWithLimitReached,
      message,
      disabled,
      uploadingFiles,
      codebaseConnection?.isConnecting,
      codebaseConnection?.name,
      currentFlowId,
      createFlow,
      processId,
      chatOptions,
      onSendMessage,
      visitor?.id,
      toast,
      pendingSubmission,
      navigate,
      agentId,
      incrementMessageCount,
      setPendingMessage,
      clearEditorContent,
      inputHistory,
      requiresLogin,
      checkLoginAndProceed,
    ],
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      void handleSubmit(e);
    } else if (e.key === 'ArrowUp') {
      // Only navigate history if cursor is on the first line
      const textarea = e.currentTarget;
      const cursorPosition = textarea.selectionStart;
      const textBeforeCursor = textarea.value.substring(0, cursorPosition);
      const isOnFirstLine = !textBeforeCursor.includes('\n');

      if (isOnFirstLine) {
        e.preventDefault();
        setMessage(inputHistory.navigateUp(message));
      }
    } else if (e.key === 'ArrowDown') {
      // Only navigate history if cursor is on the last line
      const textarea = e.currentTarget;
      const cursorPosition = textarea.selectionStart;
      const textAfterCursor = textarea.value.substring(cursorPosition);
      const isOnLastLine = !textAfterCursor.includes('\n');

      if (isOnLastLine) {
        e.preventDefault();
        setMessage(inputHistory.navigateDown(message));
      }
    } else if (e.key === 'Escape') {
      // Don't clear message if login dialog is open - let the dialog handle Esc
      if (showLoginDialog) {
        return;
      }
      e.preventDefault();
      setMessage('');
      inputHistory.clear();
    }
  };

  // Register setMessage handler with the store
  const { setSetMessageHandler } = useSendMessageStore();

  useEffect(() => {
    const setMessageHandler = (autoFillMessage: string) => {
      if (!textareaRef.current || textareaRef.current.value !== '' || !autoFillMessage) {
        return;
      }

      setMessage(autoFillMessage);
      setAnimateSubmit(true);
      setTimeout(() => {
        setAnimateSubmit(false);
      }, 3000);
    };

    setSetMessageHandler(setMessageHandler);
  }, [setSetMessageHandler]);

  useEffect(() => {
    const preFilledMessage = searchParams.get(config.PREFILL_MESSAGE_QUERY_PARAM);
    if (!preFilledMessage || isDisabled || hasProcessedPrefillRef.current) {
      return;
    }
    hasProcessedPrefillRef.current = true;
    navigator.removeQueryParam(window.location.href, config.PREFILL_MESSAGE_QUERY_PARAM);

    void handleSubmit(undefined, preFilledMessage);
  }, [searchParams, isDisabled, handleSubmit]);

  useEffect(() => {
    const newlineCount = (message.match(/\n/g) || []).length;
    setRows(Math.min(Math.max(newlineCount + 1, 1), 6));
  }, [message]);

  // Clear codebase connection when project changes
  useEffect(() => {
    setCodebaseConnection(null);
  }, [project?.id]);

  const handleZipFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      void addZipUpload(files[0]);
      e.target.value = '';
    },
    [addZipUpload],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      void addUploadingFiles(Array.from(files));
      e.target.value = '';
    },
    [addUploadingFiles],
  );

  const performGitClone = useCallback(
    async (url: string, branch?: string) => {
      try {
        const connection: CodebaseConnection = {
          name: url,
          type: CONNECTION_TYPES.GIT,
          isConnecting: true,
        };
        setCodebaseConnection(connection);

        const { projectId: uploadingProjectId } =
          currentProjectId && currentFlowId
            ? { processId: currentFlowId, projectId: currentProjectId }
            : await createFlow();

        // Setup compute node with a canonical GitOrigin.
        const projectForSetup = dataManager.getByTypeIdFromCache<Project>(new TypeId(Project.type, uploadingProjectId));
        if (!projectForSetup) {
          throw new Error('Project not found');
        }
        const gitOrigin = gitOriginFromUrl(url, branch);
        if (!gitOrigin) {
          throw new Error('Invalid Git repository URL');
        }
        await projectForSetup.setupComputeNode({ gitOrigin });

        // Mark the connection as connected
        setCodebaseConnection((prev) => (prev ? { ...prev, isConnecting: false } : null));

        // Check if we need to refresh the file system or project context
      } catch (error) {
        console.error('Error cloning git repository:', error);
        setCodebaseConnection(null);
        notify.error({
          title: t`Git Clone Failed`,
          message: t`Failed to clone the git repository. Please check the URL and try again.`,
        });
      }
    },
    [currentProjectId, currentFlowId, createFlow],
  );

  const handleGitCloneSubmit = useCallback(async () => {
    try {
      setIsCheckingRepo(true);

      if (!someone || visitor) {
        navigator.navigateToLogin();
        return;
      }

      const accessResult = await hasGitHubRepoAccess(gitUrl);

      if (accessResult && accessResult.hasAccess === true) {
        // User has access to the repository, proceed with cloning
        // Use the default branch from the access check
        await performGitClone(gitUrl, accessResult.defaultBranch || undefined);
        return;
      } else if (!accessResult || accessResult.hasAccess === false) {
        // User doesn't have access, show connection dialog
        // Save the default branch if we got one from the access check
        const defaultBranch = accessResult?.defaultBranch || null;
        setPendingDefaultBranch(defaultBranch);

        const projectTypeId = project?.typeId;
        if (!projectTypeId) {
          // No project context, create a flow first
          await createFlow();
          setPendingGitUrl(gitUrl);
          setShowGitHubDialog(true);
          return;
        } else {
          // We have a project context, show the GitHub connection dialog
          setPendingGitUrl(gitUrl);
          setShowGitHubDialog(true);
          return;
        }
      } else {
        // Error occurred while checking access
        notify.error({
          title: t`Error Checking Repository`,
          message: t`An error occurred while checking the repository. Please try again.`,
        });
        // Clear the codebase button
        setCodebaseConnection(null);
        return;
      }
    } catch (error) {
      console.error('Error checking repository access:', error);
      // If there's an error checking access, show alert and clear codebase button
      notify.error({
        title: t`Error Checking Repository`,
        message: t`An error occurred while checking the repository. Please try again.`,
      });
      // Clear the codebase button
      setCodebaseConnection(null);
    } finally {
      setIsCheckingRepo(false);
    }
  }, [gitUrl, performGitClone, someone, visitor, project?.typeId, createFlow]);

  const handleGitHubConnectionSuccess = useCallback(
    async (branch?: string) => {
      setShowGitHubDialog(false);
      // Resume cloning with the pending Git URL and optional branch
      if (pendingGitUrl) {
        await performGitClone(pendingGitUrl, branch);
        setPendingGitUrl('');
      }
    },
    [pendingGitUrl, performGitClone],
  );

  const handleGitHubDialogClose = useCallback(() => {
    setShowGitHubDialog(false);
    setPendingGitUrl('');
    setPendingDefaultBranch(null);
  }, []);

  return (
    <>
      <form
        data-testid="chat-input-form"
        onSubmit={(e) => void handleSubmit(e)}
        className="flex w-full flex-col gap-2 rounded-md border bg-accent/50 p-1 shadow-sm ring-offset-background focus-within:outline-none focus-within:ring-1 focus-within:ring-ring"
      >
        <DragDropOverlay
          zipFileEnabled={codebaseConnectionEnabled}
          onFilesDrop={(files) => void handleFilesDrop(files)}
        />
        <input
          ref={zipFileInputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => void handleZipFileInputChange(e)}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => void handleFileInputChange(e)}
        />
        <Textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isVisitorWithLimitReached
              ? t`Login to continue asking...`
              : isFollowup
                ? siteConfig?.branding?.company_name
                  ? t`Ask ${siteConfig.branding.company_name}...`
                  : t`Ask a follow up...`
                : siteConfig?.content?.placeholder ||
                  (siteConfig?.branding?.company_name
                    ? t`Ask ${siteConfig.branding.company_name} to solve...`
                    : t`Ask Flowpad to solve...`)
          }
          className="overflow-y min-h-[40px] flex-1 resize-none border-none shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
          disabled={isDisabled}
          rows={rows}
          style={{
            lineHeight: '1.5',
            maxHeight: `${6 * 1.5 * 1.2}em`, // 6 rows max with line-height consideration
          }}
          data-testid="agent-user-input"
        />

        <FileUploadIndicator files={uploadingFiles} onRemoveFile={(file) => void removeUploadingFile(file)} />

        <div className="flex items-end justify-between gap-2">
          <div className="flex items-center gap-2">
            {isExecutionFlowEnabled && (
              <Button
                type="button"
                className="h-auto w-min rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
                disabled={isDisabled}
                variant="outline"
                onClick={() => {
                  if (requiresLogin && !checkLoginAndProceed(ActionType.TOOLS, message || undefined)) {
                    return;
                  }
                  setIsToolsPanelOpen(true);
                }}
                title={t`Open tools panel`}
              >
                <Settings2 className="mr-1 h-3 w-3" />
                {t`Tools`}
              </Button>
            )}
            {codebaseConnectionEnabled && (
              <>
                {codebaseConnection ? (
                  <Button
                    type="button"
                    className={`h-auto w-min rounded-full border px-2 py-0.5 text-xs font-medium ${
                      codebaseConnection.isConnecting
                        ? 'border-yellow-200 bg-yellow-50 text-yellow-700 hover:bg-yellow-100'
                        : 'border-green-200 bg-green-50 text-green-700'
                    }`}
                    disabled={isDisabled || codebaseConnection.isConnecting}
                    variant="outline"
                    onClick={handleCodebaseButtonClick}
                    title={
                      codebaseConnection.isConnecting
                        ? t`Connecting: ${codebaseConnection.name}...`
                        : t`Connected: ${codebaseConnection.name}`
                    }
                  >
                    <FileArchive className="mr-1 h-3 w-3" />
                    {codebaseConnection.isConnecting
                      ? getRepoNameFromUrl(codebaseConnection.name) || t`Connecting...`
                      : getRepoNameFromUrl(codebaseConnection.name)}
                    {codebaseConnection.isConnecting && (
                      <div className="ml-1 h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" />
                    )}
                  </Button>
                ) : (
                  <DropdownMenu open={isCodebaseDropdownOpen} onOpenChange={handleCodebaseDropdownOpenChange}>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        className="h-auto w-min rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
                        disabled={isDisabled}
                        variant="outline"
                      >
                        <FileArchive className="mr-1 h-3 w-3" />
                        {t`Codebase`}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-48">
                      <DropdownMenuItem
                        className="flex items-center py-2"
                        onClick={() => {
                          zipFileInputRef.current?.click();
                        }}
                        disabled={isDisabled}
                      >
                        <FileArchive className="mr-2 h-3 w-3" />
                        {t`Upload ZIP`}
                      </DropdownMenuItem>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger className="flex items-center py-2" disabled={isDisabled}>
                          <GitBranch className="mr-2 h-3 w-3" />
                          {t`Git`}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-64">
                          <div className="flex items-center gap-2 p-1">
                            <Input
                              value={gitUrl}
                              onChange={(e) => setGitUrl(e.target.value)}
                              placeholder={t`Enter Git URL`}
                              className="flex-1 text-xs"
                            />
                            <Button
                              type="button"
                              size="sm"
                              onClick={() => {
                                if (!someone || visitor) {
                                  navigator.navigateToLogin();
                                  return;
                                }
                                void handleGitCloneSubmit();
                              }}
                              disabled={!gitUrl.trim() || isCheckingRepo}
                              className="h-6 px-2 text-xs"
                            >
                              {isCheckingRepo ? (
                                <>
                                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                                  {t`Checking...`}
                                </>
                              ) : (
                                t`Connect`
                              )}
                            </Button>
                          </div>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </>
            )}
            <Button
              type="button"
              className="h-auto w-min rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
              disabled={isDisabled}
              variant="outline"
              onClick={() => {
                if (requiresLogin && !checkLoginAndProceed(ActionType.FILES, message || undefined)) {
                  return;
                }
                fileInputRef.current?.click();
              }}
              title={t`Attach files`}
            >
              <Paperclip className="mr-1 h-3 w-3" />
              {t`Files`}
            </Button>
          </div>
          {disabled && onCancel ? (
            <Button
              type="button"
              onClick={onCancel}
              className="ml-auto rounded-full bg-gradient-to-r from-primary to-primary/80 text-white"
            >
              <Square className="h-4 w-4" />
            </Button>
          ) : isVisitorWithLimitReached ? (
            <Button
              type="button"
              onClick={handleLoginClick}
              className="ml-auto rounded-full bg-gradient-to-r from-primary to-primary/80 text-white"
            >
              {t`Login to Proceed`}
            </Button>
          ) : (
            <Button
              type="submit"
              disabled={!message.trim() || isDisabled}
              className={`ml-auto rounded-full bg-gradient-to-r from-primary to-primary/80 text-white ${animateSubmit ? 'animate-bounce' : ''}`}
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </form>

      {/* GitHub Connection Dialog */}
      {(project?.typeId || uploadingToProjectId) && (
        <GitHubConnectionDialog
          isOpen={showGitHubDialog}
          onClose={handleGitHubDialogClose}
          onConnectionSuccess={(branch?: string) => void handleGitHubConnectionSuccess(branch)}
          gitUrl={pendingGitUrl}
          defaultBranch={pendingDefaultBranch}
          currentProject={
            project?.typeId || (uploadingToProjectId ? new TypeId(Project.type, uploadingToProjectId) : undefined)
          }
        />
      )}

      {/* Tools Dialog */}
      <Dialog open={isToolsPanelOpen} onOpenChange={setIsToolsPanelOpen}>
        <DialogContent className="flex max-h-[80vh] max-w-md flex-col gap-0 p-0">
          <DialogHeader className="border-b px-6 pb-4 pt-6">
            <DialogTitle>{t`Tools`}</DialogTitle>
            <DialogDescription>{t`Configure execution mode, AI skill, and additional capabilities`}</DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto px-6 py-4">
            <ToolsPanel
              value={chatOptions}
              onChange={handleChatOptionsChange}
              disabled={isDisabled}
              onClose={() => void setIsToolsPanelOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Login Required Dialog */}
      <LoginDialog open={showLoginDialog} onOpenChange={closeLoginDialog} />
      {/* Visitor Limit Dialog */}
      <LoginDialog open={isVisitorWithLimitReached} variant="visitor_limit" />
    </>
  );
};

export default ChatInput;
