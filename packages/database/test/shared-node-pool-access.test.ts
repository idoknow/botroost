import {describe,expect,it} from "vitest";
import {InMemoryDatabase} from "../src/index.js";

describe("shared node pool",()=>{
  it("keeps a node hidden from workspaces without a grant",async()=>{
    const db=new InMemoryDatabase(),a=db.createWorkspace("a"),b=db.createWorkspace("b"),node=db.createNode(a.id,"node-a");
    await db.setSharedNodePoolAccess(node.id,true,{region:"east"},"owner");
    await db.grantSharedNode(a.id,node.id,"owner");
    expect((await db.sharedNodePool(a.id)).map(x=>x.id)).toEqual([node.id]);
    expect(await db.sharedNodePool(b.id)).toEqual([]);
  });
  it("removes grants when a node is disabled",async()=>{
    const db=new InMemoryDatabase(),w=db.createWorkspace("team"),node=db.createNode(w.id,"node-a");
    await db.setSharedNodePoolAccess(node.id,true,{},"owner");
    await db.grantSharedNode(w.id,node.id,"owner");
    await db.setSharedNodePoolAccess(node.id,false,{},"owner");
    expect(await db.sharedNodePool(w.id)).toEqual([]);
    expect(db.sharedGrants).toHaveLength(0);
  });
});