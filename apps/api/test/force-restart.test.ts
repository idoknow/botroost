import {waitForPostgres} from "../../../packages/database/test/postgres.js";
import {afterAll,beforeAll,describe,expect,it}from "vitest";
import {execFileSync}from "node:child_process";
import {AuthService}from "@botroost/auth";
import {PostgresDatabase}from "@botroost/database";
import {buildApi}from "../src/index.js";
import {DurableWorker}from "@botroost/worker";
const name=`botroost-force-api-${process.pid}-${Date.now()}`;let db:PostgresDatabase,api:ReturnType<typeof buildApi>,auth:AuthService;
function cookies(headers:string|string[]|undefined){const lines=Array.isArray(headers)?headers:[headers??""];return lines.map(x=>x.split(";")[0]).join("; ")}
function csrf(cookie:string){return /botroost_csrf=([^;]+)/.exec(cookie)?.[1]??""}
function mutation(cookie:string){return{cookie,origin:"https://app.test",host:"app.test","x-csrf-token":csrf(cookie)}}
beforeAll(async()=>{execFileSync("docker",["run","-d","--name",name,"-e","POSTGRES_PASSWORD=postgres","-e","POSTGRES_DB=botroost","-p","127.0.0.1::5432","postgres:16-alpine"]);await waitForPostgres(name);const mapping=execFileSync("docker",["port",name,"5432/tcp"]).toString().trim();const port=/:(\d+)$/.exec(mapping)?.[1];if(!port)throw new Error(`unable to determine PostgreSQL port from ${mapping}`);db=new PostgresDatabase(`postgresql://postgres:postgres@127.0.0.1:${port}/botroost`);await db.ping();await db.migrate();await db.migrate();auth=new AuthService(db);await auth.bootstrapOwner("owner@example.com","correct horse battery staple","Primary");api=buildApi({database:db,credentialKey:Buffer.alloc(32,7),publicOrigin:"https://app.test"});await api.ready()},120000);afterAll(async()=>{await api?.close();await db?.close();try{execFileSync("docker",["rm","-f",name],{stdio:"ignore"})}catch(error){console.warn("failed to remove PostgreSQL test container",error)}},30000);
describe("force restart API on real PostgreSQL",()=>{
 it("advertises force restart and enforces restart-role RBAC, CSRF, scope and durable replay",async()=>{
  const login=async(email:string,password:string)=>cookies((await api.inject({method:"POST",url:"/api/v1/auth/login",payload:{email,password}})).headers["set-cookie"]);
  const owner=await login("owner@example.com","correct horse battery staple");
  const session=(await api.inject({method:"GET",url:"/api/v1/auth/session",headers:{cookie:owner}})).json();
  expect(session.capabilities.operations).toContain("force-restart");expect(session.permissions).toContain("endpoint:restart");
  for(const role of ["admin","operator","viewer"] as const)await auth.addMember(session.workspace.id,`${role}@force.test`,"correct horse battery staple",role);
  for(const role of ["owner","admin","operator","viewer"] as const){
    const cookie=role==="owner"?owner:await login(`${role}@force.test`,"correct horse battery staple");
    const endpoint=(await api.inject({method:"POST",url:"/api/v1/endpoints",headers:mutation(owner),payload:{name:role,providerId:"fake"}})).json();
    const url=`/api/v1/endpoints/${endpoint.id}/operations`,payload={action:"force-restart",expectedGeneration:0},headers={...mutation(cookie),"idempotency-key":role};
    const response=await api.inject({method:"POST",url,headers,payload});
    expect(response.statusCode).toBe(role==="viewer"?403:202);
    if(role!=="viewer"){
      expect(response.json()).toMatchObject({action:"force-restart",status:"queued",generation:1});
      expect((await api.inject({method:"POST",url,headers,payload})).json().id).toBe(response.json().id);
      expect((await api.inject({method:"POST",url,headers:{...headers,"idempotency-key":"new"},payload})).statusCode).toBe(409);
      await new DurableWorker(db).runOnce();
    }
  }
  const endpoint=(await api.inject({method:"POST",url:"/api/v1/endpoints",headers:mutation(owner),payload:{name:"security",providerId:"fake"}})).json();
  const url=`/api/v1/endpoints/${endpoint.id}/operations`,payload={action:"force-restart",expectedGeneration:0};
  expect((await api.inject({method:"POST",url,headers:{cookie:owner,"idempotency-key":"csrf"},payload})).statusCode).toBe(403);
  await db.pool.query("INSERT INTO workspaces(id,name) VALUES('99999999-9999-4999-8999-999999999999','foreign')");
  await db.pool.query("UPDATE endpoints SET workspace_id='99999999-9999-4999-8999-999999999999' WHERE id=$1",[endpoint.id]);
  expect((await api.inject({method:"POST",url,headers:{...mutation(owner),"idempotency-key":"scope"},payload})).statusCode).toBe(404);
 });
});
