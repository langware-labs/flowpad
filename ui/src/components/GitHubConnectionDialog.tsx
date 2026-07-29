import React, { useState, useEffect } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { useOAuthConnection } from '@sdk/react/hooks';
import { ConnectionStatus, TypeId } from '@sdk';
import { Github, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { fetchGitHubBranches } from '../utils/gitUtils';

interface GitHubConnectionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConnectionSuccess: (branch?: string) => void;
  gitUrl: string;
  defaultBranch?: string | null;
  currentProject?: TypeId;
}

interface Branch {
  name: string;
  protected: boolean;
}

const sortBranches = (branchesList: Branch[], defaultBranchName?: string | null): Branch[] => {
  const sorted = [...branchesList];

  const defaultName =
    defaultBranchName || sorted.find((b) => b.name === 'main')?.name || sorted.find((b) => b.name === 'master')?.name;

  if (defaultName) {
    const defaultIndex = sorted.findIndex((b) => b.name === defaultName);
    if (defaultIndex > 0) {
      // Move default branch to the beginning
      const [defaultBranch] = sorted.splice(defaultIndex, 1);
      sorted.unshift(defaultBranch);
    }
  }

  return sorted;
};

export const GitHubConnectionDialog: React.FC<GitHubConnectionDialogProps> = ({
  isOpen,
  onClose,
  onConnectionSuccess,
  gitUrl,
  defaultBranch,
  currentProject,
}) => {
  const { t } = useLingui();
  const [isConnecting, setIsConnecting] = useState(false);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [isLoadingBranches, setIsLoadingBranches] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);

  const { availableProviders, connectionStatuses, connect, connectingConnectionId } = useOAuthConnection({
    projectTypeId: currentProject,
    onConnectionConnect: () => {
      setIsConnecting(false);
    },
  });

  // Find GitHub provider
  const githubProvider = availableProviders.find((provider) => provider.name.toLowerCase() === 'github');

  // Check if GitHub is already connected
  const isGitHubConnected = githubProvider && connectionStatuses[githubProvider.name] === ConnectionStatus.CONNECTED;

  // Fetch branches when GitHub is connected
  useEffect(() => {
    const loadBranches = async () => {
      if (!isGitHubConnected || !isOpen) return;

      setIsLoadingBranches(true);
      setBranchError(null);
      try {
        const branchesList = await fetchGitHubBranches(gitUrl);

        if (branchesList.length === 0) {
          setBranchError(t`Unable to fetch branches. Please check your repository permissions.`);
        } else {
          const sortedBranches = sortBranches(branchesList, defaultBranch);
          setBranches(sortedBranches);
          setSelectedBranch(defaultBranch || sortedBranches[0].name);
        }
      } catch (error) {
        console.error('Error loading branches:', error);
        setBranchError(t`Failed to load branches from the repository.`);
      } finally {
        setIsLoadingBranches(false);
      }
    };

    void loadBranches();
  }, [isGitHubConnected, isOpen, gitUrl, defaultBranch]);

  const handleConnect = async () => {
    if (!githubProvider) return;

    try {
      setIsConnecting(true);
      await connect(githubProvider.name.toLowerCase(), githubProvider.name);
    } catch (error) {
      console.error('Failed to connect to GitHub:', error);
      setIsConnecting(false);
    }
  };

  const handleClose = () => {
    // Always allow closing
    setBranches([]);
    setSelectedBranch(null);
    setBranchError(null);
    setIsConnecting(false);
    onClose();
  };

  const handleContinueWithClone = () => {
    onConnectionSuccess(selectedBranch || undefined);
  };

  const isCurrentlyConnecting = connectingConnectionId === githubProvider?.name.toLowerCase();

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Github className="h-5 w-5" />
            <Trans>Connect to GitHub</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Seems like you are trying to clone a private git repo. You should connect to GitHub to complete the
              operation.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border bg-gray-50 p-4">
            <div className="mb-2 text-sm text-gray-600"><Trans>Repository URL:</Trans></div>
            <div className="break-all font-mono text-sm">{gitUrl}</div>
          </div>

          {isGitHubConnected ? (
            <>
              <div className="flex items-center gap-2 text-green-600">
                <CheckCircle className="h-4 w-4" />
                <span className="text-sm"><Trans>Connected to GitHub</Trans></span>
              </div>

              {isLoadingBranches ? (
                <div className="flex items-center gap-2 text-sm text-gray-600">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span><Trans>Loading branches...</Trans></span>
                </div>
              ) : branchError ? (
                <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3">
                  <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-red-800"><Trans>Error loading branches</Trans></p>
                    <p className="text-sm text-red-700">{branchError}</p>
                  </div>
                </div>
              ) : branches.length > 0 ? (
                <div className="flex items-center gap-3">
                  <label htmlFor="branch-select" className="text-sm font-medium text-gray-700">
                    <Trans>Branch:</Trans>
                  </label>
                  <Select value={selectedBranch || ''} onValueChange={setSelectedBranch}>
                    <SelectTrigger id="branch-select" className="flex-1">
                      <SelectValue placeholder={t`Select a branch`} />
                    </SelectTrigger>
                    <SelectContent>
                      {branches.map((branch) => (
                        <SelectItem key={branch.name} value={branch.name}>
                          {branch.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-sm text-gray-600">
              <Trans>Click the button below to connect your GitHub account and continue with the repository cloning.</Trans>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            <Trans>Cancel</Trans>
          </Button>
          {!isGitHubConnected && (
            <Button
              onClick={() => {
                void handleConnect();
              }}
              disabled={isConnecting || isCurrentlyConnecting}
              className="flex items-center gap-2"
            >
              {(isConnecting || isCurrentlyConnecting) && <Loader2 className="h-4 w-4 animate-spin" />}
              <Github className="h-4 w-4" />
              <Trans>Connect to GitHub</Trans>
            </Button>
          )}
          {isGitHubConnected && (
            <Button onClick={handleContinueWithClone} disabled={!selectedBranch}>
              <Trans>Continue</Trans>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
