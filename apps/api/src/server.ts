import { buildApi } from "./index.js";
const api=buildApi({trustProxy:process.env.TRUST_PROXY==="true"});
await api.listen({host:process.env.HOST??"0.0.0.0",port:Number(process.env.PORT??3000)});
