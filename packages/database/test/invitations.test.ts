import {describe,expect,it} from "vitest";
import {InMemoryDatabase} from "../src/index.js";

describe("tenant invitations",()=>{
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
});
