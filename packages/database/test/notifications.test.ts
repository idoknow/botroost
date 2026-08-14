import {describe,expect,it} from "vitest";
import {readFile} from "node:fs/promises";
import {migrationSql} from "../src/index.js";
describe("notification durability schema",()=>{
  it("adds state and retryable notification outbox in a new migration",async()=>{
    expect(migrationSql).toContain("0005_napcat_notifications");
    for(const fragment of ["napcat_notification_state","endpoint_id uuid PRIMARY KEY REFERENCES endpoints","notification_outbox","provider_message_id","attempts integer","failed_at"])expect(migrationSql).toContain(fragment);
    expect(migrationSql).toContain("0006_notification_claim_lease");
    const sql=await readFile(new URL("../migrations/0005_napcat_notifications.sql",import.meta.url),"utf8");
    expect(sql).toMatch(/^BEGIN;[\s\S]*COMMIT;\n$/);
  });
});
