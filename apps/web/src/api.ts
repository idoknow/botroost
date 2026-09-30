import type {Invitation,Operation,Page,PlatformEndpoint,PlatformNode,PlatformSettings,PlatformUser,PlatformWorkspace} from './types';
const ROOT='/api/v1';
export class ApiError extends Error{constructor(public status:number,message:string){super(message);this.name='ApiError'}}
export class ApiClient{
 private csrf?:string;
 constructor(private fetcher?:typeof fetch){}
 async raw(path:string,init:RequestInit={}){const response=await (this.fetcher??globalThis.fetch)(`${ROOT}${path}`,{...init,credentials:'include',headers:{Accept:'application/json',...init.headers}});if(response.status===401){const returnTo=location.pathname+location.search;if(!location.pathname.startsWith('/login')){history.replaceState({},'',`/login?returnTo=${encodeURIComponent(returnTo)}`);dispatchEvent(new Event('popstate'))}throw new ApiError(401,'Authentication required')}if(!response.ok){let message=response.status===404?'Unavailable':`Request failed (${response.status})`;if(response.status!==404)try{const body=await response.json() as{error?:{message?:unknown}};if(typeof body.error?.message==='string')message=body.error.message}catch{/* Non-JSON errors use the status fallback. */}throw new ApiError(response.status,message)}return response}
 async get<T>(path:string,init:RequestInit={}):Promise<T>{return (await this.raw(path,init)).json() as Promise<T>}
 private async csrfToken(){if(!this.csrf)this.csrf=(await this.get<{csrfToken:string}>('/auth/csrf')).csrfToken;return this.csrf}
 async register(body:{email:string;password:string;name:string}){delete this.csrf;const response=await this.raw('/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return response.json()}
 async acceptInvitation(body:{token:string;email:string;password:string}){delete this.csrf;const response=await this.raw('/auth/invitations/accept',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return response.json()}
 async registrationStatus(){return this.get<{registrationOpen:boolean}>('/platform/registration')}
 async updateRegistration(open:boolean){return this.mutate<{registrationOpen:boolean}>('/platform/registration',{open})}
 async createInvitation(body:{email:string;role:'admin'|'operator'|'viewer'}){return this.mutate<{id:string;email:string;role:string;expiresAt:string;acceptUrl:string}>('/workspaces/current/invitations',body)}
 async invitations(){return this.get<Page<Invitation>>('/workspaces/current/invitations')}
 async revokeInvitation(id:string){return this.mutate<void>(`/workspaces/current/invitations/${id}`,undefined,'DELETE')}
 async sharedNodes(){return this.get<{nodes:{id:string;name:string;provider:string;labels:Record<string,string>}[]}>('/workspaces/current/nodes/shared')}
 async platformWorkspaces(){return this.get<{workspaces:PlatformWorkspace[]}>('/platform/workspaces')}
 async createWorkspace(name:string){return this.mutate<PlatformWorkspace>('/workspaces',{name})}
 async renameWorkspace(workspaceId:string,name:string){return this.mutate<PlatformWorkspace>(`/platform/workspaces/${workspaceId}`,{name},'PATCH')}
 async deleteWorkspace(workspaceId:string){return this.mutate<void>(`/platform/workspaces/${workspaceId}`,undefined,'DELETE')}
 async platformNodes(){return this.get<{nodes:PlatformNode[]}>('/platform/nodes')}
 async updatePlatformNode(id:string,input:{name?:string;remark?:string|null}){return this.mutate<PlatformNode>(`/platform/nodes/${id}`,input,'PATCH')}
 async updateNode(id:string,input:{name?:string;remark?:string|null}){return this.mutate<{id:string;name:string;remark:string|null;provider:string}>(`/nodes/${id}`,input,'PATCH')}
 async platformSettings(){return this.get<PlatformSettings>('/platform/settings')}
 async updatePlatformSettings(input:Partial<Omit<PlatformSettings,'registrationOpen'>>){return this.mutate<PlatformSettings>('/platform/settings',input,'PATCH')}
 async platformUsers(){return this.get<{users:PlatformUser[]}>('/platform/users')}
 async updatePlatformUser(id:string,input:{disabled?:boolean;maxEndpointsPerWorkspace?:number|null}){return this.mutate<PlatformUser>(`/platform/users/${id}`,input,'PATCH')}
 async platformEndpoints(){return this.get<{endpoints:PlatformEndpoint[]}>('/platform/endpoints')}
 async deletePlatformEndpoint(id:string){return this.mutate<Operation>(`/platform/endpoints/${id}`,undefined,'DELETE')}
 async setWorkspaceExpiry(workspaceId:string,expiresAt:string|null){return this.mutate<{id:string;name:string;expiresAt:string|null}>(`/platform/workspaces/${workspaceId}/expiry`,{expiresAt},'PUT')}
 async setSharedNode(id:string,enabled:boolean,labels:Record<string,string>){return this.mutate<{nodeId:string;enabled:boolean;labels:Record<string,string>}>(`/platform/nodes/${id}/shared`,{enabled,labels},'PUT')}
 async grantSharedNode(workspaceId:string,nodeId:string){return this.mutate<void>(`/platform/workspaces/${workspaceId}/nodes/${nodeId}`,undefined,'PUT')}
 async revokeSharedNode(workspaceId:string,nodeId:string){return this.mutate<void>(`/platform/workspaces/${workspaceId}/nodes/${nodeId}`,undefined,'DELETE')}
 async workspaces(){return this.get<{workspaces:{id:string;name:string;role:string}[];currentWorkspaceId:string}>('/auth/workspaces')}
 async switchWorkspace(workspaceId:string){await this.mutate<void>('/auth/workspace',{workspaceId});delete this.csrf}
 async login(body:{email:string;password:string}){delete this.csrf;const response=await this.raw('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return response.json()}
 async mutate<T>(path:string,body?:unknown,method='POST'):Promise<T>{const token=await this.csrfToken();const headers:Record<string,string>={'X-CSRF-Token':token,'Idempotency-Key':crypto.randomUUID()};const init:RequestInit={method,headers};if(body!==undefined){headers['Content-Type']='application/json';init.body=JSON.stringify(body)}const response=await this.raw(path,init);return response.status===204?undefined as T:response.json() as Promise<T>}
 async requestSecret<T>(path:string,body?:unknown):Promise<T>{const value=await this.mutate<T>(path,body);return value}
}
export const api=new ApiClient();

export async function getAllPages<T>(path:string,signal?:AbortSignal):Promise<{items:T[];page:number;pageSize:number;total:number}>{
 const items:T[]=[];
 for(let pageNumber=1;pageNumber<=1000;pageNumber++){
  const suffix=pageNumber===1?'':`${path.includes('?')?'&':'?'}page=${pageNumber}`;
  const result=await api.get<{items:T[];page:number;pageSize:number;total:number}>(path+suffix,{signal});
  if(!Array.isArray(result.items)||!Number.isInteger(result.total)||result.total<0)throw new Error('Invalid collection response');
  items.push(...result.items);
  if(items.length>=result.total)return{items,page:1,pageSize:items.length,total:items.length};
  if(!result.items.length||result.page!==pageNumber)throw new Error('Incomplete collection response');
 }
 throw new Error('Collection exceeds pagination limit');
}
