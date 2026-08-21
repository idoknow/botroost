import{afterAll,beforeAll,describe,expect,it}from'vitest';
import{execFileSync}from'node:child_process';
import{randomUUID}from'node:crypto';
import{PostgresDatabase}from'@botroost/database';
import{AuthService}from'@botroost/auth';
import{buildApi}from'../src/index.js';

const container=`botroost-members-${process.pid}-${Date.now()}`;
let db:PostgresDatabase;
let api:ReturnType<typeof buildApi>;

function cookies(headers:string|string[]|undefined){const lines=Array.isArray(headers)?headers:[headers??''];return lines.map(value=>value.split(';')[0]).join('; ')}
function csrf(cookie:string){return /botroost_csrf=([^;]+)/.exec(cookie)?.[1]??''}
function mutation(cookie:string){return{cookie,origin:'https://app.test',host:'app.test','x-csrf-token':csrf(cookie)}}
async function login(email:string,password:string){const response=await api.inject({method:'POST',url:'/api/v1/auth/login',payload:{email,password}});return{response,cookie:cookies(response.headers['set-cookie'])}}

beforeAll(async()=>{
  execFileSync('docker',['run','-d','--name',container,'-e','POSTGRES_PASSWORD=postgres','-e','POSTGRES_DB=botroost','-p','127.0.0.1::5432','postgres:16-alpine']);
  for(let attempt=0;attempt<60;attempt++){try{execFileSync('docker',['exec',container,'pg_isready','-U','postgres'],{stdio:'ignore'});break}catch{await new Promise(resolve=>setTimeout(resolve,250))}}
  const mapping=execFileSync('docker',['port',container,'5432/tcp']).toString().trim();
  const port=/:(\d+)$/.exec(mapping)?.[1];
  if(!port)throw new Error(`unable to determine PostgreSQL port from ${mapping}`);
  db=new PostgresDatabase(`postgresql://postgres:postgres@127.0.0.1:${port}/botroost`);
  for(let attempt=0;attempt<60;attempt++){try{await db.ping();break}catch{await new Promise(resolve=>setTimeout(resolve,250))}}
  await db.migrate();
  await new AuthService(db).bootstrapOwner('owner@example.com','correct horse battery staple','Primary');
  api=buildApi({database:db,credentialKey:Buffer.alloc(32,7),publicOrigin:'https://app.test'});
  await api.ready();
},120_000);

afterAll(async()=>{await api?.close();await db?.close();try{execFileSync('docker',['rm','-f',container],{stdio:'ignore'})}catch(error){console.warn('failed to remove PostgreSQL test container',error)}},30_000);

describe('workspace member administration and account passwords',()=>{
  it('creates, edits, changes role, and deletes a member with tenant and owner safeguards',async()=>{
    const ownerLogin=await login('owner@example.com','correct horse battery staple');
    const owner=ownerLogin.cookie;
    const ownerSession=(await api.inject({method:'GET',url:'/api/v1/auth/session',headers:{cookie:owner}})).json();

    const created=await api.inject({method:'POST',url:'/api/v1/workspaces/current/members',headers:mutation(owner),payload:{email:'member@example.com',password:'initial member password',role:'viewer'}});
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({email:'member@example.com',role:'viewer'});
    const memberId=created.json().id as string;
    expect((await login('member@example.com','initial member password')).response.statusCode).toBe(200);
    const secondWorkspace=randomUUID();
    await db.pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Second workspace')",[secondWorkspace]);
    await db.pool.query("INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[secondWorkspace,memberId]);
    expect((await api.inject({method:'PATCH',url:`/api/v1/workspaces/current/members/${memberId}`,headers:mutation(owner),payload:{email:'cross-tenant-change@example.com'}})).statusCode).toBe(409);
    await db.pool.query("DELETE FROM members WHERE workspace_id=$1 AND user_id=$2",[secondWorkspace,memberId]);
    await db.pool.query("DELETE FROM workspaces WHERE id=$1",[secondWorkspace]);
    expect((await api.inject({method:'POST',url:'/api/v1/workspaces/current/members',headers:mutation(owner),payload:{email:'member@example.com',password:'another member password',role:'operator'}})).statusCode).toBe(409);

    const updated=await api.inject({method:'PATCH',url:`/api/v1/workspaces/current/members/${memberId}`,headers:mutation(owner),payload:{email:'renamed@example.com',role:'operator'}});
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({id:memberId,email:'renamed@example.com',role:'operator'});
    expect((await login('member@example.com','initial member password')).response.statusCode).toBe(401);
    const renamedLogin=await login('renamed@example.com','initial member password');
    expect(renamedLogin.response.statusCode).toBe(200);

    const adminCreated=await api.inject({method:'POST',url:'/api/v1/workspaces/current/members',headers:mutation(owner),payload:{email:'admin@example.com',password:'initial admin password',role:'admin'}});
    const adminId=adminCreated.json().id as string;
    const admin=(await login('admin@example.com','initial admin password')).cookie;
    expect((await api.inject({method:'PATCH',url:`/api/v1/workspaces/current/members/${ownerSession.user.id}`,headers:mutation(admin),payload:{role:'viewer'}})).statusCode).toBe(403);
    expect((await api.inject({method:'DELETE',url:`/api/v1/workspaces/current/members/${ownerSession.user.id}`,headers:mutation(admin)})).statusCode).toBe(403);
    expect((await api.inject({method:'PATCH',url:`/api/v1/workspaces/current/members/${adminId}`,headers:mutation(admin),payload:{role:'viewer'}})).statusCode).toBe(409);
    expect((await api.inject({method:'PATCH',url:'/api/v1/workspaces/current/members/00000000-0000-4000-8000-000000000000',headers:mutation(owner),payload:{role:'viewer'}})).statusCode).toBe(404);

    await db.pool.query("INSERT INTO audit_events(id,workspace_id,actor_user_id,action,resource_type,resource_id) VALUES(gen_random_uuid(),$1,$2,'member.activity','member',$2)",[ownerSession.workspace.id,memberId]);
    expect((await api.inject({method:'DELETE',url:`/api/v1/workspaces/current/members/${memberId}`,headers:mutation(owner)})).statusCode).toBe(204);
    expect((await api.inject({method:'GET',url:'/api/v1/auth/session',headers:{cookie:renamedLogin.cookie}})).statusCode).toBe(401);
    expect((await login('renamed@example.com','initial member password')).response.statusCode).toBe(401);
    const reactivated=await api.inject({method:'POST',url:'/api/v1/workspaces/current/members',headers:mutation(owner),payload:{email:'renamed@example.com',password:'reactivated member password',role:'viewer'}});
    expect(reactivated.statusCode).toBe(201);
    expect(reactivated.json().id).toBe(memberId);
    expect((await login('renamed@example.com','reactivated member password')).response.statusCode).toBe(200);

    const actions=(await api.inject({method:'GET',url:'/api/v1/audit',headers:{cookie:owner}})).json().items.map((event:{action:string})=>event.action);
    expect(actions).toEqual(expect.arrayContaining(['member.created','member.updated','member.deleted']));
  });

  it('lets every account change its own password while revoking other sessions',async()=>{
    const first=await login('owner@example.com','correct horse battery staple');
    const second=await login('owner@example.com','correct horse battery staple');
    expect((await api.inject({method:'PUT',url:'/api/v1/auth/password',headers:mutation(first.cookie),payload:{currentPassword:'wrong current password',newPassword:'new secure owner password'}})).statusCode).toBe(403);
    expect((await api.inject({method:'PUT',url:'/api/v1/auth/password',headers:mutation(first.cookie),payload:{currentPassword:'correct horse battery staple',newPassword:'new secure owner password'}})).statusCode).toBe(204);
    expect((await api.inject({method:'GET',url:'/api/v1/auth/session',headers:{cookie:first.cookie}})).statusCode).toBe(200);
    expect((await api.inject({method:'GET',url:'/api/v1/auth/session',headers:{cookie:second.cookie}})).statusCode).toBe(401);
    expect((await login('owner@example.com','correct horse battery staple')).response.statusCode).toBe(401);
    expect((await login('owner@example.com','new secure owner password')).response.statusCode).toBe(200);
    const actions=(await api.inject({method:'GET',url:'/api/v1/audit',headers:{cookie:first.cookie}})).json().items.map((event:{action:string})=>event.action);
    expect(actions).toContain('account.password_changed');
  });

  it('serializes concurrent final membership removals and leaves the account reusable',async()=>{
    const ownerLogin=await login('owner@example.com','new secure owner password'),ownerSession=(await api.inject({method:'GET',url:'/api/v1/auth/session',headers:{cookie:ownerLogin.cookie}})).json();
    const created=await api.inject({method:'POST',url:'/api/v1/workspaces/current/members',headers:mutation(ownerLogin.cookie),payload:{email:'remove-race@example.com',password:'removal race password',role:'viewer'}}),userId=created.json().id as string,secondWorkspace=randomUUID();
    expect(created.statusCode).toBe(201);
    await db.pool.query("INSERT INTO workspaces(id,name) VALUES($1,'Removal race')",[secondWorkspace]);
    await db.pool.query("INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[secondWorkspace,userId]);
    await Promise.all([
      db.deleteMember(ownerSession.workspace.id,userId,{userId:ownerSession.user.id,role:'owner'}),
      db.deleteMember(secondWorkspace,userId,{userId:ownerSession.user.id,role:'owner'})
    ]);
    const state=(await db.pool.query("SELECT disabled_at,(SELECT count(*)::int FROM members WHERE user_id=$1) memberships FROM users WHERE id=$1",[userId])).rows[0];
    expect(state.disabled_at).not.toBeNull();
    expect(state.memberships).toBe(0);
    const reactivated=await api.inject({method:'POST',url:'/api/v1/workspaces/current/members',headers:mutation(ownerLogin.cookie),payload:{email:'remove-race@example.com',password:'reactivated race password',role:'viewer'}});
    expect(reactivated.statusCode).toBe(201);
    expect(reactivated.json().id).toBe(userId);
    expect((await api.inject({method:'DELETE',url:`/api/v1/workspaces/current/members/${userId}`,headers:mutation(ownerLogin.cookie)})).statusCode).toBe(204);
    await db.pool.query('DELETE FROM workspaces WHERE id=$1',[secondWorkspace]);
  });

  it('uses a deterministic actor-target lock order for mutual admin removals',async()=>{
    const owner=(await login('owner@example.com','new secure owner password')).cookie;
    const [first,second]=await Promise.all([
      api.inject({method:'POST',url:'/api/v1/workspaces/current/members',headers:mutation(owner),payload:{email:'admin-a@example.com',password:'admin a initial password',role:'admin'}}),
      api.inject({method:'POST',url:'/api/v1/workspaces/current/members',headers:mutation(owner),payload:{email:'admin-b@example.com',password:'admin b initial password',role:'admin'}})
    ]);
    expect([first.statusCode,second.statusCode]).toEqual([201,201]);
    const ownerSession=(await api.inject({method:'GET',url:'/api/v1/auth/session',headers:{cookie:owner}})).json(),firstId=first.json().id as string,secondId=second.json().id as string;
    await Promise.all([
      db.deleteMember(ownerSession.workspace.id,secondId,{userId:firstId,role:'admin'}),
      db.deleteMember(ownerSession.workspace.id,firstId,{userId:secondId,role:'admin'})
    ]);
    const states=(await db.pool.query("SELECT id,disabled_at,(SELECT count(*)::int FROM members WHERE user_id=users.id) memberships FROM users WHERE id=ANY($1::uuid[]) ORDER BY id",[[firstId,secondId]])).rows;
    expect(states).toHaveLength(2);
    expect(states.every(row=>row.disabled_at&&row.memberships===0)).toBe(true);
  });

  it('creates only one account when the same email is added concurrently',async()=>{
    const owner=(await login('owner@example.com','new secure owner password')).cookie;
    const request=()=>api.inject({method:'POST',url:'/api/v1/workspaces/current/members',headers:mutation(owner),payload:{email:' concurrent@example.com ',password:'concurrent initial password',role:'viewer'}});
    const responses=await Promise.all([request(),request()]);
    expect(responses.map(response=>response.statusCode).sort()).toEqual([201,409]);
    const winner=responses.find(response=>response.statusCode===201)!;
    expect(winner.json()).not.toHaveProperty('password');
    expect((await login('concurrent@example.com','concurrent initial password')).response.statusCode).toBe(200);
    expect((await api.inject({method:'DELETE',url:`/api/v1/workspaces/current/members/${winner.json().id}`,headers:mutation(owner)})).statusCode).toBe(204);
  });
});
