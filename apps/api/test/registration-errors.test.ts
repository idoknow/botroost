import {afterEach,describe,expect,it,vi} from "vitest";
import {AuthService} from "@botroost/auth";
import {InMemoryDatabase} from "@botroost/database";
import {buildApi} from "../src/index.js";

afterEach(()=>vi.restoreAllMocks());

describe("registration error responses",()=>{
  it("hides unexpected statusCode errors from the registration response",async()=>{
    const database=new InMemoryDatabase();
    await database.updatePlatformSettings(true);
    vi.spyOn(AuthService.prototype,"register").mockRejectedValue(Object.assign(new Error("database password leaked"),{statusCode:418}));
    const api=buildApi({database:database as never,credentialKey:Buffer.alloc(32,1),publicOrigin:"https://app.test"});
    await api.ready();
    const response=await api.inject({method:"POST",url:"/api/v1/auth/register",payload:{email:"new@example.com",password:"a sufficiently long password",name:"New"}});
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({error:{code:"internal_error",message:"internal error"}});
    expect(response.body).not.toContain("database password leaked");
    await api.close();
  });
});
