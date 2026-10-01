import {describe,expect,it} from "vitest";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";

const migration=await readFile(fileURLToPath(new URL("../migrations/0025_session_workspace_isolation.sql",import.meta.url)),"utf8");

describe("session workspace deletion isolation",()=>{
  it("binds sessions to a workspace membership and cascades deletion without unbinding them",()=>{
    expect(migration).not.toContain("UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE workspace_id IS NOT NULL");
    expect(migration).toContain("ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_workspace_id_fkey");
    expect(migration).toContain("FOREIGN KEY(workspace_id,user_id) REFERENCES members(workspace_id,user_id) ON DELETE CASCADE ON UPDATE CASCADE");
    expect(migration).not.toContain("REFERENCES workspaces(id) ON DELETE SET NULL");
  });
});
