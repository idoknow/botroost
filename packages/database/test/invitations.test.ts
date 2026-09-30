import {describe,expect,it} from "vitest";
import {InMemoryDatabase} from "../src/index.js";

describe("tenant invitations",()=>{
  it("does not accept an expired invitation",async()=>{
    const db=new InMemoryDatabase(),workspace=db.createWorkspace("team"),token="expired-invite";
    await db.createInvitation(workspace.id,"person@example.com","viewer",token,new Date(Date.now()-1),"owner");

    await expect(db.acceptInvitation(token,"person@example.com","hash")).rejects.toMatchObject({code:"not_found"});
    expect(db.users).toHaveLength(0);
    expect(db.members).toHaveLength(0);
    expect(db.invitations[0]?.accepted_at).toBeNull();
  });

  it("does not accept a revoked invitation",async()=>{
    const db=new InMemoryDatabase(),workspace=db.createWorkspace("team"),token="revoked-invite";
    await db.createInvitation(workspace.id,"person@example.com","viewer",token,new Date(Date.now()+60_000),"owner");
    db.invitations[0]!.revoked_at=new Date();

    await expect(db.acceptInvitation(token,"person@example.com","hash")).rejects.toMatchObject({code:"not_found"});
    expect(db.users).toHaveLength(0);
    expect(db.members).toHaveLength(0);
    expect(db.invitations[0]?.accepted_at).toBeNull();
  });

  it("does not accept an invitation using another email",async()=>{
    const db=new InMemoryDatabase(),workspace=db.createWorkspace("team"),token="secret-invite";
    await db.createInvitation(workspace.id,"person@example.com","viewer",token,new Date(Date.now()+60_000),"owner");
    await expect(db.acceptInvitation(token,"attacker@example.com","hash")).rejects.toMatchObject({code:"forbidden"});
    expect(db.members).toHaveLength(0);
  });
  it("does not replace an existing active account password during invite acceptance",async()=>{
    const db=new InMemoryDatabase(),workspace=db.createWorkspace("team"),token="invite-existing";
    db.users.push({id:"existing-user",email:"person@example.com",password_hash:"original-hash"});
    await db.createInvitation(workspace.id,"person@example.com","viewer",token,new Date(Date.now()+60_000),"owner");
    await expect(db.acceptInvitation(token,"person@example.com","attacker-supplied-hash")).rejects.toMatchObject({code:"conflict"});
    expect(db.users[0]?.password_hash).toBe("original-hash");
    expect(db.members).toHaveLength(0);
  });

  it("does not reactivate a disabled account through invite acceptance",async()=>{
    const db=new InMemoryDatabase(),workspace=db.createWorkspace("team"),token="invite-disabled";
    db.users.push({id:"disabled-user",email:"person@example.com",password_hash:"original-hash",disabled_at:new Date()});
    await db.createInvitation(workspace.id,"person@example.com","viewer",token,new Date(Date.now()+60_000),"owner");
    await expect(db.acceptInvitation(token,"person@example.com","attacker-supplied-hash")).rejects.toMatchObject({code:"conflict"});
    expect(db.users[0]?.password_hash).toBe("original-hash");
    expect(db.users[0]?.disabled_at).toBeInstanceOf(Date);
    expect(db.invitations[0]?.accepted_at).toBeNull();
    expect(db.members).toHaveLength(0);
  });

  it("allows only one of concurrent invitations for the same email to create an account",async()=>{
    const db=new InMemoryDatabase(),first=db.createWorkspace("first"),second=db.createWorkspace("second"),expiresAt=new Date(Date.now()+60_000);
    await db.createInvitation(first.id,"person@example.com","viewer","first-token",expiresAt,"owner");
    await db.createInvitation(second.id,"person@example.com","viewer","second-token",expiresAt,"owner");

    const results=await Promise.allSettled([
      db.acceptInvitation("first-token","person@example.com","first-hash"),
      db.acceptInvitation("second-token","person@example.com","second-hash"),
    ]);

    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);
    expect(db.users).toHaveLength(1);
    expect(db.members).toHaveLength(1);
    expect(db.invitations.filter(invitation=>invitation.accepted_at)).toHaveLength(1);
    const unused=db.invitations.find(invitation=>!invitation.accepted_at)!;
    await expect(db.acceptInvitation(unused.token_hash,"person@example.com","another-hash")).rejects.toMatchObject({code:"conflict"});
    expect(unused.accepted_at).toBeNull();
  });

  it("adds matching email to the workspace exactly once",async()=>{
    const db=new InMemoryDatabase(),workspace=db.createWorkspace("team"),token="secret-invite";
    await db.createInvitation(workspace.id,"person@example.com","viewer",token,new Date(Date.now()+60_000),"owner");
    const accepted=await db.acceptInvitation(token,"PERSON@example.com","hash");
    expect(accepted.email).toBe("person@example.com");
    expect(db.members).toHaveLength(1);
    expect(db.members[0]).toMatchObject({workspace_id:workspace.id,role:"viewer",workspace_role:"member"});
    await expect(db.acceptInvitation(token,"person@example.com","hash")).rejects.toMatchObject({code:"not_found"});
  });

  it("lists invitations for a workspace only and reports their lifecycle state",async()=>{
    const db=new InMemoryDatabase(),workspace=db.createWorkspace("team"),other=db.createWorkspace("other"),expiresAt=new Date(Date.now()+60_000);
    await db.createInvitation(workspace.id,"pending@example.com","viewer","pending-token",expiresAt,"owner");
    await db.createInvitation(workspace.id,"accepted@example.com","admin","accepted-token",expiresAt,"owner");
    await db.createInvitation(workspace.id,"revoked@example.com","operator","revoked-token",expiresAt,"owner");
    await db.createInvitation(other.id,"foreign@example.com","viewer","foreign-token",expiresAt,"owner");
    await db.acceptInvitation("accepted-token","accepted@example.com","hash");

    const rows=await db.listInvitations(workspace.id);

    expect(rows.map(row=>row.email).sort()).toEqual(["accepted@example.com","pending@example.com","revoked@example.com"]);
    const pending=rows.find(row=>row.email==="pending@example.com")!;
    const accepted=rows.find(row=>row.email==="accepted@example.com")!;
    expect(pending.acceptedAt).toBeNull();
    expect(accepted.acceptedAt).toBeInstanceOf(Date);
    expect(rows.every(row=>row.email!=="foreign@example.com")).toBe(true);
  });

  it("revokes a pending invitation so its token stops working",async()=>{
    const db=new InMemoryDatabase(),workspace=db.createWorkspace("team"),token="revoke-me";
    db.users.push({id:"owner-user",email:"owner@example.com",password_hash:"hash",is_platform_owner:true});
    await db.createInvitation(workspace.id,"person@example.com","viewer",token,new Date(Date.now()+60_000),"owner-user");
    const listed=await db.listInvitations(workspace.id);

    await db.revokeInvitation(workspace.id,listed[0]!.id);

    expect((await db.listInvitations(workspace.id))[0]!.revokedAt).toBeInstanceOf(Date);
    await expect(db.acceptInvitation(token,"person@example.com","hash")).rejects.toMatchObject({code:"not_found"});
    expect(db.users).toHaveLength(1);
    expect(db.members).toHaveLength(0);
  });

  it("refuses to revoke an invitation from another workspace or an accepted one",async()=>{
    const db=new InMemoryDatabase(),workspace=db.createWorkspace("team"),other=db.createWorkspace("other"),expiresAt=new Date(Date.now()+60_000);
    await db.createInvitation(workspace.id,"pending@example.com","viewer","pending-token",expiresAt,"owner");
    await db.createInvitation(workspace.id,"accepted@example.com","viewer","accepted-token",expiresAt,"owner");
    await db.acceptInvitation("accepted-token","accepted@example.com","hash");
    const rows=await db.listInvitations(workspace.id);
    const pending=rows.find(row=>row.email==="pending@example.com")!,accepted=rows.find(row=>row.email==="accepted@example.com")!;

    await expect(db.revokeInvitation(other.id,pending.id)).rejects.toMatchObject({code:"not_found"});
    await expect(db.revokeInvitation(workspace.id,accepted.id)).rejects.toMatchObject({code:"not_found"});
    expect((await db.listInvitations(workspace.id)).find(row=>row.email==="pending@example.com")!.revokedAt).toBeNull();
  });
});
