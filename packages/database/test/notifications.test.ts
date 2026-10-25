import {describe,expect,it} from "vitest";
import {readFile} from "node:fs/promises";
import {evaluateQqLoginAlertTransition,migrationSql,PostgresDatabase} from "../src/index.js";

describe("QQ login alert policy",()=>{
  const now=new Date("2026-08-22T12:00:00.000Z");
  it("holds the first offline sample as pending instead of paging on it",()=>expect(evaluateQqLoginAlertTransition({incidentOpen:false,observedAt:new Date("2026-08-22T11:59:30.000Z"),qqOnline:false,offlineSince:null,now,graceSeconds:60})).toEqual({state:"offline-pending",incidentOpen:false,offlineSince:now,event:null}));
  it("keeps holding an offline sample that has not survived the grace window yet",()=>expect(evaluateQqLoginAlertTransition({incidentOpen:false,observedAt:new Date("2026-08-22T11:59:45.000Z"),qqOnline:false,offlineSince:new Date("2026-08-22T11:59:20.000Z"),now,graceSeconds:60})).toEqual({state:"offline-pending",incidentOpen:false,offlineSince:new Date("2026-08-22T11:59:20.000Z"),event:null}));
  it("opens an incident once the offline sample survives the grace window",()=>expect(evaluateQqLoginAlertTransition({incidentOpen:false,observedAt:new Date("2026-08-22T11:59:30.000Z"),qqOnline:false,offlineSince:new Date("2026-08-22T11:58:00.000Z"),now,graceSeconds:60})).toEqual({state:"offline",incidentOpen:true,offlineSince:new Date("2026-08-22T11:58:00.000Z"),event:"endpoint.offline"}));
  it("keeps QQ online even when a separate protocol probe is disconnected",()=>expect(evaluateQqLoginAlertTransition({incidentOpen:false,observedAt:new Date("2026-08-22T11:59:30.000Z"),qqOnline:true,offlineSince:null,now,graceSeconds:60})).toEqual({state:"online",incidentOpen:false,offlineSince:null,event:null}));
  it("clears a pending offline sample when QQ answers online again",()=>expect(evaluateQqLoginAlertTransition({incidentOpen:false,observedAt:new Date("2026-08-22T11:59:30.000Z"),qqOnline:true,offlineSince:new Date("2026-08-22T11:59:00.000Z"),now,graceSeconds:60})).toEqual({state:"online",incidentOpen:false,offlineSince:null,event:null}));
  it("emits one recovery only after a fresh QQ-online observation",()=>expect(evaluateQqLoginAlertTransition({incidentOpen:true,observedAt:new Date("2026-08-22T11:59:30.000Z"),qqOnline:true,offlineSince:new Date("2026-08-22T11:55:00.000Z"),now,graceSeconds:60})).toEqual({state:"online",incidentOpen:false,offlineSince:null,event:"endpoint.recovery"}));
  it("preserves an open incident when QQ login state is stale or unknown",()=>expect(evaluateQqLoginAlertTransition({incidentOpen:true,observedAt:new Date("2026-08-22T11:50:00.000Z"),qqOnline:false,offlineSince:new Date("2026-08-22T11:55:00.000Z"),now,graceSeconds:60})).toEqual({state:"unknown",incidentOpen:true,offlineSince:new Date("2026-08-22T11:55:00.000Z"),event:null}));
});
describe("notification durability schema",()=>{
  it("adds state and retryable notification outbox in a new migration",async()=>{
    expect(migrationSql).toContain("0005_napcat_notifications");
    for(const fragment of ["napcat_notification_state","endpoint_id uuid PRIMARY KEY REFERENCES endpoints","notification_outbox","provider_message_id","attempts integer","failed_at"])expect(migrationSql).toContain(fragment);
    expect(migrationSql).toContain("0006_notification_claim_lease");
    const sql=await readFile(new URL("../migrations/0005_napcat_notifications.sql",import.meta.url),"utf8");
    expect(sql).toMatch(/^BEGIN;[\s\S]*COMMIT;\n$/);
  });
  it("serializes concurrent reconciliation by locking endpoint rows",()=>{
    expect(PostgresDatabase.prototype.reconcileEndpointNotifications.toString()).toContain("FOR UPDATE OF e");
  });
  it("stores named targets, endpoint subscriptions, and defaults in a dedicated migration",()=>{for(const fragment of ["0014_alert_subscriptions","notification_targets","workspace_notification_defaults","endpoint_notification_subscriptions","endpoint.offline","endpoint.recovery","DROP COLUMN sender"])expect(migrationSql).toContain(fragment)});
  it("stores QQ login incidents in a policy-specific table and scans protocol endpoints",()=>{
    expect(migrationSql).toContain("0015_qq_login_notification_state");
    expect(migrationSql).toContain("CREATE TABLE qq_login_notification_state");
    const source=PostgresDatabase.prototype.reconcileEndpointNotifications.toString();
    expect(source).toContain("qq_login_notification_state");
    expect(source).toContain("provider_id IN ('napcat','snowluma','llbot')");
  });
  it("persists the offline grace window on the QQ login state row",()=>{
    expect(migrationSql).toContain("0032_qq_login_offline_grace");
    expect(migrationSql).toContain("ADD COLUMN offline_since timestamptz");
    expect(migrationSql).toContain("'offline-pending'");
    const source=PostgresDatabase.prototype.reconcileEndpointNotifications.toString();
    expect(source).toContain("offline_since");
  });
  it("ships migrations that permit OneBot websocket updates and durable endpoint deletion",()=>{
    expect(migrationSql).toContain("0008_onebot_websocket_management");
    expect(migrationSql).toContain("update-onebot-websockets");
    expect(migrationSql).toContain("0010_endpoint_deletion");
    expect(migrationSql).toContain("'delete'");
  });
});
