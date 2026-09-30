import {describe,expect,it} from 'vitest';
import {en,ja,zhCN,zhTW} from '../src/locales';

const locales={en,ja,zhCN,zhTW} as const;
const requiredRegistrationKeys=['login.register','login.name','login.registerFailed','login.registrationUnavailable'] as const;
const requiredWorkspaceAdminKeys=[
  'invitations.title','invitations.create','invitations.email','invitations.role','invitations.createFailed',
  'invitations.statusPending','invitations.statusAccepted','invitations.statusRevoked','invitations.statusExpired',
  'invitations.revoke','invitations.revokeFailed','invitations.linkHint','invitations.copyLink','invitations.copied',
  'platform.title','platform.registration','platform.registrationOpen','platform.registrationClosed',
  'platform.registrationSaved','platform.registrationFailed','platform.workspaces','platform.createWorkspace',
  'platform.workspaceName','platform.createFailed','platform.rename','platform.renameFailed','platform.delete',
  'platform.deleteBody','platform.deleteFailed','platform.activeWorkspace','platform.nodes','platform.shared',
  'platform.notShared','platform.enableShared','platform.disableShared','platform.selectWorkspace','platform.labels',
  'platform.sharedFailed','platform.grantFailed','platform.revokeFailed','shared.title','shared.description','shared.empty',
] as const;

describe('locale message parity',()=>{
  it('keeps every locale on the same message-key set as English',()=>{
    const expected=Object.keys(en).sort();
    for(const [locale,messages] of Object.entries(locales)){
      expect(Object.keys(messages).sort(),`${locale} message keys`).toEqual(expected);
    }
  });

  it('populates all required registration messages in every locale',()=>{
    for(const [locale,messages] of Object.entries(locales)){
      for(const key of requiredRegistrationKeys){
        expect(messages[key],`${locale}.${key}`).toEqual(expect.any(String));
        expect(messages[key].trim(),`${locale}.${key} must not be blank`).not.toBe('');
      }
    }
  });

  it('populates the invitation, platform, and shared-node messages in every locale',()=>{
    for(const [locale,messages] of Object.entries(locales)){
      for(const key of requiredWorkspaceAdminKeys){
        expect(messages[key],`${locale}.${key}`).toEqual(expect.any(String));
        expect(messages[key].trim(),`${locale}.${key} must not be blank`).not.toBe('');
      }
    }
  });
});
