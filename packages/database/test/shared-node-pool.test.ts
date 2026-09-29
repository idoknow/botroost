import {describe,expect,it} from "vitest";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {digest} from "../src/index.js";

const migration=await readFile(fileURLToPath(new URL("../migrations/0024_shared_node_pool.sql",import.meta.url)),"utf8");
describe("shared node pool migration",()=>{
  it("adds explicit platform node-pool policy without replacing workspace ownership",()=>{
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS platform_node_pool");
    expect(migration).toContain("node_id uuid PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE");
    expect(migration).toContain("enabled boolean NOT NULL DEFAULT false");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS workspace_node_pool_grants");
    expect(migration).toContain("CREATE TRIGGER endpoints_node_workspace_guard");
    expect(migration).toContain("FOREIGN KEY(owner_workspace_id,node_id) REFERENCES nodes(workspace_id,id)");
    expect(migration).toContain("CREATE TRIGGER operations_node_workspace_guard BEFORE INSERT OR UPDATE OF workspace_id,node_id,endpoint_id ON operations");
    expect(migration).toContain("CREATE TRIGGER agent_commands_node_workspace_guard BEFORE INSERT OR UPDATE OF workspace_id,node_id,endpoint_id ON agent_commands");
    expect(migration).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint");
    expect(migration).not.toContain("DROP TABLE");
  });
  it("keeps pre-multitenant published schema migration checksums unchanged",async()=>{
    const one=await readFile(fileURLToPath(new URL("../migrations/0001_control_plane.sql",import.meta.url)),"utf8");
    const two=await readFile(fileURLToPath(new URL("../migrations/0002_outbound_agent.sql",import.meta.url)),"utf8");
    expect(digest(one)).toBe("21e94c5207ad27a74cd15a205268b97aab465f2ab162777a053e971192db08b8");
    expect(digest(two)).toBe("1723679204313029ac5ce9c82be735e3b6e461dc0062b1a8a7ccd6d142ec5143");
  });
});
