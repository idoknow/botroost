import {describe,expect,it} from "vitest";
import {buildApi} from "../src/index.js";
import {AuthService} from "@botroost/auth";
import {InMemoryDatabase,digest} from "@botroost/database";

function csrf(cookie:string){return /botroost_csrf=([^;]+)/.exec(cookie)?.[1]??""}
function mutation(cookie:string){return{cookie,origin:"https://app.test","x-csrf-token":csrf(cookie)}}

/** Owner (platform owner, admin of Primary) plus a viewer, a non-owner admin of a second workspace, and a third empty workspace. */
async function fixture(){
  const database=new InMemoryDatabase();
  const api=buildApi({database:database as never,credentialKey:Buffer.alloc(32,1),publicOrigin:"https://app.test"});
  await api.ready();
  await database.updatePlatformSettings(true);
  const auth=new AuthService(database as never);
  const owner=await auth.bootstrapOwner("owner@example.com","owner password is long enough","Primary");
  const other=await auth.register("admin@example.com","admin password is long enough","Second");
  await database.updatePlatformSettings(false);

  const viewer={id:"viewer-user",email:"viewer@example.com"};
  database.users.push({id:viewer.id,email:viewer.email,password_hash:"unused"});
  database.members.push({workspace_id:owner.workspaceId,user_id:viewer.id,role:"viewer",workspace_role:"member"});

  const sessions:Record<string,string>={};
  for(const [name,userId,workspaceId] of [["owner",owner.userId,owner.workspaceId],["viewer",viewer.id,owner.workspaceId],["otherAdmin",other.userId,other.workspaceId]] as const){
    const token=`${name}-token`,csrfToken=`${name}-csrf`;
    await database.createRegisteredSession(userId,workspaceId,digest(token),digest(csrfToken),new Date(Date.now()+60_000));
    sessions[name]=`botroost_session=${token}; botroost_csrf=${csrfToken}`;
  }
  const third=await database.createWorkspaceForUser(owner.userId,"Third",owner.userId);
  return{database,api,owner,viewer,other,sessions,third};
}

describe("invitation administration",()=>{
  it("creates, lists, and revokes a workspace invitation for managers only",async()=>{
    const f=await fixture();

    const created=await f.api.inject({method:"POST",url:"/api/v1/workspaces/current/invitations",headers:mutation(f.sessions.owner!),payload:{email:"invitee@example.com",role:"viewer"}});
    expect(created.statusCode).toBe(201);
    const body=created.json() as {id:string;email:string;acceptUrl:string};
    expect(body.email).toBe("invitee@example.com");
    expect(body.acceptUrl).toMatch(/^https:\/\/app\.test\/login\?invite=/);
    expect(JSON.stringify(created.json())).not.toMatch(/token_hash|password/i);

    expect((await f.api.inject({method:"GET",url:"/api/v1/workspaces/current/invitations",headers:{cookie:f.sessions.viewer!}})).statusCode).toBe(403);
    expect((await f.api.inject({method:"POST",url:"/api/v1/workspaces/current/invitations",headers:mutation(f.sessions.viewer!),payload:{email:"invitee@example.com",role:"viewer"}})).statusCode).toBe(403);
    expect((await f.api.inject({method:"POST",url:"/api/v1/workspaces/current/invitations",headers:mutation(f.sessions.otherAdmin!),payload:{email:"invitee@example.com",role:"viewer"}})).statusCode).toBe(201);

    const listed=await f.api.inject({method:"GET",url:"/api/v1/workspaces/current/invitations",headers:{cookie:f.sessions.owner!}});
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({total:1,items:[{email:"invitee@example.com",role:"viewer",acceptedAt:null,revokedAt:null}]});
    expect(JSON.stringify(listed.json())).not.toMatch(/token_hash|acceptUrl/);

    expect((await f.api.inject({method:"DELETE",url:`/api/v1/workspaces/current/invitations/${body.id}`,headers:mutation(f.sessions.owner!)})).statusCode).toBe(204);
    expect((await f.api.inject({method:"GET",url:"/api/v1/workspaces/current/invitations",headers:{cookie:f.sessions.owner!}})).json()).toMatchObject({items:[{revokedAt:expect.any(String)}]});
    await f.api.close();
  });

  it("requires csrf for invitation mutations and refuses to revoke another workspace's invitation",async()=>{
    const f=await fixture();
    const created=await f.api.inject({method:"POST",url:"/api/v1/workspaces/current/invitations",headers:mutation(f.sessions.owner!),payload:{email:"invitee@example.com",role:"viewer"}});
    const id=(created.json() as {id:string}).id;
    const invitation=f.database.invitations.find(item=>item.id===id)!;

    expect((await f.api.inject({method:"POST",url:"/api/v1/workspaces/current/invitations",headers:{cookie:f.sessions.owner!,origin:"https://app.test"},payload:{email:"other@example.com",role:"viewer"}})).statusCode).toBe(403);
    expect((await f.api.inject({method:"POST",url:"/api/v1/workspaces/current/invitations",headers:{cookie:f.sessions.owner!,origin:"https://evil.test","x-csrf-token":csrf(f.sessions.owner!)},payload:{email:"other@example.com",role:"viewer"}})).statusCode).toBe(403);

    expect((await f.api.inject({method:"DELETE",url:`/api/v1/workspaces/current/invitations/${id}`,headers:mutation(f.sessions.otherAdmin!)})).statusCode).toBe(404);
    expect(invitation.revoked_at).toBeNull();
    expect(f.database.invitations).toHaveLength(1);
    await f.api.close();
  });
});

describe("platform administration",()=>{
  it("restricts platform workspace administration to platform owners",async()=>{
    const f=await fixture();

    for(const request of [
      {method:"GET" as const,url:"/api/v1/platform/workspaces"},
      {method:"GET" as const,url:"/api/v1/platform/nodes"},
    ]){
      expect((await f.api.inject({...request,headers:{cookie:f.sessions.viewer!}})).statusCode).toBe(403);
      expect((await f.api.inject({...request,headers:{cookie:f.sessions.otherAdmin!}})).statusCode).toBe(403);
      expect((await f.api.inject({...request,headers:{cookie:f.sessions.owner!}})).statusCode).toBe(200);
    }

    expect((await f.api.inject({method:"GET",url:"/api/v1/platform/workspaces",headers:{cookie:f.sessions.owner!}})).json()).toMatchObject({workspaces:[{name:"Primary"},{name:"Second"},{name:"Third"}]});
    expect((await f.api.inject({method:"POST",url:"/api/v1/workspaces",headers:mutation(f.sessions.otherAdmin!),payload:{name:"Nope"}})).statusCode).toBe(403);

    const created=await f.api.inject({method:"POST",url:"/api/v1/workspaces",headers:mutation(f.sessions.owner!),payload:{name:"Additional"}});
    expect(created.statusCode).toBe(201);
    const workspace=created.json() as {id:string;name:string};
    expect(workspace.name).toBe("Additional");

    expect((await f.api.inject({method:"PATCH",url:`/api/v1/platform/workspaces/${workspace.id}`,headers:{...mutation(f.sessions.owner!),cookie:f.sessions.viewer!}})).statusCode).toBe(403);
    expect((await f.api.inject({method:"PATCH",url:`/api/v1/platform/workspaces/${workspace.id}`,headers:mutation(f.sessions.owner!),payload:{name:"Renamed"}})).json()).toMatchObject({id:workspace.id,name:"Renamed"});

    expect((await f.api.inject({method:"DELETE",url:`/api/v1/platform/workspaces/${f.owner.workspaceId}`,headers:mutation(f.sessions.owner!)})).statusCode).toBe(409);
    expect((await f.api.inject({method:"DELETE",url:`/api/v1/platform/workspaces/${workspace.id}`,headers:{...mutation(f.sessions.owner!),cookie:f.sessions.viewer!}})).statusCode).toBe(403);
    expect((await f.api.inject({method:"DELETE",url:`/api/v1/platform/workspaces/${workspace.id}`,headers:mutation(f.sessions.owner!)})).statusCode).toBe(204);
    expect((await f.api.inject({method:"GET",url:"/api/v1/platform/workspaces",headers:{cookie:f.sessions.owner!}})).json()).toMatchObject({workspaces:[{name:"Primary"},{name:"Second"},{name:"Third"}]});
    await f.api.close();
  });

  it("publishes and grants shared pool nodes to a workspace",async()=>{
    const f=await fixture();
    const node=f.database.createNode(f.owner.workspaceId,"node-a","fake");

    expect((await f.api.inject({method:"PUT",url:`/api/v1/platform/nodes/${node.id}/shared`,headers:mutation(f.sessions.viewer!),payload:{enabled:true}})).statusCode).toBe(403);

    const shared=await f.api.inject({method:"PUT",url:`/api/v1/platform/nodes/${node.id}/shared`,headers:mutation(f.sessions.owner!),payload:{enabled:true,labels:{region:"eu"}}});
    expect(shared.statusCode).toBe(200);
    expect(shared.json()).toMatchObject({nodeId:node.id,enabled:true,labels:{region:"eu"}});

    expect((await f.api.inject({method:"GET",url:"/api/v1/platform/nodes",headers:{cookie:f.sessions.owner!}})).json()).toMatchObject({nodes:[{id:node.id,enabled:true,grantedWorkspaceIds:[]}]});
    expect((await f.api.inject({method:"GET",url:"/api/v1/workspaces/current/nodes/shared",headers:{cookie:f.sessions.otherAdmin!}})).json()).toEqual({nodes:[]});

    expect((await f.api.inject({method:"PUT",url:`/api/v1/platform/workspaces/${f.other.workspaceId}/nodes/${node.id}`,headers:mutation(f.sessions.viewer!)})).statusCode).toBe(403);
    expect((await f.api.inject({method:"PUT",url:`/api/v1/platform/workspaces/${f.other.workspaceId}/nodes/${node.id}`,headers:mutation(f.sessions.owner!)})).statusCode).toBe(204);
    expect((await f.api.inject({method:"GET",url:"/api/v1/workspaces/current/nodes/shared",headers:{cookie:f.sessions.otherAdmin!}})).json()).toMatchObject({nodes:[{id:node.id,name:"node-a",provider:"fake",labels:{region:"eu"}}]});
    expect((await f.api.inject({method:"PUT",url:`/api/v1/platform/workspaces/${f.other.workspaceId}/nodes/${node.id}`,headers:mutation(f.sessions.owner!)})).statusCode).toBe(204);
    expect((await f.api.inject({method:"GET",url:"/api/v1/platform/nodes",headers:{cookie:f.sessions.owner!}})).json()).toMatchObject({nodes:[{grantedWorkspaceIds:[f.other.workspaceId]}]});

    expect((await f.api.inject({method:"DELETE",url:`/api/v1/platform/workspaces/${f.other.workspaceId}/nodes/${node.id}`,headers:mutation(f.sessions.owner!)})).statusCode).toBe(204);
    expect((await f.api.inject({method:"GET",url:"/api/v1/workspaces/current/nodes/shared",headers:{cookie:f.sessions.otherAdmin!}})).json()).toEqual({nodes:[]});

    expect((await f.api.inject({method:"PUT",url:`/api/v1/platform/nodes/${node.id}/shared`,headers:mutation(f.sessions.owner!),payload:{enabled:false,labels:{}}})).statusCode).toBe(200);
    expect((await f.api.inject({method:"GET",url:"/api/v1/platform/nodes",headers:{cookie:f.sessions.owner!}})).json()).toMatchObject({nodes:[{id:node.id,enabled:false,grantedWorkspaceIds:[]}]});
    expect((await f.api.inject({method:"PUT",url:`/api/v1/platform/workspaces/${f.other.workspaceId}/nodes/${node.id}`,headers:mutation(f.sessions.owner!)})).statusCode).toBe(409);
    await f.api.close();
  });

  it("reports platform ownership on the session contract",async()=>{
    const f=await fixture();
    expect((await f.api.inject({method:"GET",url:"/api/v1/auth/session",headers:{cookie:f.sessions.owner!}})).json()).toMatchObject({platformOwner:true,workspace:{name:"Primary"}});
    expect((await f.api.inject({method:"GET",url:"/api/v1/auth/session",headers:{cookie:f.sessions.otherAdmin!}})).json()).toMatchObject({platformOwner:false,workspace:{name:"Second"}});
    await f.api.close();
  });
});
