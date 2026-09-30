import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Platform} from '../src/pages';
import {SystemStatus} from '../src/system-status';
import {LocaleProvider} from '../src/i18n';
import type {Endpoint,Node,PlatformEndpoint,PlatformNode,PlatformSettings,PlatformUser,PlatformWorkspace,Session} from '../src/types';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

const state={
  settings:{registrationOpen:false,maxWorkspacesPerUser:5,maxEndpointsPerWorkspace:10,endpointExpiryGraceHours:24} as PlatformSettings,
  workspaces:[] as PlatformWorkspace[],
  users:[] as PlatformUser[],
  endpoints:[] as PlatformEndpoint[],
  nodes:[] as PlatformNode[],
  sharedNodes:[] as Node[],
  sharedEndpoints:[] as Endpoint[],
};

const mock=vi.hoisted(()=>({get:vi.fn(),mutate:vi.fn()}));

const getAllPagesMock=vi.hoisted(()=>vi.fn());

vi.mock('../src/api',()=>({
  api:{
    get:mock.get,
    mutate:mock.mutate,
    registrationStatus:vi.fn(),
    updateRegistration:vi.fn(),
    platformSettings:vi.fn(),
    updatePlatformSettings:vi.fn(),
    platformWorkspaces:vi.fn(),
    createWorkspace:vi.fn(),
    renameWorkspace:vi.fn(),
    deleteWorkspace:vi.fn(),
    setWorkspaceExpiry:vi.fn(),
    platformUsers:vi.fn(),
    updatePlatformUser:vi.fn(),
    platformEndpoints:vi.fn(),
    deletePlatformEndpoint:vi.fn(),
    platformNodes:vi.fn(),
    updatePlatformNode:vi.fn(),
    updateNode:vi.fn(),
    setSharedNode:vi.fn(),
    grantSharedNode:vi.fn(),
    revokeSharedNode:vi.fn(),
    requestSecret:vi.fn(),
    sharedNodes:vi.fn(),
  },
  getAllPages:getAllPagesMock,
}));

const api=(await import('../src/api')).api as unknown as Record<string,ReturnType<typeof vi.fn>>;
const page=<T,>(items:T[])=>({items,page:1,pageSize:25,total:items.length});
const session:Session={
  user:{id:'u1',email:'owner@example.com',name:'owner@example.com'},
  workspace:{id:'w1',name:'Primary'},
  role:'admin',
  platformOwner:true,
  permissions:['workspace:read','member:read','member:manage','settings:read','settings:manage','node:read','node:create','endpoint:read','provider:read','operation:read','audit:read'],
  capabilities:{operations:[],providers:{},configurationSchemas:{}},
};

function render(node:React.ReactElement){
  const container=document.createElement('div');
  document.body.append(container);
  const root:Root=createRoot(container);
  act(()=>{root.render(createElement(LocaleProvider,null,node))});
  return{container,root};
}
const flush=async()=>{await act(async()=>{await Promise.resolve();await Promise.resolve()})};
const button=(scope:ParentNode,label:string)=>[...scope.querySelectorAll('button')].find(element=>element.textContent===label);
const activateTab=async(scope:ParentNode,label:string)=>{
  const trigger=[...scope.querySelectorAll('[role="tab"]')].find(element=>(element.textContent??'').startsWith(label));
  expect(trigger,'missing tab '+label).toBeDefined();
  await act(async()=>{(trigger as HTMLElement).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))});
  await flush();
};
const setInput=async(input:HTMLInputElement,value:string)=>act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
  input.dispatchEvent(new Event('input',{bubbles:true}));
});
const modalInput=(formId:string,index=0)=>{
  const form=document.querySelector(`#${formId}`) as HTMLFormElement;
  expect(form,`missing form ${formId}`).not.toBeNull();
  return form.querySelectorAll('input')[index] as HTMLInputElement;
};
const submit=async(formId:string)=>act(async()=>{(document.querySelector(`#${formId}`) as HTMLFormElement).dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});

beforeEach(()=>{
  state.settings={registrationOpen:false,maxWorkspacesPerUser:5,maxEndpointsPerWorkspace:10,endpointExpiryGraceHours:24};
  state.workspaces=[{id:'w1',name:'Primary',members:1,endpoints:1,expiresAt:null},{id:'w2',name:'Second',members:2,endpoints:0,expiresAt:null}];
  state.users=[
    {id:'u1',email:'owner@example.com',isPlatformOwner:true,disabledAt:null,maxEndpointsPerWorkspace:null,workspaces:2},
    {id:'u2',email:'member@example.com',isPlatformOwner:false,disabledAt:null,maxEndpointsPerWorkspace:3,workspaces:1},
  ];
  state.endpoints=[{id:'e1',workspaceId:'w1',workspaceName:'Primary',name:'ep-1',providerId:'fake',nodeId:null,desiredState:'stopped',deletedAt:null,createdAt:null}];
  state.nodes=[{id:'n1',workspaceId:'w1',name:'node-a',remark:null,provider:'fake',labels:{},enabled:false,grantedWorkspaceIds:[]}];
  state.sharedNodes=[{id:'n1',name:'node-a',remark:'校本部机房',provider:'fake',configured:true,lastHeartbeatAt:null}];
  state.sharedEndpoints=[];
  mock.get.mockReset();
  mock.mutate.mockReset();
  getAllPagesMock.mockReset().mockImplementation(async(path:string)=>path==='/nodes'?page(state.sharedNodes):page(state.sharedEndpoints));
  for(const key of Object.keys(api))api[key]!.mockReset?.();
  mock.get.mockImplementation(async(path:string)=>{
    if(path==='/platform/registration')return{registrationOpen:state.settings.registrationOpen};
    if(path==='/platform/settings')return state.settings;
    if(path==='/platform/workspaces')return{workspaces:state.workspaces};
    if(path==='/platform/users')return{users:state.users};
    if(path==='/platform/endpoints')return{endpoints:state.endpoints};
    if(path==='/platform/nodes')return{nodes:state.nodes};
    if(path==='/nodes')return page(state.sharedNodes);
    if(path==='/endpoints')return page(state.sharedEndpoints);
    if(path==='/workspaces/current/summary')return{endpoints:1,operations:0};
    if(path==='/providers')return page([]);
    throw new Error(`unexpected GET ${path}`);
  });
  window.history.replaceState({},'','/platform');
});
afterEach(()=>{document.body.innerHTML='';});

describe('platform quota administration UI',()=>{
  it('loads the platform quotas, saves an edit, and reports success',async()=>{
    api.updatePlatformSettings!.mockImplementation(async(input:Partial<PlatformSettings>)=>{state.settings={...state.settings,...input};return state.settings});
    const{container}=render(createElement(Platform,{session}));
    await flush();
    await activateTab(container,'Platform quotas');

    const endpointsInput=[...container.querySelectorAll('input[type="number"]')][1] as HTMLInputElement;
    expect(endpointsInput.value).toBe('10');
    await setInput(endpointsInput,'25');
    await act(async()=>{button(container,'Save changes')!.click()});
    await flush();

    expect(api.updatePlatformSettings).toHaveBeenCalledWith({maxWorkspacesPerUser:5,maxEndpointsPerWorkspace:25,endpointExpiryGraceHours:24});
    expect(container.textContent).toContain('Platform quotas updated.');
  });

  it('surfaces a failing platform quota update without claiming success',async()=>{
    api.updatePlatformSettings!.mockRejectedValue(new Error('forbidden'));
    const{container}=render(createElement(Platform,{session}));
    await flush();
    await activateTab(container,'Platform quotas');
    await act(async()=>{button(container,'Save changes')!.click()});
    await flush();

    expect(container.textContent).toContain('Unable to update platform quotas');
    expect(container.textContent).not.toContain('Platform quotas updated.');
  });
});

describe('platform user administration UI',()=>{
  it('lists every user with owner, workspace, quota and status columns',async()=>{
    const{container}=render(createElement(Platform,{session}));
    await flush();
    await activateTab(container,'Users');

    expect(container.textContent).toContain('owner@example.com');
    expect(container.textContent).toContain('member@example.com');
    // A per-user override is shown as a number, no override falls back to the platform default.
    expect(container.textContent).toContain('Platform default');
    expect(container.textContent).toContain('Owner');
    expect(container.textContent).toContain('Member');
    // The platform owner cannot disable their own account from the UI.
    // The platform owner cannot disable their own account: the control is present but inert.
    const ownerRow=[...container.querySelectorAll('tr')].find(row=>row.textContent?.includes('owner@example.com'))!;
    expect((button(ownerRow,'Disable') as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables another user and saves a per-user endpoint quota override',async()=>{
    api.updatePlatformUser!.mockImplementation(async(id:string,input:{disabled?:boolean;maxEndpointsPerWorkspace?:number|null})=>{
      state.users=state.users.map(user=>user.id===id?{...user,...(input.disabled===undefined?{}:{disabledAt:input.disabled?new Date().toISOString():null}),...(input.maxEndpointsPerWorkspace===undefined?{}:{maxEndpointsPerWorkspace:input.maxEndpointsPerWorkspace})}:user);
      return state.users.find(user=>user.id===id)!;
    });
    const{container}=render(createElement(Platform,{session}));
    await flush();
    await activateTab(container,'Users');

    const memberRow=[...container.querySelectorAll('tr')].find(row=>row.textContent?.includes('member@example.com'))!;
    await act(async()=>{button(memberRow,'Disable')!.click()});
    await flush();
    expect(api.updatePlatformUser).toHaveBeenCalledWith('u2',{disabled:true});
    expect(container.textContent).toContain('User updated.');

    const updatedRow=[...container.querySelectorAll('tr')].find(row=>row.textContent?.includes('member@example.com'))!;
    await act(async()=>{button(updatedRow,'Endpoint quota')!.click()});
    await flush();
    await setInput(modalInput('platform-user-quota-form'),'7');
    await submit('platform-user-quota-form');
    await flush();

    expect(api.updatePlatformUser).toHaveBeenLastCalledWith('u2',{maxEndpointsPerWorkspace:7});
    expect(container.textContent).toContain('7');
  });

  it('rejects a non-numeric override instead of sending it',async()=>{
    const{container}=render(createElement(Platform,{session}));
    await flush();
    await activateTab(container,'Users');
    const memberRow=[...container.querySelectorAll('tr')].find(row=>row.textContent?.includes('member@example.com'))!;
    await act(async()=>{button(memberRow,'Endpoint quota')!.click()});
    await flush();
    await setInput(modalInput('platform-user-quota-form'),'2.5');
    await submit('platform-user-quota-form');
    await flush();

    expect(api.updatePlatformUser).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Unable to update user');
  });
});

describe('platform endpoint administration UI',()=>{
  it('lists every endpoint across workspaces and deletes one',async()=>{
    api.deletePlatformEndpoint!.mockImplementation(async(id:string)=>{state.endpoints=state.endpoints.filter(endpoint=>endpoint.id!==id);return {status:'queued'} as never});
    const{container}=render(createElement(Platform,{session}));
    await flush();
    await activateTab(container,'Endpoints');

    expect(container.textContent).toContain('ep-1');
    expect(container.textContent).toContain('Primary');
    await act(async()=>{button(container,'Delete')!.click()});
    await flush();
    const dialogButton=[...document.querySelectorAll('[role="dialog"] button')].find(element=>element.textContent==='Delete') as HTMLButtonElement;
    await act(async()=>{dialogButton.click()});
    await flush();

    expect(api.deletePlatformEndpoint).toHaveBeenCalledWith('e1');
    expect(container.textContent).not.toContain('ep-1');
    // The platform delete queues a real runtime removal, so the confirmation says so.
    expect(container.textContent).toContain('Endpoint deletion queued');
  });

  it('surfaces a failing endpoint deletion',async()=>{
    api.deletePlatformEndpoint!.mockRejectedValue(new Error('not_found'));
    const{container}=render(createElement(Platform,{session}));
    await flush();
    await activateTab(container,'Endpoints');
    await act(async()=>{button(container,'Delete')!.click()});
    await flush();
    const dialogButton=[...document.querySelectorAll('[role="dialog"] button')].find(element=>element.textContent==='Delete') as HTMLButtonElement;
    await act(async()=>{dialogButton.click()});
    await flush();

    expect(container.textContent).toContain('Unable to delete endpoint');
  });
});

describe('platform workspace expiry UI',()=>{
  it('sets and clears a workspace expiry so the grace period can run',async()=>{
    api.setWorkspaceExpiry!.mockImplementation(async(workspaceId:string,expiresAt:string|null)=>{
      state.workspaces=state.workspaces.map(workspace=>workspace.id===workspaceId?{...workspace,expiresAt}:workspace);
      return{id:workspaceId,name:'x',expiresAt};
    });
    const{container}=render(createElement(Platform,{session}));
    await flush();
    await activateTab(container,'Workspaces');
    expect(container.textContent).toContain('No expiry');

    const secondRow=[...container.querySelectorAll('tr')].find(row=>row.textContent?.includes('Second'))!;
    await act(async()=>{button(secondRow,'Expires at')!.click()});
    await flush();
    await setInput(modalInput('platform-expiry-form'),'2026-10-01T12:00');
    await submit('platform-expiry-form');
    await flush();

    expect(api.setWorkspaceExpiry).toHaveBeenCalledWith('w2',new Date('2026-10-01T12:00').toISOString());
    expect(container.textContent).toContain('Workspace expiry updated.');

    const refreshedRow=[...container.querySelectorAll('tr')].find(row=>row.textContent?.includes('Second'))!;
    await act(async()=>{button(refreshedRow,'Expires at')!.click()});
    await flush();
    await act(async()=>{button(document.querySelector('[role="dialog"]')!,'Clear expiry')!.click()});
    await flush();

    expect(api.setWorkspaceExpiry).toHaveBeenLastCalledWith('w2',null);
  });
});

describe('node registration name and remark UI',()=>{
  it('edits the registration name and the remark as separate fields',async()=>{
    api.updatePlatformNode!.mockImplementation(async(id:string,input:{name?:string;remark?:string|null})=>{
      state.nodes=state.nodes.map(node=>node.id===id?{...node,...input}:node);
      return state.nodes[0]!;
    });
    const{container}=render(createElement(Platform,{session}));
    await flush();
    await activateTab(container,'Shared node pool');

    await act(async()=>{button(container,'Edit node')!.click()});
    await flush();
    await setInput(modalInput('platform-node-form',0),'node-b');
    await setInput(modalInput('platform-node-form',1),'校本部机房');
    await submit('platform-node-form');
    await flush();

    expect(api.updatePlatformNode).toHaveBeenCalledWith('n1',{name:'node-b',remark:'校本部机房'});
    expect(container.textContent).toContain('node-b');
    expect(container.textContent).toContain('校本部机房');
    expect(container.textContent).toContain('Node updated.');
  });

  it('sends a null remark when the remark field is cleared',async()=>{
    state.nodes=[{id:'n1',workspaceId:'w1',name:'node-a',remark:'旧的备注',provider:'fake',labels:{},enabled:false,grantedWorkspaceIds:[]}];
    api.updatePlatformNode!.mockResolvedValue(state.nodes[0]!);
    const{container}=render(createElement(Platform,{session}));
    await flush();
    await activateTab(container,'Shared node pool');
    await act(async()=>{button(container,'Edit node')!.click()});
    await flush();
    await setInput(modalInput('platform-node-form',1),'   ');
    await submit('platform-node-form');
    await flush();

    expect(api.updatePlatformNode).toHaveBeenCalledWith('n1',{name:'node-a',remark:null});
  });

  it('edits a node remark from the workspace node list',async()=>{
    api.updateNode!.mockImplementation(async(id:string,input:{name?:string;remark?:string|null})=>{
      state.sharedNodes=state.sharedNodes.map(node=>node.id===id?{...node,...input}:node);
      return{id,name:input.name??'node-a',remark:input.remark??null,provider:'fake'};
    });
    const{container}=render(createElement(SystemStatus,{session,path:'/system-status?section=nodes',endpoints:{data:page([]),loading:false,error:undefined,refresh:vi.fn()} as never}));
    await flush();

    expect(container.textContent).toContain('校本部机房');
    await act(async()=>{button(container,'Edit node')!.click()});
    await flush();
    await setInput(modalInput('system-node-form',1),'东区机房');
    await submit('system-node-form');
    await flush();

    expect(api.updateNode).toHaveBeenCalledWith('n1',{name:'node-a',remark:'东区机房'});
    expect(container.textContent).toContain('Node updated.');
  });
});
