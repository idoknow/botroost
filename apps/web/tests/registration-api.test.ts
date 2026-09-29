import {describe,expect,it} from 'bun:test';
import {ApiClient} from '../src/api';

describe('registration API',()=>{
  it('reads the public registration contract',async()=>{
    const calls:string[]=[];
    const api=new ApiClient(async(input)=>{calls.push(String(input));return Response.json({registrationOpen:false})});
    expect(await api.registrationStatus()).toEqual({registrationOpen:false});
    expect(calls).toEqual(['/api/v1/platform/registration']);
  });
  it('preserves invitation acceptance through the invitation endpoint',async()=>{
    let request:RequestInit|undefined;
    const api=new ApiClient(async(_input,init)=>{request=init;return Response.json({ok:true})});
    await api.acceptInvitation({token:'invite-token',email:'a@example.test',password:'secret'});
    expect(request?.method).toBe('POST');
    expect(JSON.parse(String(request?.body))).toEqual({token:'invite-token',email:'a@example.test',password:'secret'});
  });
});
