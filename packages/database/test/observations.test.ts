import {afterAll,beforeAll,beforeEach,describe,expect,it} from "vitest";
import {execFileSync} from "node:child_process";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {PostgresDatabase,digest,runMigration} from "../src/index.js";

const container=`botroost-observations-${process.pid}-${Date.now()}`;
let db:PostgresDatabase;
beforeAll(async()=>{
  execFileSync("docker",["run","-d","--name",container,"-e","POSTGRES_PASSWORD=postgres","-e","POSTGRES_DB=botroost","-p","127.0.0.1::5432","postgres:16-alpine"]);
  for(let i=0;i<60;i++){try{execFileSync("docker",["exec",container,"pg_isready","-U","postgres"],{stdio:"ignore"});break}catch{await new Promise(resolve=>setTimeout(resolve,250))}}
  const port=/:(\d+)$/.exec(execFileSync("docker",["port",container,"5432/tcp"]).toString().trim())?.[1];
  if(!port)throw new Error("PostgreSQL test port unavailable");
  db=new PostgresDatabase(`postgresql://postgres:postgres@127.0.0.1:${port}/botroost`);
  for(let i=0;i<60;i++){try{await db.ping();break}catch{await new Promise(resolve=>setTimeout(resolve,250))}}
  await db.migrate();
},120_000);
afterAll(async()=>{await db?.close();execFileSync("docker",["rm","-f",container],{stdio:"ignore"})},30_000);
beforeEach(async()=>{await db.pool.query("TRUNCATE workspaces,users CASCADE")},30_000);
async function fixture(){
  const workspaceId=randomUUID(),nodeId=randomUUID(),endpointId=randomUUID(),userId=randomUUID(),sessionId:string=randomUUID();
  await db.pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'hash')",[userId,`${userId}@example.test`]);
  await db.pool.query("INSERT INTO workspaces(id,name) VALUES($1,'test')",[workspaceId]);
  await db.pool.query("INSERT INTO nodes(id,workspace_id,name,provider,connection_session_id,last_heartbeat_at,connection_epoch) VALUES($1,$2,'node','napcat',$3,now(),1)",[nodeId,workspaceId,sessionId]);
  await db.pool.query("INSERT INTO endpoints(id,workspace_id,node_id,name,provider_id) VALUES($1,$2,$3,'endpoint','napcat')",[endpointId,workspaceId,nodeId]);
  return {workspaceId,nodeId,endpointId,userId,sessionId};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const sample=(f:Fixture,metadata:Record<string,unknown>={},generation=0)=>({endpointId:f.endpointId,generation,runtime:"ready",provider:"available",protocol:"connected",convergence:"converged",metadata});
const beat=(f:Fixture,metadata:Record<string,unknown>={},generation=0)=>db.heartbeat(f.nodeId,{sessionId:f.sessionId,observedAt:"2099-01-01T00:00:00.000Z",runtimes:[sample(f,metadata,generation)]});
const rows=(f:Fixture)=>db.pool.query("SELECT * FROM observations WHERE workspace_id=$1 AND endpoint_id=$2 ORDER BY created_at,id",[f.workspaceId,f.endpointId]).then(r=>r.rows);
async function observation(f:Fixture,age:string,operation=false){
  const id=randomUUID(),operationId=operation?randomUUID():null;
  if(operationId)await db.pool.query("INSERT INTO operations(id,workspace_id,endpoint_id,generation,action,idempotency_key,request_hash,status,desired_state) VALUES($1,$2,$3,0,'start',$4,'test','succeeded','{}')",[operationId,f.workspaceId,f.endpointId,operationId]);
  await db.pool.query("INSERT INTO observations(id,workspace_id,endpoint_id,operation_id,generation,state,created_at) VALUES($1,$2,$3,$4,0,$5,now()-$6::interval)",[id,f.workspaceId,f.endpointId,operationId,{runtime:"stopped",metadata:{marker:id}},age]);
  return id;
}

describe("observation autovacuum migration on real PostgreSQL",()=>{
  const migrationName="0017_observations_autovacuum.sql";
  const migration=async()=>{const sql=await readFile(new URL(`../migrations/${migrationName}`,import.meta.url),"utf8");return{name:migrationName,sql,checksum:digest(sql)}};
  it("only changes relation options with a transaction-local five-second lock bound",async()=>{
    const {sql}=await migration();const body=sql.replace(/--[^\n]*/g,"");
    expect(body).toMatch(/SET LOCAL lock_timeout\s*=\s*'5s'/);
    expect(body).toMatch(/ALTER TABLE observations SET\s*\(/);
    expect(body).not.toMatch(/\b(?:SELECT|UPDATE|DELETE|INSERT|VACUUM|ANALYZE|CREATE INDEX)\b/i);
  });
  it("rolls back a busy-table migration within its lock timeout and can retry without rewriting data",async()=>{
    const f=await fixture();await observation(f,"60 days");const data=await rows(f);
    const relation=()=>db.pool.query("SELECT relfilenode FROM pg_class WHERE oid='observations'::regclass").then(r=>r.rows[0]);
    const before=await relation(),m=await migration(),blocker=await db.pool.connect(),client=await db.pool.connect();
    try{
      await db.pool.query("DELETE FROM schema_migrations WHERE name=$1",[m.name]);
      await blocker.query("BEGIN");await blocker.query("LOCK TABLE observations IN SHARE MODE");
      const started=Date.now();await expect(runMigration(client,m)).rejects.toMatchObject({code:"55P03"});
      expect(Date.now()-started).toBeLessThan(10_000);
      expect((await client.query("SHOW lock_timeout")).rows[0]!.lock_timeout).toBe("0");
      expect((await db.pool.query("SELECT name FROM schema_migrations WHERE name=$1",[m.name])).rowCount).toBe(0);
      await blocker.query("ROLLBACK");await runMigration(client,m);
      expect(await rows(f)).toEqual(data);expect(await relation()).toEqual(before);
      expect((await db.pool.query("SELECT checksum FROM schema_migrations WHERE name=$1",[m.name])).rows[0]!.checksum).toBe(m.checksum);
    }finally{await blocker.query("ROLLBACK");blocker.release();client.release()}
  });
  it("configures modest heap and TOAST vacuum thresholds without rewriting the relation on replay",async()=>{
    const options=async()=>db.pool.query("SELECT h.relfilenode, h.reloptions heap, t.reloptions toast FROM pg_class h JOIN pg_class t ON t.oid=h.reltoastrelid WHERE h.oid='observations'::regclass").then(r=>r.rows[0]);
    const before=await options();
    expect(before.heap).toEqual(expect.arrayContaining(["autovacuum_vacuum_scale_factor=0.05","autovacuum_vacuum_threshold=1000","autovacuum_analyze_scale_factor=0.05","autovacuum_analyze_threshold=1000"]));
    expect(before.toast).toEqual(expect.arrayContaining(["autovacuum_vacuum_scale_factor=0.05","autovacuum_vacuum_threshold=1000"]));
    const f=await fixture();await observation(f,"60 days");const data=await rows(f);
    await db.migrate();
    expect(await options()).toEqual(before);expect(await rows(f)).toEqual(data);
  });
});

describe("heartbeat snapshot on real PostgreSQL",()=>{
  it("reuses one row while refreshing full QQ, traffic and resource metadata and receive freshness",async()=>{
    const f=await fixture();await beat(f,{qq:{online:false},obsolete:true});
    const first=(await rows(f))[0]!;
    await db.pool.query("UPDATE observations SET created_at=now()-interval '30 seconds' WHERE id=$1",[first.id]);
    expect((await db.endpointNapcatSnapshot(f.workspaceId,f.endpointId)).observationFresh).toBe(false);
    const metadata={qq:{online:true,nickname:"new"},protocolTraffic:{received:17,sent:3,observedAt:"2026-09-05T00:00:00Z"},resourceUsage:{cpuPercent:0,memoryBytes:123,observedAt:"2026-09-05T00:00:00Z"}};
    for(let i=0;i<8;i++)await beat(f,metadata);
    const stored=await rows(f);expect(stored).toHaveLength(1);expect(stored[0]).toMatchObject({id:first.id,generation:"0",state:{metadata}});
    expect(stored[0]!.state.metadata).toEqual(metadata);
    const snapshot=await db.endpointNapcatSnapshot(f.workspaceId,f.endpointId);
    expect(snapshot).toMatchObject({metadata,observationFresh:true,nodeOnline:true});
    expect(new Date(snapshot.observationAt!).getUTCFullYear()).not.toBe(2099);
    expect((await db.endpoint(f.workspaceId,f.endpointId))?.metadata).toEqual(metadata);
    expect((await db.endpoints(f.workspaceId))[0]?.metadata).toEqual(metadata);
    // Equal JSON still advances receive time, not resource sample time.
    await db.pool.query("UPDATE observations SET created_at=now()-interval '30 seconds' WHERE id=$1",[first.id]);
    await beat(f,metadata);expect(await rows(f)).toHaveLength(1);
    expect(await db.endpointNapcatSnapshot(f.workspaceId,f.endpointId)).toMatchObject({metadata,observationFresh:true});
  });
  it("preserves operation evidence and updates the newest legacy heartbeat across generation changes",async()=>{
    const f=await fixture(),old=await observation(f,"3 days"),newest=await observation(f,"2 days"),op=await observation(f,"1 day",true);
    const before=await rows(f);await db.pool.query("UPDATE endpoints SET generation=1 WHERE id=$1",[f.endpointId]);
    await beat(f,{qq:{online:true}},1);const after=await rows(f);
    expect(after).toHaveLength(3);expect(after.find(r=>r.id===old)).toEqual(before.find(r=>r.id===old));expect(after.find(r=>r.id===op)).toEqual(before.find(r=>r.id===op));
    expect(after.at(-1)).toMatchObject({id:newest,generation:"1",operation_id:null,state:{metadata:{qq:{online:true}}}});
  });
  it("does not overwrite a current sample with stale or future generation or another tenant endpoint",async()=>{
    const f=await fixture(),other=await fixture();await db.pool.query("UPDATE endpoints SET generation=1 WHERE id=$1",[f.endpointId]);await beat(f,{marker:"current"},1);const before=await rows(f);
    await beat(f,{marker:"stale"},0);await beat(f,{marker:"future"},2);
    await db.heartbeat(f.nodeId,{sessionId:f.sessionId,observedAt:new Date().toISOString(),runtimes:[sample(other)]});
    expect(await rows(f)).toEqual(before);expect(await rows(other)).toHaveLength(0);
  });
  it("does not renew absent, deleted, revoked or retired-session runtime samples",async()=>{
    const f=await fixture();await beat(f);const before=await rows(f);
    await db.heartbeat(f.nodeId,{sessionId:f.sessionId,observedAt:new Date().toISOString(),runtimes:[]});expect(await rows(f)).toEqual(before);
    await db.pool.query("INSERT INTO retired_node_sessions(node_id,session_id) VALUES($1,'retired')",[f.nodeId]);
    await expect(beat({...f,sessionId:"retired"})).rejects.toMatchObject({code:"conflict"});
    await db.pool.query("UPDATE endpoints SET deleted_at=now() WHERE id=$1",[f.endpointId]);await beat(f);expect(await rows(f)).toEqual(before);
    await db.pool.query("UPDATE nodes SET revoked_at=now() WHERE id=$1",[f.nodeId]);await expect(beat(f)).rejects.toMatchObject({code:"unauthorized"});expect(await rows(f)).toEqual(before);
  });
});

describe("bounded observation retention on real PostgreSQL",()=>{
  it("expires heartbeat after 24h and operation evidence after 30d but retains newest overall and newest heartbeat including deleted/offline endpoints",async()=>{
    const f=await fixture(),deleted=await fixture();
    const expired=[await observation(f,"31 days",true),await observation(f,"25 hours")];
    const keep=[await observation(f,"29 days",true),await observation(f,"23 hours"),await observation(f,"1 hour",true)];
    const deletedOld=await observation(deleted,"60 days"),deletedKeep=[await observation(deleted,"45 days"),await observation(deleted,"40 days",true)];
    await db.pool.query("UPDATE endpoints SET deleted_at=now() WHERE id=$1",[deleted.endpointId]);await db.pool.query("UPDATE nodes SET last_heartbeat_at=now()-interval '40 days'");
    const result=await db.pruneObservations();expect(result.removed).toBe(3);
    const all=(await db.pool.query("SELECT id FROM observations")).rows.map(r=>r.id).sort();expect(all).toEqual([...keep,...deletedKeep].sort());
    expect(all).not.toContain(deletedOld);for(const id of expired)expect(all).not.toContain(id);
    expect((await db.pruneObservations()).removed).toBe(0);
  });
  it("bounds deletions and walks endpoint pages without starving later tenants",async()=>{
    const fixtures=await Promise.all(Array.from({length:10},()=>fixture()));
    for(const f of fixtures){for(let i=0;i<3;i++)await observation(f,"2 days");await observation(f,"0 seconds");await beat(f)}
    let afterEndpointId:string|undefined,removed=0;
    for(let i=0;i<20;i++){
      const result=await db.pruneObservations({batchSize:2,...(afterEndpointId?{afterEndpointId}:{})});expect(result.removed).toBeLessThanOrEqual(2);removed+=result.removed;afterEndpointId=result.afterEndpointId??undefined;
    }
    expect(removed).toBe(30);for(const f of fixtures)expect(await rows(f)).toHaveLength(1);
  });
  it("skips busy endpoint and observation locks rather than blocking heartbeat or operations",async()=>{
    const f=await fixture(),other=await fixture(),old=await observation(f,"3 days");await observation(f,"0 seconds");await beat(f);const otherOld=await observation(other,"3 days");await observation(other,"0 seconds");await beat(other);
    const blocker=await db.pool.connect();try{
      await blocker.query("BEGIN");await blocker.query("SELECT id FROM endpoints WHERE id=$1 FOR UPDATE",[f.endpointId]);
      expect((await db.pruneObservations()).removed).toBe(1);expect((await rows(f)).map(r=>r.id)).toContain(old);expect((await rows(other)).map(r=>r.id)).not.toContain(otherOld);
      await blocker.query("COMMIT");await blocker.query("BEGIN");await blocker.query("SELECT id FROM observations WHERE id=$1 FOR UPDATE",[old]);
      expect((await db.pruneObservations()).removed).toBe(0);
      await blocker.query("COMMIT");expect((await db.pruneObservations()).removed).toBe(1);
    }finally{await blocker.query("ROLLBACK");blocker.release()}
  });
  it("serializes two cleaners and repeated concurrent heartbeats without deleting the live snapshot",async()=>{
    const f=await fixture();for(let i=0;i<20;i++)await observation(f,"2 days");await observation(f,"0 seconds");await beat(f);const current=(await rows(f)).at(-1)!.id;
    const results=await Promise.all([db.pruneObservations(),db.pruneObservations(),(async()=>{for(let i=0;i<10;i++)await beat(f,{marker:i});return{removed:0}})()]);
    const finalSweep=await db.pruneObservations();expect(results.reduce((sum,r)=>sum+r.removed,finalSweep.removed)).toBe(20);
    expect(await rows(f)).toHaveLength(1);expect((await rows(f))[0]).toMatchObject({id:current,state:{metadata:{marker:9}}});
    expect((await db.endpointNapcatSnapshot(f.workspaceId,f.endpointId)).observationFresh).toBe(true);
  });
});
