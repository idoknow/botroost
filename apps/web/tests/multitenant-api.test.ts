import {describe,expect,it} from "bun:test";
import {ApiClient} from "../src/api";

describe('ApiClient registration and workspace switching',()=>{
 it('reads public registration availability from the platform contract',async()=>{
  let url='';const api=new ApiClient(async(input)=>{url=String(input);return Response.json({registrationOpen:false})});
  expect(await api.registrationStatus()).toEqual({registrationOpen:false});
  expect(url).toBe('/api/v1/platform/registration');
  expect(typeof (await api.registrationStatus()).registrationOpen).toBe('boolean');
 });
 it('registers without CSRF prefetch and switches through a CSRF-protected request',async()=>{
  const calls: {url:RequestInfo|URL;init?:RequestInit}[]=[];
  const responses=[new Response(JSON.stringify({user:{id:'u'},workspaceId:'w1'})),new Response(JSON.stringify({csrfToken:'csrf'})),new Response(null,{status:204}),new Response(JSON.stringify({userId:'u',workspaceId:'w1'}))];
  const fetcher=async(url:RequestInfo|URL,init?:RequestInit)=>{calls.push({url,init});return responses.shift()!};
  const api=new ApiClient(fetcher as typeof fetch);
  await api.register({email:'a@example.com',password:'secure password 123',name:'A'});
  expect(calls[0]?.url).toBe('/api/v1/auth/register');
  await api.switchWorkspace('workspace-2');
  expect(calls[1]?.url).toBe('/api/v1/auth/csrf');
  await api.acceptInvitation({token:'x'.repeat(43),email:'a@example.com',password:'secure password 123'});
  expect(calls[3]?.url).toBe('/api/v1/auth/invitations/accept');
  expect(calls[2]?.url).toBe('/api/v1/auth/workspace');
  expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({workspaceId:'workspace-2'});
 });
});
