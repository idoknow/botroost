import {describe,expect,it} from "vitest";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {digest} from "../src/index.js";

const source=await readFile(fileURLToPath(new URL("../src/index.ts",import.meta.url)),"utf8");
const migration=await readFile(fileURLToPath(new URL("../migrations/0023_multi_tenant.sql",import.meta.url)),"utf8");
describe("multi-tenant upgrade migration",()=>{
  it("preserves legacy tenant data, upgrades all owner accounts and adds registration/invitation state",()=>{
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS platform_settings");
    expect(migration).toContain("registration_open boolean NOT NULL DEFAULT false");
    expect(migration).toContain("ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workspace_id uuid");
    expect(migration).toContain("UPDATE sessions s SET workspace_id=(SELECT m.workspace_id FROM members m WHERE m.user_id=s.user_id");
    expect(migration).toContain("UPDATE members SET workspace_role='owner',role='admin' WHERE role='owner'");
    expect(migration).toContain("UPDATE users u SET is_platform_owner=true WHERE EXISTS (SELECT 1 FROM members m WHERE m.user_id=u.id AND m.workspace_role='owner')");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS workspace_invitations");
    expect(migration).not.toContain("DROP TABLE");
    expect(migration).not.toContain("DELETE FROM workspaces");
  });
  it("does not allow ordinary workspace members to create new owner workspaces",async()=>{
    const {InMemoryDatabase}=await import("../src/index.js"),db=new InMemoryDatabase();db.users.push({id:"member",email:"member@example.com",password_hash:"hash",is_platform_owner:false});
    await expect(db.createWorkspaceForUser("member","new workspace","member")).rejects.toMatchObject({code:"forbidden"});
    expect(db.workspaces).toHaveLength(0);
    expect(source).toContain("async createWorkspaceForUser(userId:string,name:string,actorUserId:string)");
    expect(source).toContain("if(!actor?.is_platform_owner)throw new DatabaseError(\"forbidden\"");
  });
  it("keeps the published control-plane migration immutable for automatic upgrades",async()=>{
    const legacy=await readFile(fileURLToPath(new URL("../migrations/0001_control_plane.sql",import.meta.url)),"utf8");
    expect(digest(legacy)).toBe("21e94c5207ad27a74cd15a205268b97aab465f2ab162777a053e971192db08b8");
  });
});
