import { startAgentFromEnv } from "./index.js";

const agent = await startAgentFromEnv();
for (;;) {
  await agent.pollOnce();
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
