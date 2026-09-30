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
  it("lets a workspace member create their own workspace under the quota but not one for somebody else",async()=>{
    const {InMemoryDatabase}=await import("../src/index.js"),db=new InMemoryDatabase();db.users.push({id:"member",email:"member@example.com",password_hash:"hash",is_platform_owner:false});db.users.push({id:"other",email:"other@example.com",password_hash:"hash",is_platform_owner:false});
    const created=await db.createWorkspaceForUser("member","new workspace","member");
    expect(created).toMatchObject({name:"new workspace"});
    expect(db.workspaces).toHaveLength(1);
    expect(db.members).toMatchObject([{workspace_id:created.id,user_id:"member",role:"admin",workspace_role:"owner"}]);
    // A member must not be able to create a workspace owned by another account.
    await expect(db.createWorkspaceForUser("other","second workspace","member")).rejects.toMatchObject({code:"forbidden"});
    expect(db.workspaces).toHaveLength(1);
    // The platform quota is enforced in the database path, not only in the UI.
    await db.updatePlatformSettings({maxWorkspacesPerUser:1});
    await expect(db.createWorkspaceForUser("member","over quota","member")).rejects.toMatchObject({code:"forbidden"});
    expect(db.workspaces).toHaveLength(1);
    expect(source).toContain("async createWorkspaceForUser(userId:string,name:string,actorUserId:string)");
    expect(source).toContain('if(actorUserId!==userId&&!actor?.is_platform_owner)throw new DatabaseError("forbidden"');
    expect(source).toContain("workspace quota exceeded");
  });
  it("adds the platform quota and expiry columns without touching existing data",async()=>{
    const quotas=await readFile(fileURLToPath(new URL("../migrations/0026_platform_quotas_and_expiry.sql",import.meta.url)),"utf8");
    expect(quotas).toContain("ADD COLUMN IF NOT EXISTS expires_at timestamptz");
    expect(quotas).toContain("ADD COLUMN IF NOT EXISTS endpoint_expiry_grace_hours integer NOT NULL DEFAULT 24");
    expect(quotas).toContain("ADD COLUMN IF NOT EXISTS max_endpoints_per_workspace integer");
    expect(quotas).toContain("ADD COLUMN IF NOT EXISTS remark text");
    expect(quotas).not.toContain("DROP COLUMN");
    expect(quotas).not.toContain("DROP TABLE");
  });
  it("keeps the published control-plane migration immutable for automatic upgrades",async()=>{
    const legacy=await readFile(fileURLToPath(new URL("../migrations/0001_control_plane.sql",import.meta.url)),"utf8");
    expect(digest(legacy)).toBe("21e94c5207ad27a74cd15a205268b97aab465f2ab162777a053e971192db08b8");
  });
});