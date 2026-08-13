import {PostgresDatabase} from "@botroost/database";
const db=new PostgresDatabase(process.env.DATABASE_URL!);
try{await db.migrate()}finally{await db.close()}