import {describe,expect,it,vi} from "vitest";
import {evaluateNapcatAlertTransition,ResendClient} from "../src/notifications.js";
import {emailConfigFromEnvironment} from "../src/index.js";

describe("worker mail configuration",()=>{
  it("fails closed when Resend delivery is not fully configured",()=>{
    expect(()=>emailConfigFromEnvironment({})).toThrow("must be configured");
    expect(()=>emailConfigFromEnvironment({RESEND_API_KEY:"key"})).toThrow("must be configured");
    expect(()=>emailConfigFromEnvironment({ALERT_EMAIL_FROM:"Campux <noreply@campux.top>"})).toThrow("must be configured");
  });
  it("accepts a complete Resend configuration",()=>expect(emailConfigFromEnvironment({RESEND_API_KEY:" key ",ALERT_EMAIL_FROM:" Campux <noreply@campux.top> "})).toEqual({apiKey:"key",from:"Campux <noreply@campux.top>"}));
});

describe("NapCat alert policy",()=>{
  const at=(seconds:number)=>new Date(seconds*1000);
  it("does not alert for a node that has never completed a heartbeat",()=>{
    expect(evaluateNapcatAlertTransition({previous:"unknown",incidentOpen:false,lastHeartbeatAt:null,now:at(300),graceSeconds:60})).toEqual({state:"unknown",incidentOpen:false,event:null});
  });
  it("debounces offline, emits once, then emits one recovery",()=>{
    expect(evaluateNapcatAlertTransition({previous:"online",incidentOpen:false,lastHeartbeatAt:at(250),now:at(300),graceSeconds:60})).toEqual({state:"online",incidentOpen:false,event:null});
    expect(evaluateNapcatAlertTransition({previous:"online",incidentOpen:false,lastHeartbeatAt:at(200),now:at(300),graceSeconds:60})).toEqual({state:"offline",incidentOpen:true,event:"offline"});
    expect(evaluateNapcatAlertTransition({previous:"offline",incidentOpen:true,lastHeartbeatAt:at(200),now:at(400),graceSeconds:60})).toEqual({state:"offline",incidentOpen:true,event:null});
    expect(evaluateNapcatAlertTransition({previous:"offline",incidentOpen:true,lastHeartbeatAt:at(399),now:at(400),graceSeconds:60})).toEqual({state:"online",incidentOpen:false,event:"recovery"});
    expect(evaluateNapcatAlertTransition({previous:"online",incidentOpen:false,lastHeartbeatAt:at(399),now:at(401),graceSeconds:60})).toEqual({state:"online",incidentOpen:false,event:null});
  });
});

describe("ResendClient",()=>{
  it("uses bounded timeout and User-Agent and returns provider message id",async()=>{
    const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get("User-Agent")).toMatch(/^Botroost\//);
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer re_test");
      return new Response(JSON.stringify({id:"msg_123"}),{status:200,headers:{"content-type":"application/json"}});
    });
    const client=new ResendClient({fetcher:fetcher as unknown as typeof fetch,timeoutMs:100});
    await expect(client.send({apiKey:"re_test",from:"Botroost <alerts@example.com>",to:"ops@example.com",subject:"offline",html:"<p>offline</p>"})).resolves.toEqual({providerMessageId:"msg_123"});
  });
  it("rejects unsuccessful or malformed provider responses",async()=>{
    const failed=new ResendClient({fetcher:vi.fn(async()=>new Response("no",{status:429})) as unknown as typeof fetch,timeoutMs:100});
    await expect(failed.send({apiKey:"key",from:"a@example.com",to:"b@example.com",subject:"x",html:"x"})).rejects.toThrow("Resend request failed (429)");
  });
});
