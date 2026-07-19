import { ContextEventType, dataContext } from '@sdk';
import { useCallback, useRef, useSyncExternalStore } from 'react';

// Single subscription manager to avoid multiple EventEmitter listeners
// All React components subscribe to this manager, which has one listener to dataContext
class ContextSubscriptionManager {
  private listeners = new Set<() => void>();
  private isSubscribed = false;

  subscribe(callback: () => void) {
    this.listeners.add(callback);

    // Subscribe to dataContext events only once
    if (!this.isSubscribed) {
      this.isSubscribed = true;
      dataContext.on(ContextEventType.CONTEXT_CHANGED, this.notifyListeners);
    }

    // Return cleanup function
    return () => {
      this.listeners.delete(callback);

      // Unsubscribe from dataContext if no more listeners
      if (this.listeners.size === 0 && this.isSubscribed) {
        this.isSubscribed = false;
        dataContext.off(ContextEventType.CONTEXT_CHANGED, this.notifyListeners);
      }
    };
  }

  private notifyListeners = () => {
    // Notify all React component subscribers
    this.listeners.forEach((callback) => callback());
  };
}

// Single shared instance
const contextSubscriptionManager = new ContextSubscriptionManager();

/**
 * Hook to access dataContext reactively using useSyncExternalStore
 * Mirrors all dataContext properties and adds project and computeNode
 */
export function useContext() {
  const snapshotRef = useRef<{
    user: typeof dataContext.user;
    workspace: typeof dataContext.workspace;
    activeEntity: typeof dataContext.activeEntity;
    activeEntityTypeId: typeof dataContext.activeEntityTypeId;
    workspaceTypeId: typeof dataContext.workspaceTypeId;
    userTypeId: typeof dataContext.userTypeId;
    visitorTypeId: typeof dataContext.visitorTypeId;
    someone: typeof dataContext.someone;
    activeOntology: typeof dataContext.activeOntology;
    activeLabels: typeof dataContext.activeLabels;
    manifests: typeof dataContext.manifests;
    plugins: typeof dataContext.plugins;
    project: typeof dataContext.project;
    computeNode: typeof dataContext.computeNode;
    visitor: typeof dataContext.visitor;
    bootstrapError: typeof dataContext.bootstrapError;
    isBootstrapping: typeof dataContext.isBootstrapping;
    envName: typeof dataContext.envName;
    cloudApiUrl: typeof dataContext.cloudApiUrl;
    cloudLoginAvailable: typeof dataContext.cloudLoginAvailable;
    desktopInfo: typeof dataContext.desktopInfo;
    isDesktop: typeof dataContext.isDesktop;
    instanceName: typeof dataContext.instanceName;
    warnings: typeof dataContext.warnings;
    agenticProcess: typeof dataContext.agenticProcess;
    agenticProcessTypeId: typeof dataContext.agenticProcessTypeId;
    activeShellId: typeof dataContext.activeShellId;
    activeTerminalTargetTypeId: typeof dataContext.activeTerminalTargetTypeId;
    workdir: typeof dataContext.workdir;
    terminalRuntimeError: typeof dataContext.terminalRuntimeError;
  }>({
    user: dataContext.user,
    workspace: dataContext.workspace,
    activeEntity: dataContext.activeEntity,
    activeEntityTypeId: dataContext.activeEntityTypeId,
    workspaceTypeId: dataContext.workspaceTypeId,
    userTypeId: dataContext.userTypeId,
    visitorTypeId: dataContext.visitorTypeId,
    someone: dataContext.someone,
    activeOntology: dataContext.activeOntology,
    activeLabels: dataContext.activeLabels,
    manifests: dataContext.manifests,
    plugins: dataContext.plugins,
    project: dataContext.project,
    computeNode: dataContext.computeNode,
    visitor: dataContext.visitor,
    bootstrapError: dataContext.bootstrapError,
    isBootstrapping: dataContext.isBootstrapping,
    envName: dataContext.envName,
    cloudApiUrl: dataContext.cloudApiUrl,
    cloudLoginAvailable: dataContext.cloudLoginAvailable,
    desktopInfo: dataContext.desktopInfo,
    isDesktop: dataContext.isDesktop,
    instanceName: dataContext.instanceName,
    warnings: dataContext.warnings,
    agenticProcess: dataContext.agenticProcess,
    agenticProcessTypeId: dataContext.agenticProcessTypeId,
    activeShellId: dataContext.activeShellId,
    activeTerminalTargetTypeId: dataContext.activeTerminalTargetTypeId,
    workdir: dataContext.workdir,
    terminalRuntimeError: dataContext.terminalRuntimeError,
  });

  // Subscribe to dataContext changes using the shared subscription manager
  // This ensures only ONE listener on the EventEmitter, regardless of how many components use this hook
  const subscribe = useCallback((callback: () => void) => {
    return contextSubscriptionManager.subscribe(callback);
  }, []);

  const getSnapshot = useCallback(() => {
    // Read current values from dataContext
    const current = {
      user: dataContext.user,
      workspace: dataContext.workspace,
      activeEntity: dataContext.activeEntity,
      activeEntityTypeId: dataContext.activeEntityTypeId,
      workspaceTypeId: dataContext.workspaceTypeId,
      userTypeId: dataContext.userTypeId,
      visitorTypeId: dataContext.visitorTypeId,
      someone: dataContext.someone,
      activeOntology: dataContext.activeOntology,
      activeLabels: dataContext.activeLabels,
      manifests: dataContext.manifests,
      plugins: dataContext.plugins,
      project: dataContext.project,
      computeNode: dataContext.computeNode,
      visitor: dataContext.visitor,
      bootstrapError: dataContext.bootstrapError,
      isBootstrapping: dataContext.isBootstrapping,
      envName: dataContext.envName,
      cloudApiUrl: dataContext.cloudApiUrl,
      cloudLoginAvailable: dataContext.cloudLoginAvailable,
      desktopInfo: dataContext.desktopInfo,
      isDesktop: dataContext.isDesktop,
      instanceName: dataContext.instanceName,
      warnings: dataContext.warnings,
      agenticProcess: dataContext.agenticProcess,
      agenticProcessTypeId: dataContext.agenticProcessTypeId,
      activeShellId: dataContext.activeShellId,
      activeTerminalTargetTypeId: dataContext.activeTerminalTargetTypeId,
      workdir: dataContext.workdir,
      terminalRuntimeError: dataContext.terminalRuntimeError,
    };

    // Only update snapshot if values have changed (to maintain stable reference)
    // For TypeId objects, compare by id instead of reference to avoid race conditions
    const prev = snapshotRef.current;
    const typeIdChanged = (
      a: { type?: string; id: string } | null | undefined,
      b: { type?: string; id: string } | null | undefined,
    ) => a?.type !== b?.type || a?.id !== b?.id;

    if (
      prev.user !== current.user ||
      prev.workspace !== current.workspace ||
      prev.activeEntity !== current.activeEntity ||
      typeIdChanged(prev.activeEntityTypeId, current.activeEntityTypeId) ||
      typeIdChanged(prev.workspaceTypeId, current.workspaceTypeId) ||
      typeIdChanged(prev.userTypeId, current.userTypeId) ||
      typeIdChanged(prev.visitorTypeId, current.visitorTypeId) ||
      prev.someone !== current.someone ||
      prev.activeOntology !== current.activeOntology ||
      prev.activeLabels !== current.activeLabels ||
      prev.manifests !== current.manifests ||
      prev.plugins !== current.plugins ||
      prev.project !== current.project ||
      prev.computeNode !== current.computeNode ||
      prev.visitor !== current.visitor ||
      prev.bootstrapError !== current.bootstrapError ||
      prev.isBootstrapping !== current.isBootstrapping ||
      prev.envName !== current.envName ||
      prev.cloudApiUrl !== current.cloudApiUrl ||
      prev.cloudLoginAvailable !== current.cloudLoginAvailable ||
      prev.desktopInfo !== current.desktopInfo ||
      prev.isDesktop !== current.isDesktop ||
      prev.instanceName !== current.instanceName ||
      prev.warnings !== current.warnings ||
      prev.agenticProcess !== current.agenticProcess ||
      typeIdChanged(prev.agenticProcessTypeId, current.agenticProcessTypeId) ||
      prev.activeShellId !== current.activeShellId ||
      typeIdChanged(prev.activeTerminalTargetTypeId, current.activeTerminalTargetTypeId) ||
      prev.workdir !== current.workdir ||
      prev.terminalRuntimeError?.kind !== current.terminalRuntimeError?.kind ||
      prev.terminalRuntimeError?.processId !== current.terminalRuntimeError?.processId
    ) {
      snapshotRef.current = current;
    }

    // Always return the same object reference (snapshotRef.current)
    // This is critical for useSyncExternalStore to work correctly
    return snapshotRef.current;
  }, []);

  // Subscribe to dataContext using useSyncExternalStore
  const contextData = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return contextData;
}
