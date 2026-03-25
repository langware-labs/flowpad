import {
  ActionInfo,
  Agent,
  ApiResponseStatus,
  dataManager,
  Flow,
  Membership,
  navigator,
  TypeId,
} from '@sdk';
import { Avatar, AvatarFallback, AvatarImage } from '@src/components/ui/avatar';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@src/components/ui/select';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { useToast } from '@src/hooks/use-toast';
import { useEntity } from '@src/hooks/entity-hooks';
import { useAuth } from '@sdk/react/hooks';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

// Bootstrap person-raised-hand icon component
const PersonRaisedHandIcon: React.FC<{ className?: string; size?: number }> = ({ className, size = 24 }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    fill="currentColor"
    className={className}
    viewBox="0 0 16 16"
    width={size}
    height={size}
    style={{ width: `${size}px`, height: `${size}px` }}
  >
    <path d="M6 6.207v9.043a.75.75 0 0 0 1.5 0V10.5a.5.5 0 0 1 1 0v4.75a.75.75 0 0 0 1.5 0v-8.5a.25.25 0 1 1 .5 0v2.5a.75.75 0 0 0 1.5 0V6.5a3 3 0 0 0-3-3H6.236a1 1 0 0 1-.447-.106l-.33-.165A.83.83 0 0 1 5 2.488V.75a.75.75 0 0 0-1.5 0v2.083c0 .715.404 1.37 1.044 1.689L5.5 5c.32.32.5.754.5 1.207" />
    <path d="M8 3a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3" />
  </svg>
);

interface ExpertResponse {
  status: ApiResponseStatus;
  details?: string;
}

interface SendToExpertButtonProps {
  agentId: string;
  processId: string;
}

export const SendToExpertButton: React.FC<SendToExpertButtonProps> = ({ agentId, processId }) => {
  const [loading, setLoading] = useState(false);
  const [members, setMembers] = useState<Membership[]>([]);
  const [selectedExpert, setSelectedExpert] = useState<string | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const isSendToExpert = searchParams.get('sendToExpert') === 'true';

  const agentTypeId = useMemo(() => new TypeId(Agent.type, agentId), [agentId]);
  const { data: agent } = useEntity<Agent>(agentTypeId, { watch: true });

  const handleOpenDialog = useCallback(() => {
    if (!user?.id) {
      const url = new URL(window.location.href);
      url.searchParams.set('sendToExpert', 'true');

      // Navigate to login page
      navigator.navigateToLogin(url?.toString());
      return;
    }

    setIsDialogOpen(true);
  }, [user?.id]);

  useEffect(() => {
    if (isSendToExpert) {
      // Remove the query parameter
      searchParams.delete('sendToExpert');
      // Update the URL without reloading
      void navigate({ search: searchParams.toString() }, { replace: true });

      // Open the dialog
      handleOpenDialog();
    }
  }, [handleOpenDialog, isSendToExpert, navigate, searchParams]);

  const fetchMembers = useCallback(async () => {
    setLoading(true);
    try {
      if (!agent) {
        toast({
          title: 'Error',
          description: 'Could not access agent information',
          variant: 'destructive',
        });
        setIsDialogOpen(false);
        return;
      }

      const workspace = await agent.get_related_workspace();
      if (!workspace) {
        toast({
          title: 'Error',
          description: 'Could not determine workspace for this chat',
          variant: 'destructive',
        });
        setIsDialogOpen(false);
        return;
      }

      if (!workspace || !workspace.typeId) {
        toast({
          title: 'Error',
          description: 'Could not access workspace information',
          variant: 'destructive',
        });
        setIsDialogOpen(false);
        return;
      }

      // Fetch memberships directly for the workspace
      const actionInfo = new ActionInfo('members', workspace.typeId.type, workspace.typeId.id, 'GET');
      const memberships = await dataManager.callAction<undefined, Membership[]>(actionInfo);

      if (memberships && memberships.length > 0) {
        // Filter approved members
        const approvedMembers = memberships.filter((member) => member.status === 'approved');
        setMembers(approvedMembers);
      } else {
        toast({
          title: 'No members found',
          description: 'No experts available for this workspace',
        });
      }
    } catch (error) {
      console.error('Error fetching members:', error);
      toast({
        title: 'Error',
        description: 'Failed to load experts',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [agent, toast]);

  // Fetch members when dialog opens
  useEffect(() => {
    if (isDialogOpen) {
      void fetchMembers();
    }
  }, [isDialogOpen, fetchMembers]);

  const handleCloseDialog = () => {
    setSelectedExpert(null);
    setIsDialogOpen(false);
  };

  const handleExpertChange = (value: string) => {
    setSelectedExpert(value);
  };

  const handleSendToExpert = useCallback(async () => {
    if (!processId) {
      toast({
        title: 'Error',
        description: 'No active chat found',
        variant: 'destructive',
      });
      return;
    }

    if (!selectedExpert) {
      toast({
        title: 'Error',
        description: 'Please select an expert',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    try {
      const expert = members.find((member) => member.user_id === selectedExpert);

      if (!expert) {
        toast({
          title: 'Error',
          description: 'Selected expert not found',
          variant: 'destructive',
        });
        return;
      }

      const flow = await Flow.getById(processId);
      if (!flow) {
        toast({
          title: 'Error',
          description: 'Chat not found',
          variant: 'destructive',
        });
        return;
      }

      const actionInfo = new ActionInfo(`open-issue`, Flow.type, processId, 'POST');
      actionInfo.scope = [agentTypeId];

      // TODO change this to body parameters
      actionInfo.queryParameters = {
        expert_id: expert.user_id,
      };

      const response = await dataManager.callAction<unknown, ExpertResponse>(actionInfo);

      if (response.status === 'SUCCESS') {
        toast({
          title: 'Success',
          description: `Request sent to ${expert.user_name || expert.user_email}`,
        });

        // The backend response includes the structured issue summary from LLM
        if (response.details) {
          toast({
            title: 'Issue Summary',
            description: response.details,
            duration: 6000,
          });
        }

        handleCloseDialog();
      } else {
        toast({
          title: 'Error',
          description: response.details || 'Failed to send request to expert',
          variant: 'destructive',
        });
      }
    } catch (error) {
      console.error('Error sending expert request:', error);
      toast({
        title: 'Error',
        description: 'Failed to send request to expert',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  }, [agentTypeId, processId, members, selectedExpert, toast]);

  // Use a different gradient for visual distinction
  const buttonStyle = {
    color: 'white',
    backgroundImage: 'linear-gradient(to left, hsl(var(--primary)), hsl(var(--primary) / 0.8))',
  };

  // Helper to get initials from a name
  const getInitials = useCallback((name: string) => {
    return name?.charAt(0)?.toUpperCase() || '?';
  }, []);

  // Check if the feature flag exists in the site config
  // Checking for any custom property since the TypeScript definition might not have been updated
  // const isEscalationEnabled = !!(siteConfig?.feature_flags &&
  //   siteConfig.feature_flags.enable_escalation);

  // // Don't render the button if escalation is disabled
  // if (!isEscalationEnabled) {
  //   return null;
  // }

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button style={buttonStyle} size="icon" className="h-8 w-8" onClick={handleOpenDialog} disabled={loading}>
              <PersonRaisedHandIcon className="h-1 w-1" size={16} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Send To Expert</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Send to Expert</DialogTitle>
            <DialogDescription>Choose an expert to help you with this issue</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <Select
              value={selectedExpert || ''}
              onValueChange={handleExpertChange}
              disabled={loading || members.length === 0}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select an expert..." />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Experts</SelectLabel>
                  {members.map((member) => (
                    <SelectItem key={member.user_id} value={member.user_id} className="cursor-pointer">
                      <div className="flex items-center gap-2">
                        <Avatar className="h-6 w-6">
                          {member.user_picture ? (
                            <AvatarImage src={member.user_picture} alt={member.user_name || member.user_email} />
                          ) : (
                            <AvatarFallback>{getInitials(member.user_name || member.user_email)}</AvatarFallback>
                          )}
                        </Avatar>
                        <div className="flex flex-col">
                          <span>{member.user_name || member.user_email}</span>
                          <span className="text-xs opacity-70">{member.user_email}</span>
                        </div>
                      </div>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>

            {loading && <div className="text-center">Creating and sending your issue...</div>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleCloseDialog}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                void handleSendToExpert();
              }}
              disabled={loading || !selectedExpert}
            >
              Send Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
