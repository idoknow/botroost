import {describe,expect,it} from "vitest";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const sql=await readFile(fileURLToPath(new URL("../migrations/0024_shared_node_pool.sql",import.meta.url)),"utf8");
const claimFunction=sql.split("CREATE OR REPLACE FUNCTION guard_agent_command_claim()")[1]?.split("$$;")[0]??"";
const commandGuard=sql.split("CREATE OR REPLACE FUNCTION enforce_shared_node_pool_grant()")[1]?.split("$$;")[0]??"";
describe("shared-node execution tenant boundary",()=>{
  it("authorizes cross-workspace operations and agent commands only through endpoint grants",()=>{
    expect(sql).toContain("operations_workspace_endpoint_id_fkey");
    expect(sql).toContain("agent_commands_workspace_endpoint_id_fkey");
    expect(sql).toContain("operation node must match its endpoint node");
    expect(sql).toContain("agent command node must match its endpoint node");
    expect(sql).toContain("operation node is not authorized for workspace");
    expect(sql).toContain("agent command node is not authorized for workspace");
    expect(sql).toContain("workspace_node_pool_grants g");
    expect(sql).toContain("p.enabled AND n.revoked_at IS NULL");
  });
  it("does not let operation or command endpoint changes bypass node ownership checks",()=>{
    expect(sql).toContain("operations_workspace_endpoint_id_fkey");
    expect(sql).toContain("CREATE TRIGGER operations_node_workspace_guard BEFORE INSERT OR UPDATE OF workspace_id,node_id,endpoint_id ON operations");
    expect(sql).toContain("CREATE TRIGGER agent_commands_node_workspace_guard BEFORE INSERT OR UPDATE OF workspace_id,node_id,endpoint_id ON agent_commands");
  });
  it("invalidates leased work on authorization revocation and fences late results",()=>{
    expect(sql).toContain("CREATE TRIGGER workspace_node_pool_grants_revoke_work");
    expect(sql).toContain("CREATE TRIGGER platform_node_pool_revoke_work");
    expect(commandGuard).toContain("OLD.status='leased'");
    expect(commandGuard).toContain("NEW.status IN ('succeeded','failed')");
    expect(claimFunction).not.toMatch(/UPDATE\s+agent_commands/i);
  });
  it("cancels invalid claims without recursively updating agent_commands and stales only its operation",()=>{
    expect(claimFunction).not.toMatch(/UPDATE\s+agent_commands/i);
    expect(claimFunction).toContain("NEW.status='stale'");
    expect(claimFunction).not.toMatch(/UPDATE\s+operations/i);
    expect(claimFunction).toContain("node_session_stale");
    expect(claimFunction).toContain("shared_node_access_revoked");
    expect(claimFunction).toContain("FOR UPDATE");
    expect(sql).toContain("CREATE TRIGGER agent_commands_claim_guard BEFORE UPDATE OF status,attempts ON agent_commands");
  });
});