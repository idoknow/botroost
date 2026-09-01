import {afterEach,describe,expect,it,mock} from 'bun:test';
import {ApiClient} from '../src/api';

afterEach(()=>mock.restore());
const sequence=(...responses:Response[])=>mock((..._args:Parameters<typeof fetch>)=>Promise.resolve(responses.shift()!));

describe('ApiClient',()=>{
 it('logs in without prefetching protected CSRF and reads the canonical csrfToken afterwards',async()=>{
  const fetcher=sequence(new Response(JSON.stringify({expiresAt:'tomorrow'}),{status:200}),new Response(JSON.stringify({csrfToken:'csrf-after-login'}),{status:200}),new Response(null,{status:204}));
  const api=new ApiClient(fetcher as unknown as typeof fetch);
  await api.login({email:'owner@example.com',password:'correct horse battery staple'});
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/auth/login');expect(fetcher.mock.calls[0]?.[1]).toMatchObject({method:'POST',credentials:'include'});
  expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('csrf');
  await api.mutate('/auth/logout');
  expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-after-login');
 });
 it('gets CSRF before mutation and sends credentials plus idempotency key',async()=>{
  const fetcher=sequence(new Response(JSON.stringify({csrfToken:'csrf-1'}),{status:200}),new Response(JSON.stringify({id:'op-1'}),{status:201}));
  const api=new ApiClient(fetcher as unknown as typeof fetch);
  await api.mutate('/operations',{kind:'start'});
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/auth/csrf');expect(fetcher.mock.calls[0]?.[1]).toMatchObject({credentials:'include'});
  const init=fetcher.mock.calls[1]?.[1] as RequestInit;
  expect(init.credentials).toBe('include'); expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-1');
  expect(new Headers(init.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
 });
 it('does not retain or expose secret response bodies',async()=>{
  const fetcher=sequence(new Response(JSON.stringify({csrfToken:'csrf'}),{status:200}),new Response(JSON.stringify({token:'one-time-secret'}),{status:200}));
  const api=new ApiClient(fetcher as unknown as typeof fetch);
  expect(await api.requestSecret('/nodes/enrollment-tokens')).toEqual({token:'one-time-secret'});
  expect(JSON.stringify(api)).not.toContain('one-time-secret');
 });
 it('forwards an abort signal to bounded polling requests',async()=>{
  const controller=new AbortController();
  const fetcher=mock((_url:RequestInfo|URL,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(init.signal?.reason),{once:true})));
  const request=new ApiClient(fetcher as unknown as typeof fetch).get('/status',{signal:controller.signal});
  controller.abort(new DOMException('timed out','TimeoutError'));
  await expect(request).rejects.toMatchObject({name:'TimeoutError'});
  expect((fetcher.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
 });
 it('notifies the client router when a concurrent protected request redirects to login',async()=>{
  const descriptors={location:Object.getOwnPropertyDescriptor(globalThis,'location'),history:Object.getOwnPropertyDescriptor(globalThis,'history'),dispatchEvent:Object.getOwnPropertyDescriptor(globalThis,'dispatchEvent')};
  const dispatchEvent=mock((_event:Event)=>true);
  try{
   Object.defineProperty(globalThis,'location',{configurable:true,value:{pathname:'/endpoints',search:'?page=2'}});
   Object.defineProperty(globalThis,'history',{configurable:true,value:{replaceState:mock(()=>undefined)}});
   Object.defineProperty(globalThis,'dispatchEvent',{configurable:true,value:dispatchEvent});
   await expect(new ApiClient(sequence(new Response('',{status:401})) as unknown as typeof fetch).get('/endpoints')).rejects.toMatchObject({status:401});
   expect(dispatchEvent).toHaveBeenCalledTimes(1);
   expect(dispatchEvent.mock.calls[0]?.[0]).toEqual(expect.objectContaining({type:'popstate'}));
  }finally{
   for(const [key,descriptor] of Object.entries(descriptors))if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete (globalThis as Record<string,unknown>)[key];
  }
 });
 it('represents 404 API gaps as unavailable',async()=>{
  const api=new ApiClient(mock(()=>Promise.resolve(new Response('',{status:404}))));
  await expect(api.get('/missing')).rejects.toEqual(expect.objectContaining({name:'ApiError',status:404,message:'Unavailable'}));
 });
 it('shows safe API validation messages for failed mutations',async()=>{
  const fetcher=sequence(new Response(JSON.stringify({csrfToken:'csrf'})),new Response(JSON.stringify({error:{message:'current password is incorrect'}}),{status:403,headers:{'content-type':'application/json'}}));
  await expect(new ApiClient(fetcher as unknown as typeof fetch).mutate('/auth/password',{},'PUT')).rejects.toEqual(expect.objectContaining({name:'ApiError',status:403,message:'current password is incorrect'}));
 });
 it('does not send a JSON content type for bodyless mutations',async()=>{
  const fetcher=sequence(new Response(JSON.stringify({csrfToken:'csrf'})),new Response(null,{status:204}));
  await new ApiClient(fetcher as unknown as typeof fetch).mutate('/auth/logout');
  const init=fetcher.mock.calls[1]?.[1] as RequestInit;
  expect(new Headers(init.headers).get('Content-Type')).toBeNull(); expect(init.body).toBeUndefined();
 });
 it('accepts successful mutations without a response body',async()=>{
  const fetcher=sequence(new Response(JSON.stringify({csrfToken:'csrf'})),new Response(null,{status:204}));
  await expect(new ApiClient(fetcher as unknown as typeof fetch).mutate('/auth/logout')).resolves.toBeUndefined();
 });
});
