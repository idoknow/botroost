import {describe,expect,it} from "vitest";
import {buildApi} from "../src/index.js";
import {AuthService} from "@botroost/auth";
import {InMemoryDatabase,digest} from "@botroost/database";

function csrf(cookie:string){return /botroost_csrf=([^;]+)/.exec(cookie)?.[1]??""}
function mutation(cookie:string){return{cookie,origin:"https://app.test","x-csrf-token":csrf(cookie)}}

async function fixture(){
  const database=new InMemoryDatabase();
  const api=buildApi({database:database as never,credentialKey:Buffer.alloc(32,1),publicOrigin:"https://app.test"});
  await api.ready();
  await database.updatePlatformSettings(true);
  const auth=new AuthService(database as never);
  const owner=await auth.bootstrapOwner("owner@example.com","owner password is long enough","Primary");
  const member=await auth.register("member@example.com","member password is long enough","Second");
  const sessions:Record<string,string>={};
  for(const [name,userId,workspaceId] of [["owner",owner.userId,owner.workspaceId],["member",member.userId,member.workspaceId]] as const){
    const token=`${name}-token`,csrfToken=`${name}-csrf`;
    await database.createRegisteredSession(userId,workspaceId,digest(token),digest(csrfToken),new Date(Date.now()+60_000));
    sessions[name]=`botroost_session=${token}; botroost_csrf=${csrfToken}`;
  }
  return{database,api,owner,member,sessions};
}

describe("platform quota administration",()=>{
  it("lets a platform owner read and update workspace, endpoint, and grace-period quotas",async()=>{
    const f=await fixture();
    expect((await f.api.inject({method:"GET",url:"/api/v1/platform/settings",headers:{cookie:f.sessions.member!}})).statusCode).toBe(403);

    const initial=await f.api.inject({method:"GET",url:"/api/v1/platform/settings",headers:{cookie:f.sessions.owner!}});
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({registrationOpen:true,maxWorkspacesPerUser:expect.any(Number),maxEndpointsPerWorkspace:expect.any(Number),endpointExpiryGraceHours:expect.any(Number)});

    const updated=await f.api.inject({method:"PATCH",url:"/api/v1/platform/settings",headers:mutation(f.sessions.owner!),payload:{maxWorkspacesPerUser:2,maxEndpointsPerWorkspace:3,endpointExpiryGraceHours:6}});
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({maxWorkspacesPerUser:2,maxEndpointsPerWorkspace:3,endpointExpiryGraceHours:6});

    // Quotas are enforced at the database boundary, not only in the UI.
    expect((await f.api.inject({method:"POST",url:"/api/v1/workspaces",headers:mutation(f.sessions.member!),payload:{name:"Extra"}})).statusCode).toBe(201);
    expect((await f.api.inject({method:"POST",url:"/api/v1/workspaces",headers:mutation(f.sessions.member!),payload:{name:"Too many"}})).statusCode).toBe(403);

    expect((await f.api.inject({method:"POST",url:"/api/v1/endpoints",headers:mutation(f.sessions.member!),payload:{name:"ep-1",providerId:"fake"}})).statusCode).toBe(201);
    expect((await f.api.inject({method:"POST",url:"/api/v1/endpoints",headers:mutation(f.sessions.member!),payload:{name:"ep-2",providerId:"fake"}})).statusCode).toBe(201);
    expect((await f.api.inject({method:"POST",url:"/api/v1/endpoints",headers:mutation(f.sessions.member!),payload:{name:"ep-3",providerId:"fake"}})).statusCode).toBe(201);
    expect((await f.api.inject({method:"POST",url:"/api/v1/endpoints",headers:mutation(f.sessions.member!),payload:{name:"ep-4",providerId:"fake"}})).statusCode).toBe(403);

    // A per-user override beats the platform default.
    expect((await f.api.inject({method:"PATCH",url:`/api/v1/platform/users/${f.member.userId}`,headers:mutation(f.sessions.owner!),payload:{maxEndpointsPerWorkspace:4}})).statusCode).toBe(200);
    expect((await f.api.inject({method:"POST",url:"/api/v1/endpoints",headers:mutation(f.sessions.member!),payload:{name:"ep-4",providerId:"fake"}})).statusCode).toBe(201);
    expect((await f.api.inject({method:"POST",url:"/api/v1/endpoints",headers:mutation(f.sessions.member!),payload:{name:"ep-5",providerId:"fake"}})).statusCode).toBe(403);
    await f.api.close();
  });

  it("lets a platform owner administer every user and endpoint",async()=>{
    const f=await fixture();
    expect((await f.api.inject({method:"GET",url:"/api/v1/platform/users",headers:{cookie:f.sessions.member!}})).statusCode).toBe(403);

    const users=await f.api.inject({method:"GET",url:"/api/v1/platform/users",headers:{cookie:f.sessions.owner!}});
    expect(users.statusCode).toBe(200);
    expect((users.json() as {users:{email:string}[]}).users.map(user=>user.email).sort()).toEqual(["member@example.com","owner@example.com"]);

    expect((await f.api.inject({method:"PATCH",url:`/api/v1/platform/users/${f.owner.userId}`,headers:mutation(f.sessions.owner!),payload:{disabled:true}})).statusCode).toBe(409);
    expect((await f.api.inject({method:"PATCH",url:`/api/v1/platform/users/${f.member.userId}`,headers:mutation(f.sessions.owner!),payload:{disabled:true}})).json()).toMatchObject({disabledAt:expect.any(String)});
    expect((await f.api.inject({method:"GET",url:"/api/v1/auth/me",headers:{cookie:f.sessions.member!}})).statusCode).toBe(401);
    expect((await f.api.inject({method:"PATCH",url:`/api/v1/platform/users/${f.member.userId}`,headers:mutation(f.sessions.owner!),payload:{disabled:false}})).json()).toMatchObject({disabledAt:null});

    const endpoint=(await f.api.inject({method:"POST",url:"/api/v1/endpoints",headers:mutation(f.sessions.owner!),payload:{name:"owned",providerId:"fake"}})).json() as {id:string;generation:number};
    const listed=await f.api.inject({method:"GET",url:"/api/v1/platform/endpoints",headers:{cookie:f.sessions.owner!}});
    expect((listed.json() as {endpoints:{id:string;workspaceName:string|null}[]}).endpoints).toMatchObject([{id:endpoint.id,workspaceName:"Primary"}]);

    // Platform deletion is a real runtime removal: it queues the same delete operation a workspace user
    // would queue, so the agent removes the container, and the row only disappears once that converges.
    const deletion=await f.api.inject({method:"DELETE",url:`/api/v1/platform/endpoints/${endpoint.id}`,headers:{...mutation(f.sessions.owner!),"idempotency-key":"platform-delete-1"}});
    expect(deletion.statusCode).toBe(202);
    expect(deletion.json()).toMatchObject({action:"delete",status:"queued",endpointId:endpoint.id});
    // The row survives until the operation converges, so a queued delete never orphans a live container.
    expect(await f.database.endpoint(f.owner.workspaceId,endpoint.id)).not.toBeNull();
    expect((await f.api.inject({method:"GET",url:`/api/v1/endpoints/${endpoint.id}`,headers:{cookie:f.sessions.owner!}})).statusCode).toBe(200);
    await f.api.close();
  });

  it("sets a workspace expiry so the worker can stop and then delete its endpoints",async()=>{
    const f=await fixture();
    const workspace=(await f.api.inject({method:"POST",url:"/api/v1/workspaces",headers:mutation(f.sessions.member!),payload:{name:"Expiring"}})).json() as {id:string};

    expect((await f.api.inject({method:"PUT",url:`/api/v1/platform/workspaces/${workspace.id}/expiry`,headers:mutation(f.sessions.member!),payload:{expiresAt:new Date().toISOString()}})).statusCode).toBe(403);
    const expiresAt=new Date(Date.now()-60_000).toISOString();
    expect((await f.api.inject({method:"PUT",url:`/api/v1/platform/workspaces/${workspace.id}/expiry`,headers:mutation(f.sessions.owner!),payload:{expiresAt}})).json()).toMatchObject({id:workspace.id,expiresAt});

    await f.api.inject({method:"POST",url:"/api/v1/auth/workspace",headers:mutation(f.sessions.member!),payload:{workspaceId:workspace.id}});
    const endpoint=(await f.api.inject({method:"POST",url:"/api/v1/endpoints",headers:mutation(f.sessions.member!),payload:{name:"expiring-ep",providerId:"fake"}})).json() as {id:string};
    // Expiry enqueues the stop the agent actually executes; the row stays until the runtime converges.
    expect(await f.database.processExpiredWorkspaces()).toMatchObject({stopped:1,deleted:0});
    expect((await f.api.inject({method:"GET",url:`/api/v1/endpoints/${endpoint.id}`,headers:{cookie:f.sessions.member!}})).json()).toMatchObject({desired:{state:"stopped"}});
    expect(f.database.operations).toMatchObject([{endpointId:endpoint.id,action:"stop",status:"queued"}]);

    await f.database.updatePlatformSettings({endpointExpiryGraceHours:0});
    // After the grace period the delete is queued for the agent; the row is still present, not orphaned.
    expect(await f.database.processExpiredWorkspaces()).toMatchObject({deleted:1});
    expect(await f.database.endpoint(workspace.id,endpoint.id)).not.toBeNull();
    expect(f.database.operations.some(operation=>operation.action==="delete")).toBe(true);

    const listed=(await f.api.inject({method:"GET",url:"/api/v1/platform/workspaces",headers:{cookie:f.sessions.owner!}})).json() as {workspaces:{id:string;expiresAt:string|null}[]};
    expect(listed.workspaces.find(item=>item.id===workspace.id)).toMatchObject({expiresAt});
    expect((await f.api.inject({method:"PUT",url:`/api/v1/platform/workspaces/${workspace.id}/expiry`,headers:mutation(f.sessions.owner!),payload:{expiresAt:null}})).json()).toMatchObject({expiresAt:null});
    await f.api.close();
  });
});

describe("node registration name and remark",()=>{
  it("edits the registration name and remark as independent fields",async()=>{
    const f=await fixture();
    const node=(await f.api.inject({method:"POST",url:"/api/v1/nodes",headers:mutation(f.sessions.owner!),payload:{name:"agent-a",provider:"fake"}})).json() as {id:string};

    expect((await f.api.inject({method:"PATCH",url:`/api/v1/nodes/${node.id}`,headers:{cookie:f.sessions.owner!},payload:{remark:"note"}})).statusCode).toBe(403);
    const renamed=await f.api.inject({method:"PATCH",url:`/api/v1/nodes/${node.id}`,headers:mutation(f.sessions.owner!),payload:{name:"agent-b"}});
    expect(renamed.json()).toMatchObject({name:"agent-b",remark:null});

    expect((await f.api.inject({method:"PATCH",url:`/api/v1/nodes/${node.id}`,headers:mutation(f.sessions.owner!),payload:{remark:"校本部机房"}})).json()).toMatchObject({name:"agent-b",remark:"校本部机房"});
    expect((await f.api.inject({method:"PATCH",url:`/api/v1/nodes/${node.id}`,headers:mutation(f.sessions.owner!),payload:{remark:null}})).json()).toMatchObject({name:"agent-b",remark:null});
    expect((await f.api.inject({method:"PATCH",url:`/api/v1/nodes/${node.id}`,headers:mutation(f.sessions.owner!),payload:{}})).statusCode).toBe(400);
    expect((await f.api.inject({method:"GET",url:`/api/v1/nodes/${node.id}`,headers:{cookie:f.sessions.owner!}})).json()).toMatchObject({name:"agent-b"});

    // A member of another workspace gets no view of the node (404, never a cross-tenant write).
    expect((await f.api.inject({method:"PATCH",url:`/api/v1/nodes/${node.id}`,headers:mutation(f.sessions.member!),payload:{remark:"hijack"}})).statusCode).toBe(404);
    await f.api.close();
  });

  it("lets a platform owner rename and annotate any node, and rejects an empty body",async()=>{
    const f=await fixture();
    const node=(await f.api.inject({method:"POST",url:"/api/v1/nodes",headers:mutation(f.sessions.owner!),payload:{name:"agent-a",provider:"fake"}})).json() as {id:string};

    expect((await f.api.inject({method:"PATCH",url:`/api/v1/platform/nodes/${node.id}`,headers:{cookie:f.sessions.member!},payload:{remark:"nope"}})).statusCode).toBe(403);
    expect((await f.api.inject({method:"PATCH",url:`/api/v1/platform/nodes/${node.id}`,headers:mutation(f.sessions.owner!),payload:{}})).statusCode).toBe(400);

    const renamed=await f.api.inject({method:"PATCH",url:`/api/v1/platform/nodes/${node.id}`,headers:mutation(f.sessions.owner!),payload:{name:"agent-b"}});
    expect(renamed.json()).toMatchObject({id:node.id,name:"agent-b",remark:null});
    expect((await f.api.inject({method:"PATCH",url:`/api/v1/platform/nodes/${node.id}`,headers:mutation(f.sessions.owner!),payload:{remark:"校本部机房"}})).json()).toMatchObject({name:"agent-b",remark:"校本部机房"});
    // The remark is nullable so an owner can clear it without touching the registration name.
    expect((await f.api.inject({method:"PATCH",url:`/api/v1/platform/nodes/${node.id}`,headers:mutation(f.sessions.owner!),payload:{remark:null}})).json()).toMatchObject({name:"agent-b",remark:null});

    const listed=(await f.api.inject({method:"GET",url:"/api/v1/platform/nodes",headers:{cookie:f.sessions.owner!}})).json() as {nodes:{id:string;name:string;remark:string|null}[]};
    expect(listed.nodes.find(item=>item.id===node.id)).toMatchObject({name:"agent-b",remark:null});
    await f.api.close();
  });

  it("keeps the platform node listing usable without a shared pool entry",async()=>{
    const f=await fixture();
    const node=(await f.api.inject({method:"POST",url:"/api/v1/nodes",headers:mutation(f.sessions.owner!),payload:{name:"pool-node",provider:"fake"}})).json() as {id:string};
    await f.database.updateNode(f.owner.workspaceId,node.id,{remark:"pool remark"});
    const listed=(await f.api.inject({method:"GET",url:"/api/v1/platform/nodes",headers:{cookie:f.sessions.owner!}})).json();
    expect(JSON.stringify(listed)).toContain("pool remark");
    await f.api.close();
  });
});
