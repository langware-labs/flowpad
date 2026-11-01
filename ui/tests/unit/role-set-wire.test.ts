import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager, Project, Conversation, TypeId, mintInviteLink, setPublicAccess, membershipService } from '@sdk';
const id = '91c340cb-a2cc-4f67-9fe1-f2a0e481a0e3';
afterEach(() => vi.restoreAllMocks());
describe('role set wire contract', () => {
  it('invites and changes the entire independent Reader + Runner set', async () => {
    const entity = new Project({id, type:'project'});
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue([]);
    await entity.inviteMember('person@example.com', ['reader','runner']);
    expect(call.mock.calls[0][0].bodyParameters).toMatchObject({ invitation_targets:[{typeid:`project-${id}`,roles:['reader','runner']}] });
    await entity.setMemberRole('someone', ['runner']);
    expect(call.mock.calls[1][0].bodyParameters).toEqual({user_id:'someone',roles:['runner']});
    await entity.addGroupMember(new TypeId('team', id), ['reader','runner']);
    expect(call.mock.calls[2][0].bodyParameters).toMatchObject({ invitation_targets:[{typeid:`project-${id}`,roles:['reader','runner']}] });
  });
  it('defaults projects to Reader and conversations to Reader + Runner', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue([]);
    await new Project({id,type:'project'}).inviteMember('person@example.com');
    await new Conversation({id,type:'conversation'}).inviteMember('person@example.com');
    expect(call.mock.calls[0][0].bodyParameters.invitation_targets[0].roles).toEqual(['reader']);
    expect(call.mock.calls[1][0].bodyParameters.invitation_targets[0].roles).toEqual(['reader','runner']);
  });
  it('uses role sets for links and public grants, and retains transfer arrays', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue([]);
    await mintInviteLink(new TypeId('conversation',id));
    expect(call.mock.calls[0][0].bodyParameters.invitation_targets[0].roles).toEqual(['reader','runner']);
    await setPublicAccess(new TypeId('agent',id),'visitor',['runner']);
    expect(call.mock.calls[1][0].bodyParameters).toEqual({roles:['runner']});
    await new Project({id,type:'project'}).inviteMember('person@example.com',['owner'],{transfer:true,rolesToKeep:['reader','runner']});
    expect(call.mock.calls[2][0].bodyParameters.roles_to_keep).toEqual(['reader','runner']);
  });
});

it('rejects owner_by_api in every membership grant path before sending', async () => {
  const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue([]);
  const entity = new Project({id, type: 'project'});
  await expect(entity.inviteMember('person@example.com', ['owner_by_api'])).rejects.toThrow('Unassignable');
  await expect(entity.setMemberRole('person', ['owner_by_api'])).rejects.toThrow('Unassignable');
  await expect(entity.addGroupMember(new TypeId('team', id), ['owner_by_api'])).rejects.toThrow('Unassignable');
  await expect(entity.inviteMember('person@example.com', ['reader'], {extraTargets: [{typeid: `project-${id}`, roles:['owner_by_api']}]})).rejects.toThrow('Unassignable');
  await expect(mintInviteLink(new TypeId('project', id), ['owner_by_api'])).rejects.toThrow('Unassignable');
  await expect(setPublicAccess(new TypeId('project', id), 'visitor', ['owner_by_api'])).rejects.toThrow('Unassignable');
  await expect(entity.share([{idOrEmail: 'person@example.com', roles: ['owner_by_api']}])).rejects.toThrow('Unassignable');
  await expect(membershipService.createMembership(new TypeId('project', id), {recipient_email:'person@example.com', invitation_targets:[{typeid:new TypeId('project',id), roles:['owner_by_api']}]})).rejects.toThrow('Unassignable');
  await expect(membershipService.updateMembershipRole(new TypeId('project',id), {user_id:'person',user_email:'person@example.com',roles:['owner_by_api']})).rejects.toThrow('Unassignable');
  expect(call).not.toHaveBeenCalled();
});
it('does not retain either ownership role during transfer', async () => {
  const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue([]);
  for (const role of ['owner', 'owner_by_api']) {
    await expect(new Project({id,type:'project'}).inviteMember('person@example.com', ['owner'], {transfer:true,rolesToKeep:[role]})).rejects.toThrow('Unassignable');
  }
  expect(call).not.toHaveBeenCalled();
});
it('keeps Reader and Runner capabilities independent and API ownership scoped', () => {
  for (const [roles, reader, runner, editor] of [
    [['reader'], true, false, false],
    [['runner'], false, true, false],
    [['editor'], true, true, true],
    [['owner_by_api'], false, false, false],
  ] as const) {
    const entity = new Project({id,type:'project',expand:{roles:[...roles]}});
    expect([entity.ImReader, entity.ImRunner, entity.ImEditor]).toEqual([reader,runner,editor]);
  }
});

it('normalizes case and whitespace consistently with the hub', async () => {
  const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue([]);
  await new Project({id,type:'project'}).setMemberRole('person', [' Runner ', 'READER', 'reader']);
  expect(call.mock.calls[0][0].bodyParameters).toEqual({user_id:'person',roles:['reader','runner']});
});
