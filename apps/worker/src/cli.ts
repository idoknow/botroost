import {runWorker} from "./index.js";
const controller=new AbortController();
process.once("SIGTERM",()=>controller.abort());process.once("SIGINT",()=>controller.abort());
await runWorker(controller.signal);