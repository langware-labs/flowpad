import { ContextEventType, dataContext } from '../..';
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
    flow: typeof dataContext.flow;
    activeEntity: typeof dataContext.activeEntity;
    activeEntityTypeId: typeof dataContext.activeEntityTypeId;
    workspaceTypeId: typeof dataContext.workspaceTypeId;
    userTypeId: typeof dataContext.userTypeId;
    flowTypeId: typeof dataContext.flowTypeId;
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
    version: typeof dataContext.version;
    warnings: typeof dataContext.warnings;
    workflow: typeof dataContext.workflow;
    workflowTypeId: typeof dataContext.workflowTypeId;
    agenticProcess: typeof dataContext.agenticProcess;
    agenticProcessTypeId: typeof dataContext.agenticProcessTypeId;
    activeShellId: typeof dataContext.activeShellId;
    workdir: typeof dataContext.workdir;
    snifferEnabled: typeof dataContext.snifferEnabled;
    isConnected: typeof dataContext.isConnected;
  }>({
    user: dataContext.user,
    workspace: dataContext.workspace,
    flow: dataContext.flow,
    activeEntity: dataContext.activeEntity,
    activeEntityTypeId: dataContext.activeEntityTypeId,
    workspaceTypeId: dataContext.workspaceTypeId,
    userTypeId: dataContext.userTypeId,
    flowTypeId: dataContext.flowTypeId,
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
    version: dataContext.version,
    warnings: dataContext.warnings,
    workflow: dataContext.workflow,
    workflowTypeId: dataContext.workflowTypeId,
    agenticProcess: dataContext.agenticProcess,
    agenticProcessTypeId: dataContext.agenticProcessTypeId,
    activeShellId: dataContext.activeShellId,
    workdir: dataContext.workdir,
    snifferEnabled: dataContext.snifferEnabled,
    isConnected: dataContext.isConnected,
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
      flow: dataContext.flow,
      activeEntity: dataContext.activeEntity,
      activeEntityTypeId: dataContext.activeEntityTypeId,
      workspaceTypeId: dataContext.workspaceTypeId,
      userTypeId: dataContext.userTypeId,
      flowTypeId: dataContext.flowTypeId,
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
      version: dataContext.version,
      warnings: dataContext.warnings,
      workflow: dataContext.workflow,
      workflowTypeId: dataContext.workflowTypeId,
      agenticProcess: dataContext.agenticProcess,
      agenticProcessTypeId: dataContext.agenticProcessTypeId,
      activeShellId: dataContext.activeShellId,
      workdir: dataContext.workdir,
      snifferEnabled: dataContext.snifferEnabled,
      isConnected: dataContext.isConnected,
    };

    // Only update snapshot if values have changed (to maintain stable reference)
    // For TypeId objects, compare by id instead of reference to avoid race conditions
    const prev = snapshotRef.current;
    const typeIdChanged = (a: { id: string } | null | undefined, b: { id: string } | null | undefined) =>
      a?.id !== b?.id;

    if (
      prev.user !== current.user ||
      prev.workspace !== current.workspace ||
      prev.flow !== current.flow ||
      prev.activeEntity !== current.activeEntity ||
      typeIdChanged(prev.activeEntityTypeId, current.activeEntityTypeId) ||
      typeIdChanged(prev.workspaceTypeId, current.workspaceTypeId) ||
      typeIdChanged(prev.userTypeId, current.userTypeId) ||
      typeIdChanged(prev.flowTypeId, current.flowTypeId) ||
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
      prev.version !== current.version ||
      prev.warnings !== current.warnings ||
      prev.workflow !== current.workflow ||
      typeIdChanged(prev.workflowTypeId, current.workflowTypeId) ||
      prev.agenticProcess !== current.agenticProcess ||
      typeIdChanged(prev.agenticProcessTypeId, current.agenticProcessTypeId) ||
      prev.activeShellId !== current.activeShellId ||
      prev.workdir !== current.workdir ||
      prev.snifferEnabled !== current.snifferEnabled ||
      prev.isConnected !== current.isConnected
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
