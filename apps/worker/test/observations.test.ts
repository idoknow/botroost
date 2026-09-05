import {afterEach,describe,expect,it,vi} from "vitest";
import {PostgresDatabase} from "@botroost/database";
import {DurableWorker} from "../src/index.js";

afterEach(()=>vi.restoreAllMocks());
function fixture(){
  const db={repairMissingOutbox:vi.fn(async()=>0),reconcileEndpointNotifications:vi.fn(async()=>0),processOne:vi.fn(async()=>false),pruneObservations:vi.fn(async(_input:unknown)=>({removed:7,afterEndpointId:"endpoint-cursor" as string|null}))};
  return{db,worker:new DurableWorker(db as unknown as PostgresDatabase)};
}
describe("worker observation maintenance",()=>{
  it("runs one bounded batch per minute, advances its cursor and logs the actual deletion count",async()=>{
    let now=1000;vi.spyOn(Date,"now").mockImplementation(()=>now);const log=vi.spyOn(console,"info").mockImplementation(()=>{});const {db,worker}=fixture();
    expect(await worker.runOnce()).toBe(false);expect(db.pruneObservations).toHaveBeenCalledExactlyOnceWith({batchSize:200});
    expect(log).toHaveBeenCalledWith("observation retention",{removed:7});
    now+=59_999;await worker.runOnce();expect(db.pruneObservations).toHaveBeenCalledTimes(1);
    now++;db.pruneObservations.mockResolvedValueOnce({removed:0,afterEndpointId:null});await worker.runOnce();
    expect(db.pruneObservations).toHaveBeenLastCalledWith({batchSize:200,afterEndpointId:"endpoint-cursor"});
    now+=60_000;await worker.runOnce();expect(db.pruneObservations).toHaveBeenLastCalledWith({batchSize:200});
    expect(db.processOne).toHaveBeenCalledTimes(4);
  });
  it("isolates maintenance failures from operation work and does not retry every hot-loop iteration",async()=>{
    let now=1000;vi.spyOn(Date,"now").mockImplementation(()=>now);const log=vi.spyOn(console,"warn").mockImplementation(()=>{});const {db,worker}=fixture();
    db.processOne.mockResolvedValue(true);db.pruneObservations.mockRejectedValueOnce(new Error("statement timeout"));
    expect(await worker.runOnce()).toBe(true);expect(log).toHaveBeenCalledWith("observation retention failed",expect.any(Error));
    await worker.runOnce();expect(db.pruneObservations).toHaveBeenCalledTimes(1);
    now+=60_000;await worker.runOnce();expect(db.pruneObservations).toHaveBeenCalledTimes(2);expect(db.pruneObservations).toHaveBeenLastCalledWith({batchSize:200});
  });
});
