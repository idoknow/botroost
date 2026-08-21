const ROOT='/api/v1';
export class ApiError extends Error{constructor(public status:number,message:string){super(message);this.name='ApiError'}}
export class ApiClient{
 private csrf?:string;
 constructor(private fetcher?:typeof fetch){}
 async raw(path:string,init:RequestInit={}){const response=await (this.fetcher??globalThis.fetch)(`${ROOT}${path}`,{...init,credentials:'include',headers:{Accept:'application/json',...init.headers}});if(response.status===401){const returnTo=location.pathname+location.search;if(!location.pathname.startsWith('/login'))history.replaceState({},'',`/login?returnTo=${encodeURIComponent(returnTo)}`);throw new ApiError(401,'Authentication required')}if(!response.ok){let message=response.status===404?'Unavailable':`Request failed (${response.status})`;if(response.status!==404)try{const body=await response.json() as{error?:{message?:unknown}};if(typeof body.error?.message==='string')message=body.error.message}catch{/* Non-JSON errors use the status fallback. */}throw new ApiError(response.status,message)}return response}
 async get<T>(path:string,init:RequestInit={}):Promise<T>{return (await this.raw(path,init)).json() as Promise<T>}
 private async csrfToken(){if(!this.csrf)this.csrf=(await this.get<{csrfToken:string}>('/auth/csrf')).csrfToken;return this.csrf}
 async login(body:{email:string;password:string}){delete this.csrf;const response=await this.raw('/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return response.json()}
 async mutate<T>(path:string,body?:unknown,method='POST'):Promise<T>{const token=await this.csrfToken();const headers:Record<string,string>={'X-CSRF-Token':token,'Idempotency-Key':crypto.randomUUID()};const init:RequestInit={method,headers};if(body!==undefined){headers['Content-Type']='application/json';init.body=JSON.stringify(body)}const response=await this.raw(path,init);return response.status===204?undefined as T:response.json() as Promise<T>}
 async requestSecret<T>(path:string,body?:unknown):Promise<T>{const value=await this.mutate<T>(path,body);return value}
}
export const api=new ApiClient();
