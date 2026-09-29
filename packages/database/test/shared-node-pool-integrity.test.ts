import {describe,expect,it} from "vitest";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {digest,InMemoryDatabase} from "../src/index.js";
const sql=await readFile(fileURLToPath(new URL("../migrations/0024_shared_node_pool.sql",import.meta.url)),"utf8");
describe("shared node pool integrity",()=>{
 it("does not allow ungranted cross-workspace endpoint assignment",()=>{
  expect(sql).not.toContain("IF TG_OP='UPDATE' THEN RETURN NEW");
  expect(sql).toContain("FOR UPDATE OF p");
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS platform_node_pool");
  expect(sql).toContain("owner_workspace_id uuid NOT NULL");
  expect(sql).toContain("FOREIGN KEY(owner_workspace_id,node_id) REFERENCES nodes(workspace_id,id)");
  expect(sql).toContain("platform_node_pool_owner_guard");
  expect(sql).toContain("CREATE TRIGGER endpoints_node_workspace_guard");
  expect(sql).toContain("UPDATE endpoints SET node_id=NULL,updated_at=now() WHERE node_id=NEW.id");
  expect(sql).toContain("FOREIGN KEY(owner_workspace_id,node_id) REFERENCES nodes(workspace_id,id)");
  expect(sql).toContain("CREATE TRIGGER operations_node_workspace_guard BEFORE INSERT OR UPDATE OF workspace_id,node_id,endpoint_id ON operations");
  expect(sql).toContain("CREATE TRIGGER agent_commands_node_workspace_guard BEFORE INSERT OR UPDATE OF workspace_id,node_id,endpoint_id ON agent_commands");
 });
 it("hides nodes lacking an explicit grant and removes grants on disable",async()=>{
  const db=new InMemoryDatabase(),one=db.createWorkspace("one"),two=db.createWorkspace("two"),node=db.createNode(one.id,"shared-node");
  await db.setSharedNodePoolAccess(node.id,true,{},"owner");await db.grantSharedNode(one.id,node.id,"owner");
  expect((await db.sharedNodePool(one.id)).map(x=>x.id)).toEqual([node.id]);expect(await db.sharedNodePool(two.id)).toEqual([]);
  await db.setSharedNodePoolAccess(node.id,false,{},"owner");expect(db.sharedGrants).toHaveLength(0);
 });
 it("removes pool records when source node is revoked and retains legacy schema bytes",async()=>{
  expect(sql).toContain("platform_node_pool_disable_on_node_revoke");expect(sql).toContain("DELETE FROM workspace_node_pool_grants WHERE node_id=NEW.id");
  const old=await readFile(fileURLToPath(new URL("../migrations/0001_control_plane.sql",import.meta.url)),"utf8");expect(digest(old)).toBe("21e94c5207ad27a74cd15a205268b97aab465f2ab162777a053e971192db08b8");
 });
 it("removes grants through cascading pool disable",()=>{
  expect(sql).toContain("node_id uuid NOT NULL REFERENCES platform_node_pool(node_id) ON DELETE CASCADE");
  expect(sql).toContain("DROP TRIGGER IF EXISTS platform_node_pool_revoke_work ON platform_node_pool");
  expect(sql).toContain("CREATE TRIGGER platform_node_pool_revoke_work AFTER UPDATE OF enabled ON platform_node_pool");
 });
 it("makes every shared-pool trigger creation safe on migration re-application",()=>{
  const created=[...sql.matchAll(/CREATE TRIGGER\s+(\w+)/g)].map(match=>match[1]);
  const dropped=new Set([...sql.matchAll(/DROP TRIGGER IF EXISTS\s+(\w+)/g)].map(match=>match[1]));
  expect(created.filter(name=>!dropped.has(name))).toEqual([]);
 });
});
