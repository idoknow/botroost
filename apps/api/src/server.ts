import { buildApi } from "./index.js";
import { parseTrustedProxy } from "./security-policy.js";
const api=buildApi({trustProxy:parseTrustedProxy(process.env.TRUST_PROXY)});
await api.listen({host:process.env.HOST??"0.0.0.0",port:Number(process.env.PORT??3000)});
const shutdown=async()=>{await api.close();process.exitCode=0};
process.once("SIGTERM",()=>void shutdown());process.once("SIGINT",()=>void shutdown());
