import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Invitations,Platform,SharedNodes} from '../src/pages';
import {LocaleProvider} from '../src/i18n';
import type {Invitation,PlatformNode,PlatformWorkspace,Session} from '../src/types';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

const state={
  invitations:[] as Invitation[],
  registrationOpen:false,
  workspaces:[] as (PlatformWorkspace & {members?:number;endpoints?:number;createdAt?:string|null})[],
  nodes:[] as PlatformNode[],
  shared:[] as {id:string;name:string;provider:string;labels:Record<string,string>}[],
};

const mock=vi.hoisted(()=>({get:vi.fn(),mutate:vi.fn()}));

vi.mock('../src/api',()=>({
  api:{
    get:mock.get,
    mutate:mock.mutate,
    registrationStatus:vi.fn(),
    updateRegistration:vi.fn(),
    createInvitation:vi.fn(),
    invitations:vi.fn(),
    revokeInvitation:vi.fn(),
    sharedNodes:vi.fn(),
    platformWorkspaces:vi.fn(),
    createWorkspace:vi.fn(),
    renameWorkspace:vi.fn(),
    deleteWorkspace:vi.fn(),
    platformNodes:vi.fn(),
    setSharedNode:vi.fn(),
    grantSharedNode:vi.fn(),
    revokeSharedNode:vi.fn(),
  },
  getAllPages:vi.fn(),
}));

const api=(await import('../src/api')).api as unknown as Record<string,ReturnType<typeof vi.fn>>;

const page=<T,>(items:T[])=>({items,page:1,pageSize:25,total:items.length});
const session:Session={
  user:{id:'u1',email:'owner@example.com',name:'owner@example.com'},
  workspace:{id:'w1',name:'Primary'},
  role:'admin',
  platformOwner:true,
  permissions:['workspace:read','member:read','member:manage','settings:read','settings:manage','node:read','endpoint:read','provider:read','operation:read','audit:read'],
  capabilities:{operations:[],providers:{},configurationSchemas:{}},
};
const viewerSession:Session={...session,role:'viewer',permissions:['workspace:read','endpoint:read'],platformOwner:false};

function render(node:React.ReactElement){
  const container=document.createElement('div');
  document.body.append(container);
  const root:Root=createRoot(container);
  act(()=>{root.render(createElement(LocaleProvider,null,node))});
  return{container,root};
}
const flush=async()=>{await act(async()=>{await Promise.resolve();await Promise.resolve()})};
const button=(scope:ParentNode,label:string)=>[...scope.querySelectorAll('button')].find(element=>element.textContent===label);
const tab=(scope:ParentNode,label:string)=>{
  const trigger=[...scope.querySelectorAll('[role="tab"]')].find(element=>(element.textContent??'').startsWith(label));
  expect(trigger,'missing tab '+label).toBeDefined();
  return trigger as HTMLElement;
};
/** Radix activates tabs on mousedown, not click. */
const activateTab=async(scope:ParentNode,label:string)=>{await act(async()=>{tab(scope,label).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))});await flush()};
const dialogButton=(label:string)=>{
  const found=[...document.querySelectorAll('[role="dialog"] button')].find(element=>element.textContent===label);
  expect(found,'missing dialog button '+label).toBeDefined();
  return found as HTMLButtonElement;
};

beforeEach(()=>{
  state.invitations=[];
  state.registrationOpen=false;
  state.workspaces=[];
  state.nodes=[];
  state.shared=[];
  mock.get.mockReset();
  mock.mutate.mockReset();
  for(const key of ['registrationStatus','updateRegistration','createInvitation','invitations','revokeInvitation','sharedNodes','platformWorkspaces','createWorkspace','renameWorkspace','deleteWorkspace','platformNodes','setSharedNode','grantSharedNode','revokeSharedNode'])api[key]!.mockReset();
  mock.get.mockImplementation(async(path:string)=>{
    if(path==='/platform/registration')return{registrationOpen:state.registrationOpen};
    if(path==='/platform/workspaces')return{workspaces:state.workspaces};
    if(path==='/platform/nodes')return{nodes:state.nodes};
    if(path==='/workspaces/current/nodes/shared')return{nodes:state.shared};
    if(path.startsWith('/workspaces/current/invitations'))return page(state.invitations);
    throw new Error(`unexpected GET ${path}`);
  });
  window.history.replaceState({},'','/workspace/invitations');
});
afterEach(()=>{document.body.innerHTML='';});

describe('Invitations page',()=>{
  beforeEach(()=>{
    state.invitations=[
      {id:'i1',email:'pending@example.com',role:'viewer',expiresAt:new Date(Date.now()+86_400_000).toISOString(),createdAt:null,acceptedAt:null,revokedAt:null},
      {id:'i2',email:'accepted@example.com',role:'admin',expiresAt:new Date(Date.now()+86_400_000).toISOString(),createdAt:null,acceptedAt:new Date().toISOString(),revokedAt:null},
      {id:'i3',email:'revoked@example.com',role:'operator',expiresAt:new Date(Date.now()+86_400_000).toISOString(),createdAt:null,acceptedAt:null,revokedAt:new Date().toISOString()},
      {id:'i4',email:'expired@example.com',role:'viewer',expiresAt:new Date(Date.now()-86_400_000).toISOString(),createdAt:null,acceptedAt:null,revokedAt:null},
    ];
  });

  it('renders every invitation lifecycle state and only offers revoke while it can still be used',async()=>{
    const{container}=render(createElement(Invitations,{session}));
    await flush();

    const text=container.textContent??'';
    for(const value of ['pending@example.com','accepted@example.com','revoked@example.com','expired@example.com'])expect(text).toContain(value);
    for(const label of ['Pending','Accepted','Revoked','Expired'])expect(text).toContain(label);
    expect(mock.get).toHaveBeenCalledWith('/workspaces/current/invitations',expect.anything());
    // Revoke is offered only for invitations that can still be redeemed (pending + expired), never for accepted or already revoked ones.
    const revokeButtons=[...container.querySelectorAll('button')].filter(element=>element.textContent==='Revoke');
    expect(revokeButtons).toHaveLength(2);
    const revokeRowEmails=revokeButtons.map(element=>element.closest('tr')!.textContent??'');
    expect(revokeRowEmails[0]).toContain('pending@example.com');
    expect(revokeRowEmails[1]).toContain('expired@example.com');
  });

  it('creates an invitation and reveals the one-time accept link, never the stored token',async()=>{
    api.createInvitation!.mockResolvedValue({id:'i9',email:'new@example.com',role:'viewer',expiresAt:new Date(Date.now()+86_400_000).toISOString(),acceptUrl:'https://app.test/login?invite=raw-token'});
    const{container}=render(createElement(Invitations,{session}));
    await flush();

    await act(async()=>{button(container,'Create invitation')!.click()});
    // The modal is portalled to document.body, not into the page container.
    const form=document.querySelector('#invitation-form') as HTMLFormElement;
    expect(form).not.toBeNull();
    const email=form.querySelector('input[type="email"]') as HTMLInputElement;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(email,'new@example.com');
      email.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});
    await flush();

    expect(api.createInvitation).toHaveBeenCalledWith({email:'new@example.com',role:'viewer'});
    expect(document.body.textContent).toContain('https://app.test/login?invite=raw-token');
    expect(document.body.textContent).not.toMatch(/token_hash/);
    // The list is refetched after a successful create.
    expect(mock.get.mock.calls.filter(([path])=>path==='/workspaces/current/invitations').length).toBe(2);
  });

  it('revokes a pending invitation and surfaces a failing revoke',async()=>{
    api.revokeInvitation!.mockRejectedValue(new Error('not_found'));
    const{container}=render(createElement(Invitations,{session}));
    await flush();

    await act(async()=>{button(container,'Revoke')!.click()});
    await act(async()=>{dialogButton('Revoke').click()});

    expect(api.revokeInvitation).toHaveBeenCalledWith('i1');
    expect(document.body.textContent).toContain('Unable to revoke invitation');
  });

  it('hides invitation management from members without member:manage',async()=>{
    const{container}=render(createElement(Invitations,{session:viewerSession}));
    await flush();
    expect(button(container,'Create invitation')).toBeUndefined();
    expect(button(container,'Revoke')).toBeUndefined();
  });
});

describe('Platform page',()=>{
  it('loads the registration policy, saves a change, and reports success',async()=>{
    api.updateRegistration!.mockImplementation(async(open:boolean)=>{state.registrationOpen=open;return{registrationOpen:open}});
    const{container}=render(createElement(Platform,{session}));
    await flush();

    const toggle=container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(tab(container,'Public registration')).toBeDefined();

    await act(async()=>{toggle.click()});
    expect(toggle.checked).toBe(true);
    await act(async()=>{button(container,'Save changes')!.click()});
    await flush();

    expect(api.updateRegistration).toHaveBeenCalledWith(true);
    expect(container.textContent).toContain('Registration policy updated.');
    expect(container.textContent).toContain('Open');
  });

  it('reports a failed registration policy update without claiming success',async()=>{
    state.registrationOpen=true;
    api.updateRegistration!.mockRejectedValue(new Error('forbidden'));
    const{container}=render(createElement(Platform,{session}));
    await flush();

    const toggle=container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await act(async()=>{button(container,'Save changes')!.click()});
    await flush();

    expect(container.textContent).toContain('Unable to update registration policy');
    expect(container.textContent).not.toContain('Registration policy updated.');
  });

  it('creates, renames, and deletes workspaces while protecting the active one',async()=>{
    state.workspaces=[{id:'w1',name:'Primary',members:1,endpoints:0,createdAt:new Date().toISOString()},{id:'w2',name:'Second',members:2,endpoints:3,createdAt:new Date().toISOString()}];
    api.createWorkspace!.mockImplementation(async(name:string)=>{const created={id:'w3',name};state.workspaces=[...state.workspaces,created];return created});
    api.renameWorkspace!.mockImplementation(async(id:string,name:string)=>{state.workspaces=state.workspaces.map(workspace=>workspace.id===id?{...workspace,name}:workspace);return{id,name}});
    api.deleteWorkspace!.mockImplementation(async(id:string)=>{state.workspaces=state.workspaces.filter(workspace=>workspace.id!==id)});
    const{container}=render(createElement(Platform,{session}));
    await flush();

    await activateTab(container,'Workspaces');
    expect(container.textContent).toContain('Second');
    // The active workspace is labelled and cannot be deleted.
    expect(container.textContent).toContain('Active');
    expect([...container.querySelectorAll('button')].filter(element=>element.textContent==='Delete')).toHaveLength(1);

    await act(async()=>{button(container,'Create workspace')!.click()});
    const form=document.querySelector('#platform-workspace-form') as HTMLFormElement;
    const input=form.querySelector('input') as HTMLInputElement;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Third');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});
    await flush();
    expect(api.createWorkspace).toHaveBeenCalledWith('Third');
    expect(container.textContent).toContain('Third');

    await act(async()=>{button(container,'Rename')!.click()});
    const renameForm=document.querySelector('#platform-rename-form') as HTMLFormElement;
    const renameInput=renameForm.querySelector('input') as HTMLInputElement;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(renameInput,'Renamed');
      renameInput.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await act(async()=>{renameForm.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});
    await flush();
    expect(api.renameWorkspace).toHaveBeenCalledWith('w1','Renamed');

    await act(async()=>{button(container,'Delete')!.click()});
    await act(async()=>{dialogButton('Delete').click()});
    await flush();
    expect(api.deleteWorkspace).toHaveBeenCalledWith('w2');
    expect(container.textContent).not.toContain('Second');
  });

  it('surfaces a failing workspace delete',async()=>{
    state.workspaces=[{id:'w1',name:'Primary'},{id:'w2',name:'Second'}];
    api.deleteWorkspace!.mockRejectedValue(new Error('conflict'));
    const{container}=render(createElement(Platform,{session}));
    await flush();
    await activateTab(container,'Workspaces');
    await act(async()=>{button(container,'Delete')!.click()});
    await act(async()=>{dialogButton('Delete').click()});
    await flush();
    expect(container.textContent).toContain('Unable to delete workspace');
  });

  it('publishes a node to the shared pool, grants it, and revokes the grant',async()=>{
    state.workspaces=[{id:'w1',name:'Primary'},{id:'w2',name:'Second'}];
    state.nodes=[{id:'n1',workspaceId:'w1',name:'node-a',provider:'fake',labels:{region:'eu'},enabled:false,grantedWorkspaceIds:[]}];
    api.setSharedNode!.mockImplementation(async(id:string,enabled:boolean,labels:Record<string,string>)=>{state.nodes=state.nodes.map(node=>node.id===id?{...node,enabled,labels}:node);return{nodeId:id,enabled,labels}});
    api.grantSharedNode!.mockImplementation(async(workspaceId:string,nodeId:string)=>{state.nodes=state.nodes.map(node=>node.id===nodeId?{...node,grantedWorkspaceIds:[...node.grantedWorkspaceIds,workspaceId]}:node)});
    api.revokeSharedNode!.mockImplementation(async(workspaceId:string,nodeId:string)=>{state.nodes=state.nodes.map(node=>node.id===nodeId?{...node,grantedWorkspaceIds:node.grantedWorkspaceIds.filter(id=>id!==workspaceId)}:node)});
    const{container}=render(createElement(Platform,{session}));
    await flush();

    await activateTab(container,'Shared node pool');
    expect(container.textContent).toContain('Private');
    expect(container.textContent).toContain('node-a');

    await act(async()=>{button(container,'Enable sharing')!.click()});
    await flush();
    expect(api.setSharedNode).toHaveBeenCalledWith('n1',true,{region:'eu'});
    expect(container.textContent).toContain('Shared');

    const select=container.querySelector('select[aria-label="Select workspace"], select') as HTMLSelectElement;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')!.set!.call(select,'w2');
      select.dispatchEvent(new Event('change',{bubbles:true}));
    });
    await flush();
    expect(api.grantSharedNode).toHaveBeenCalledWith('w2','n1');

    const grant=[...container.querySelectorAll('button')].find(element=>element.textContent==='Second ✕')!;
    expect(grant).toBeDefined();
    await act(async()=>{grant.click()});
    await flush();
    expect(api.revokeSharedNode).toHaveBeenCalledWith('w2','n1');

    await act(async()=>{button(container,'Disable sharing')!.click()});
    await flush();
    expect(api.setSharedNode).toHaveBeenLastCalledWith('n1',false,{region:'eu'});
    expect(container.textContent).toContain('Private');
  });

  it('reports a failing shared-node update',async()=>{
    state.nodes=[{id:'n1',workspaceId:'w1',name:'node-a',provider:'fake',labels:{},enabled:false,grantedWorkspaceIds:[]}];
    api.setSharedNode!.mockRejectedValue(new Error('forbidden'));
    const{container}=render(createElement(Platform,{session}));
    await flush();
    await activateTab(container,'Shared node pool');
    await act(async()=>{button(container,'Enable sharing')!.click()});
    await flush();
    expect(container.textContent).toContain('Unable to update shared node');
  });
});

describe('SharedNodes page',()=>{
  it('lists the nodes other workspaces share with this one',async()=>{
    state.shared=[{id:'n1',name:'node-a',provider:'fake',labels:{region:'eu'}},{id:'n2',name:'node-b',provider:'fake',labels:{}}];
    const{container}=render(createElement(SharedNodes,{session}));
    await flush();
    expect(mock.get).toHaveBeenCalledWith('/workspaces/current/nodes/shared',expect.anything());
    expect(container.textContent).toContain('node-a');
    expect(container.textContent).toContain('region=eu');
    expect(container.textContent).toContain('node-b');
  });

  it('shows the empty state when nothing is shared',async()=>{
    const{container}=render(createElement(SharedNodes,{session}));
    await flush();
    expect(container.textContent).toContain('shared nodes');
  });
});
