import {afterEach,describe,expect,it,vi} from 'vitest';
import {ApiClient} from '../src/api';

afterEach(()=>vi.restoreAllMocks());

describe('ApiClient',()=>{
 it('logs in without prefetching protected CSRF and reads the canonical csrfToken afterwards',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({expiresAt:'tomorrow'}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({csrfToken:'csrf-after-login'}),{status:200})).mockResolvedValueOnce(new Response(null,{status:204}));
  const api=new ApiClient(fetcher);
  await api.login({email:'owner@example.com',password:'correct horse battery staple'});
  expect(fetcher).toHaveBeenNthCalledWith(1,'/api/v1/auth/login',expect.objectContaining({method:'POST',credentials:'include'}));
  expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('csrf');
  await api.mutate('/auth/logout');
  expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get('X-CSRF-Token')).toBe('csrf-after-login');
 });
 it('gets CSRF before mutation and sends credentials plus idempotency key',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({csrfToken:'csrf-1'}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({id:'op-1'}),{status:201}));
  const api=new ApiClient(fetcher);
  await api.mutate('/operations',{kind:'start'});
  expect(fetcher).toHaveBeenNthCalledWith(1,'/api/v1/auth/csrf',expect.objectContaining({credentials:'include'}));
  const init=fetcher.mock.calls[1]?.[1] as RequestInit;
  expect(init.credentials).toBe('include'); expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-1');
  expect(new Headers(init.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
 });
 it('does not retain or expose secret response bodies',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({csrfToken:'csrf'}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({token:'one-time-secret'}),{status:200}));
  const api=new ApiClient(fetcher);
  expect(await api.requestSecret('/nodes/enrollment-tokens')).toEqual({token:'one-time-secret'});
  expect(JSON.stringify(api)).not.toContain('one-time-secret');
 });
 it('represents 404 API gaps as unavailable',async()=>{
  const api=new ApiClient(vi.fn().mockResolvedValue(new Response('',{status:404})));
  await expect(api.get('/missing')).rejects.toEqual(expect.objectContaining({name:'ApiError',status:404,message:'Unavailable'}));
 });
 it('accepts successful mutations without a response body',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({csrfToken:'csrf'}))).mockResolvedValueOnce(new Response(null,{status:204}));
  await expect(new ApiClient(fetcher).mutate('/auth/logout')).resolves.toBeUndefined();
 });
});
