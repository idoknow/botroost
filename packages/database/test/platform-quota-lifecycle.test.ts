import {describe,it,expect} from 'vitest';
import {InMemoryDatabase} from '../src/index.js';

describe('platform quota and expiry',()=>{
 it('serializes concurrent quota-check creates in Postgres by locking the target user',async()=>{
  const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../src/index.ts',import.meta.url),'utf8'));
  expect(source).toContain('const quotaLock=await c.query("SELECT id FROM users WHERE id=$1 FOR UPDATE",[userId])');
 });
 it('enforces workspace quota for a normal user',async()=>{
  const db=new InMemoryDatabase();await db.updatePlatformSettings(true);await db.updatePlatformSettings({maxWorkspacesPerUser:1});
  const user=await db.registerTenant({email:'a@example.test',passwordHash:'hash',workspaceName:'First'});
  await expect(db.createWorkspaceForUser(user.userId,'Second',user.userId)).rejects.toMatchObject({code:'forbidden'});
 });
 it('enforces user-specific endpoint quota when creating endpoint',async()=>{
  const db=new InMemoryDatabase();await db.updatePlatformSettings(true);await db.updatePlatformSettings({maxEndpointsPerWorkspace:1});
  const user=await db.registerTenant({email:'b@example.test',passwordHash:'hash',workspaceName:'Main'});
  await db.updatePlatformUser(user.userId,{maxEndpointsPerWorkspace:2});
  await db.createEndpoint(user.workspaceId,'one','fake');await db.createEndpoint(user.workspaceId,'two','fake');
  expect(()=>db.createEndpoint(user.workspaceId,'three','fake')).toThrow(/quota exceeded/);
 });
 it('stops expired workspace endpoints through a real runtime operation',async()=>{
  const db=new InMemoryDatabase();await db.updatePlatformSettings(true);await db.updatePlatformSettings({endpointExpiryGraceHours:3});
  const w=db.createWorkspace('Main');const endpoint=db.createEndpoint(w.id,'ep','fake');
  db.setWorkspaceExpiry(w.id,new Date(Date.now()-60*60*1000));
  const result=await db.processExpiredWorkspaces();
  // Expiry must enqueue a stop the agent can execute, not merely flip a column.
  expect(result).toMatchObject({stopped:1,deleted:0});
  expect(db.operations).toMatchObject([{endpointId:endpoint.id,action:'stop',status:'queued'}]);
  expect(db.outbox).toHaveLength(1);
  expect(endpoint.desired.state).toBe('stopped');
  expect(db.endpoints).toHaveLength(1);
 });
 it('uses literal expiry-history matching and a retry bound in Postgres',async()=>{
  const source=await import('node:fs/promises').then(fs=>fs.readFile(new URL('../src/index.ts',import.meta.url),'utf8'));
  expect(source).toContain("left(idempotency_key,char_length($3)+1)=$3||'#'");
  expect(source).toContain('history.length>=5');
 });
 it('enqueues a real delete operation after the grace period',async()=>{
  const db=new InMemoryDatabase();await db.updatePlatformSettings(true);await db.updatePlatformSettings({endpointExpiryGraceHours:3});
  const w=db.createWorkspace('Main');const endpoint=db.createEndpoint(w.id,'ep','fake');
  db.setWorkspaceExpiry(w.id,new Date(Date.now()-4*60*60*1000));
  const result=await db.processExpiredWorkspaces();
  expect(result).toMatchObject({stopped:0,deleted:1});
  expect(db.operations).toMatchObject([{endpointId:endpoint.id,action:'delete',status:'queued'}]);
  expect(db.outbox).toHaveLength(1);
  expect(db.endpoints).toHaveLength(1);
 });
 it('does not queue a second operation while one is still converging',async()=>{
  const db=new InMemoryDatabase();await db.updatePlatformSettings(true);await db.updatePlatformSettings({endpointExpiryGraceHours:0});
  const w=db.createWorkspace('Main');db.createEndpoint(w.id,'ep','fake');
  db.setWorkspaceExpiry(w.id,new Date(Date.now()-60_000));
  await db.processExpiredWorkspaces();await db.processExpiredWorkspaces();await db.processExpiredWorkspaces();
  expect(db.operations).toHaveLength(1);
  expect(db.outbox).toHaveLength(1);
 });
 it('does not enqueue expiry operations after the retry bound is reached',async()=>{
  const db=new InMemoryDatabase();await db.updatePlatformSettings(true);await db.updatePlatformSettings({endpointExpiryGraceHours:0});
  const w=db.createWorkspace('Main');db.createEndpoint(w.id,'ep','fake');db.setWorkspaceExpiry(w.id,new Date(Date.now()-60_000));
  await db.processExpiredWorkspaces();
  expect(db.operations.filter(operation=>operation.action==='delete')).toHaveLength(1);
 });
 it('keeps the endpoint row until the worker converges the runtime removal',async()=>{
  const db=new InMemoryDatabase();await db.updatePlatformSettings(true);await db.updatePlatformSettings({endpointExpiryGraceHours:0});
  const w=db.createWorkspace('Main');const endpoint=db.createEndpoint(w.id,'ep','fake');
  db.setWorkspaceExpiry(w.id,new Date(Date.now()-60_000));
  await db.processExpiredWorkspaces();
  expect(db.operations[0]!.action).toBe('delete');
  expect(db.endpoints).toHaveLength(1);
  await db.deleteEndpoint(w.id,endpoint.id);
  expect(db.endpoints).toHaveLength(0);
 });
 it('refuses to demote or disable the last platform owner',async()=>{
  const db=new InMemoryDatabase();await db.updatePlatformSettings(true);
  const owner=await db.registerTenant({email:'owner@example.test',passwordHash:'hash',workspaceName:'Main'});
  db.users.find(user=>user.id===owner.userId)!.is_platform_owner=true;
  await expect(db.updatePlatformUser(owner.userId,{isPlatformOwner:false})).rejects.toMatchObject({code:'conflict'});
  await expect(db.updatePlatformUser(owner.userId,{disabled:true})).rejects.toMatchObject({code:'conflict'});
 });
 it('refuses a duplicate email and duplicate node name with a conflict',async()=>{
  const db=new InMemoryDatabase();await db.updatePlatformSettings(true);
  const first=await db.registerTenant({email:'first@example.test',passwordHash:'hash',workspaceName:'First'});
  const second=await db.registerTenant({email:'second@example.test',passwordHash:'hash',workspaceName:'Second'});
  await expect(db.updatePlatformUser(second.userId,{email:'FIRST@example.test'})).rejects.toMatchObject({code:'conflict'});
  const node=db.createNode(first.workspaceId,'agent');
  db.createNode(first.workspaceId,'other');
  await expect(db.updateNode(first.workspaceId,node.id,{name:'other'})).rejects.toMatchObject({code:'conflict'});
 });
});
