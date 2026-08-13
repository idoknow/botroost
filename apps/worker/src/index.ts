import { PostgresDatabase } from "@botroost/database";
export class DurableWorker{constructor(private db:PostgresDatabase){}async reconcileMissingOutbox(){return this.db.repairMissingOutbox()}async runOnce(){await this.reconcileMissingOutbox();return this.db.processOne()}}
export async function runWorker(){const db=new PostgresDatabase(process.env.DATABASE_URL!);const worker=new DurableWorker(db);for(;;){const worked=await worker.runOnce();if(!worked)await new Promise(r=>setTimeout(r,500))}}
