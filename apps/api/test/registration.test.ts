import {describe,expect,it} from "vitest";
import {buildApi} from "../src/index.js";
import {AuthService} from "@botroost/auth";
import {InMemoryDatabase,digest} from "@botroost/database";

describe("registration policy",()=>{
  it("rejects registration by default and permits it only after the switch is enabled",async()=>{
    const database=new InMemoryDatabase();
    const api=buildApi({database:database as never,credentialKey:Buffer.alloc(32,1),publicOrigin:"https://app.test"});
    await api.ready();
    const closed=await api.inject({method:"POST",url:"/api/v1/auth/register",payload:{email:"new@example.com",password:"a sufficiently long password",name:"New"}});
    expect(closed.statusCode).toBe(403);
    await database.updatePlatformSettings(true);
    await database.updatePlatformSettings(true);
    const opened=await api.inject({method:"POST",url:"/api/v1/auth/register",payload:{email:"new@example.com",password:"a sufficiently long password",name:"New Workspace"}});
    expect(opened.statusCode).toBe(201);
    expect(opened.headers["set-cookie"]).toBeDefined();
    expect(opened.json().workspaceId).toBeTruthy();
    await api.close();
  });

  it("bootstraps a CSRF-valid session after invitation acceptance",async()=>{
    const database=new InMemoryDatabase();
    const api=buildApi({database:database as never,credentialKey:Buffer.alloc(32,1),publicOrigin:"https://app.test"});
    await api.ready();
    await database.updatePlatformSettings(true);
    const auth=new AuthService(database as never);
    const owner=await auth.bootstrapOwner("owner@example.com","owner password is long enough","Owner workspace");
    const rawToken="a".repeat(43);
    await database.createInvitation(owner.workspaceId,"invitee@example.com","viewer",digest(rawToken),new Date(Date.now()+60000),owner.userId);

    const accepted=await api.inject({method:"POST",url:"/api/v1/auth/invitations/accept",payload:{token:rawToken,email:"invitee@example.com",password:"invitee password is long enough"}});
    expect(accepted.statusCode).toBe(201);
    const cookies=accepted.headers["set-cookie"] as string[];
    const sessionCookie=cookies.find(value=>value.startsWith("botroost_session="));
    const csrfCookie=cookies.find(value=>value.startsWith("botroost_csrf="));
    expect(sessionCookie).toBeDefined();
    expect(csrfCookie).toBeDefined();
    const session=sessionCookie!.split(";")[0]!;
    const csrf=csrfCookie!.split(";")[0]!.slice("botroost_csrf=".length);
    const mutation=await api.inject({method:"POST",url:"/api/v1/auth/workspace",headers:{cookie:`${session}; botroost_csrf=${csrf}`,origin:"https://app.test","x-csrf-token":csrf},payload:{workspaceId:owner.workspaceId}});
    expect(mutation.statusCode).toBe(204);
    await api.close();
  });

  it("exposes only the public registration flag and restricts policy updates to platform owners",async()=>{
    const database=new InMemoryDatabase();
    const api=buildApi({database:database as never,credentialKey:Buffer.alloc(32,1),publicOrigin:"https://app.test"});
    await api.ready();
    await database.updatePlatformSettings(true);
    const auth=new AuthService(database as never);
    const owner=await auth.bootstrapOwner("owner@example.com","owner password is long enough","Owner workspace");
    const ordinary=await auth.register("member@example.com","member password is long enough","Member workspace");
    await database.updatePlatformSettings(false);
    const ownerLogin=await auth.login("owner@example.com","owner password is long enough");
    const ordinaryLogin=await auth.login("member@example.com","member password is long enough");
    const ownerToken=ownerLogin.token, ordinaryToken=ordinaryLogin.token, csrf=ownerLogin.csrf;
    const ordinaryCsrf=ordinaryLogin.csrf;
    await database.createRegisteredSession(owner.userId,owner.workspaceId,digest(ownerToken),digest(csrf),new Date(Date.now()+60000));
    await database.createRegisteredSession(ordinary.userId,ordinary.workspaceId,digest(ordinaryToken),digest(ordinaryCsrf),new Date(Date.now()+60000));
    const policy=await api.inject({method:"GET",url:"/api/v1/platform/registration"});
    expect(policy.statusCode).toBe(200);
    expect(policy.json()).toEqual({registrationOpen:false});
    expect(JSON.stringify(policy.json())).not.toMatch(/password|token|secret/i);
    const ownerUpdate=await api.inject({method:"POST",url:"/api/v1/platform/registration",headers:{cookie:`botroost_session=${ownerToken}; botroost_csrf=${csrf}`,origin:"https://app.test","x-csrf-token":csrf},payload:{open:true}});
    expect(ownerUpdate.statusCode).toBe(200);
    expect(ownerUpdate.json()).toEqual({registrationOpen:true});
    const updatedPolicy=await api.inject({method:"GET",url:"/api/v1/platform/registration"});
    expect(updatedPolicy.statusCode).toBe(200);
    expect(updatedPolicy.json()).toEqual({registrationOpen:true});
    const ordinaryUpdate=await api.inject({method:"POST",url:"/api/v1/platform/registration",headers:{cookie:`botroost_session=${ordinaryToken}; botroost_csrf=${ordinaryCsrf}`,origin:"https://app.test","x-csrf-token":ordinaryCsrf},payload:{open:false}});
    expect(ordinaryUpdate.statusCode).toBe(403);
    const unauthenticatedUpdate=await api.inject({method:"POST",url:"/api/v1/platform/registration",headers:{origin:"https://app.test"},payload:{open:false}});
    expect(unauthenticatedUpdate.statusCode).toBe(401);
    const rejectedUpdates=[
      {name:"missing CSRF token",headers:{cookie:`botroost_session=${ownerToken}; botroost_csrf=${csrf}`,origin:"https://app.test"}},
      {name:"incorrect CSRF token",headers:{cookie:`botroost_session=${ownerToken}; botroost_csrf=${csrf}`,origin:"https://app.test","x-csrf-token":"wrong-token"}},
      {name:"wrong origin",headers:{cookie:`botroost_session=${ownerToken}; botroost_csrf=${csrf}`,origin:"https://attacker.test","x-csrf-token":csrf}},
    ];
    for(const rejected of rejectedUpdates){
      const response=await api.inject({method:"POST",url:"/api/v1/platform/registration",headers:rejected.headers,payload:{open:false}});
      expect(response.statusCode, rejected.name).toBe(403);
    }
    const malformedUpdate=await api.inject({method:"POST",url:"/api/v1/platform/registration",headers:{cookie:`botroost_session=${ownerToken}; botroost_csrf=${csrf}`,origin:"https://app.test","x-csrf-token":csrf},payload:{open:"false"}});
    expect(malformedUpdate.statusCode).toBe(400);
    const policyAfterRejections=await api.inject({method:"GET",url:"/api/v1/platform/registration"});
    expect(policyAfterRejections.statusCode).toBe(200);
    expect(policyAfterRejections.json()).toEqual({registrationOpen:true});
    await api.close();
  });
});
