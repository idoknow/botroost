import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Platform} from '../src/pages';
import {LocaleProvider} from '../src/i18n';
import type {PlatformEndpoint,PlatformNode,PlatformSettings,PlatformUser,PlatformWorkspace,Session} from '../src/types';

/**
 * Regression: editing a platform quota used to blank the whole console.
 *
 * The three quota inputs read `event.currentTarget.value` *inside* the
 * `setQuotaDraft` updater. React runs an updater during the NEXT render pass,
 * where the event has been released and `currentTarget` is already null, so it
 * threw `TypeError: Cannot read properties of null (reading 'value')`. With no
 * ErrorBoundary in main.tsx the throw unmounted the entire tree -> blank screen.
 *
 * The fix reads the value before scheduling the update. This test fails if the
 * read is ever moved back inside the updater.
 */
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;

const state={
  settings:{registrationOpen:false,maxWorkspacesPerUser:5,maxEndpointsPerWorkspace:10,endpointExpiryGraceHours:24} as PlatformSettings,
  workspaces:[{id:'w1',name:'Primary',members:1,endpoints:1,expiresAt:null,createdAt:'2026-08-13T16:43:49.240Z'}] as PlatformWorkspace[],
  users:[{id:'u1',email:'owner@example.com',isPlatformOwner:true,disabledAt:null,maxEndpointsPerWorkspace:null,workspaces:1}] as PlatformUser[],
  endpoints:[] as PlatformEndpoint[],
  nodes:[] as PlatformNode[],
};

const mock=vi.hoisted(()=>({get:vi.fn(),mutate:vi.fn()}));
const getAllPagesMock=vi.hoisted(()=>vi.fn());

vi.mock('../src/api',()=>({
  api:{get:mock.get,mutate:mock.mutate,registrationStatus:vi.fn(),updateRegistration:vi.fn(),
    platformSettings:vi.fn(),updatePlatformSettings:vi.fn(),platformWorkspaces:vi.fn(),
    createWorkspace:vi.fn(),renameWorkspace:vi.fn(),deleteWorkspace:vi.fn(),setWorkspaceExpiry:vi.fn(),
    platformUsers:vi.fn(),updatePlatformUser:vi.fn(),platformEndpoints:vi.fn(),deletePlatformEndpoint:vi.fn(),
    platformNodes:vi.fn(),updatePlatformNode:vi.fn(),updateNode:vi.fn(),setSharedNode:vi.fn(),
    grantSharedNode:vi.fn(),revokeSharedNode:vi.fn(),requestSecret:vi.fn(),sharedNodes:vi.fn()},
  getAllPages:getAllPagesMock,
}));

const api=(await import('../src/api')).api as unknown as Record<string,ReturnType<typeof vi.fn>>;
const page=<T,>(items:T[])=>({items,page:1,pageSize:25,total:items.length});
const session:Session={
  user:{id:'u1',email:'owner@example.com',name:'owner@example.com'},
  workspace:{id:'w1',name:'Primary'},role:'owner',platformOwner:true,
  permissions:['workspace:read','settings:read','settings:manage','node:read','endpoint:read'],
  capabilities:{operations:[],providers:{},configurationSchemas:{}},
};

let root:Root|undefined;
let container:HTMLElement|undefined;
let errors:unknown[]=[];
const flush=async()=>{await act(async()=>{await Promise.resolve();await Promise.resolve()})};

async function openQuotas(){
  container=document.createElement('div');
  document.body.append(container);
  root=createRoot(container);
  await act(async()=>{root!.render(createElement(LocaleProvider,null,createElement(Platform,{session})))});
  await flush();
  const trigger=[...container.querySelectorAll('[role="tab"]')].find(el=>/quota/i.test(el.textContent??''));
  await act(async()=>{(trigger as HTMLElement).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))});
  await flush();
}

/** Type like a real browser: React processes the update AFTER the dispatch returns. */
async function type(input:HTMLInputElement,value:string){
  const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;
  setter.call(input,value);
  input.dispatchEvent(new Event('input',{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,60));
}

beforeEach(()=>{
  state.settings={registrationOpen:false,maxWorkspacesPerUser:5,maxEndpointsPerWorkspace:10,endpointExpiryGraceHours:24};
  mock.get.mockReset();mock.mutate.mockReset();
  getAllPagesMock.mockReset().mockImplementation(async()=>page([]));
  for(const key of Object.keys(api))api[key]!.mockReset?.();
  mock.get.mockImplementation(async(path:string)=>{
    if(path==='/platform/registration')return{registrationOpen:false};
    if(path==='/platform/settings')return state.settings;
    if(path==='/platform/workspaces')return{workspaces:state.workspaces};
    if(path==='/platform/users')return{users:state.users};
    if(path==='/platform/endpoints')return{endpoints:state.endpoints};
    if(path==='/platform/nodes')return{nodes:state.nodes};
    if(path==='/nodes'||path==='/endpoints')return page([]);
    throw new Error('unexpected GET '+path);
  });
  errors=[];
  vi.spyOn(console,'error').mockImplementation((...args:unknown[])=>{
    const text=args.map(String).join(' ');
    if(!/React DevTools/.test(text)&&!/not wrapped in act/.test(text))errors.push(text);
  });
  window.history.replaceState({},'','/platform');
});
afterEach(()=>{
  if(root&&container?.childElementCount){try{act(()=>{root!.unmount()})}catch{/* already unmounted by the throw */}}
  document.body.innerHTML='';
  root=undefined;container=undefined;
  vi.restoreAllMocks();
});

describe('platform quota inputs survive editing',()=>{
  it('keeps the page mounted and applies every typed value',async()=>{
    await openQuotas();
    const inputs=[...container!.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
    expect(inputs.length).toBe(3);
    expect(inputs.map(input=>input.value)).toEqual(['5','10','24']);

    // Clearing the field is the case that produced currentTarget === null.
    await type(inputs[0]!,'');
    expect(container!.childElementCount,'page unmounted after clearing the field').toBeGreaterThan(0);
    expect(errors).toEqual([]);

    await type(inputs[0]!,'8');
    await type(inputs[1]!,'20');
    await type(inputs[2]!,'48');

    const after=[...container!.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
    expect(after.map(input=>input.value)).toEqual(['8','20','48']);
    expect(container!.childElementCount,'page unmounted while typing').toBeGreaterThan(0);
    expect(errors,'a TypeError leaked while typing').toEqual([]);
  });

  it('sends the edited quotas when saving',async()=>{
    api.updatePlatformSettings!.mockImplementation(async(input:Partial<PlatformSettings>)=>{state.settings={...state.settings,...input};return state.settings});
    await openQuotas();
    const inputs=[...container!.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
    await type(inputs[1]!,'25');

    const save=[...container!.querySelectorAll('button')].find(button=>/Save changes/i.test(button.textContent??''));
    await act(async()=>{save!.click()});
    await flush();

    expect(api.updatePlatformSettings).toHaveBeenCalledWith({maxWorkspacesPerUser:5,maxEndpointsPerWorkspace:25,endpointExpiryGraceHours:24});
    expect(errors).toEqual([]);
  });
});
