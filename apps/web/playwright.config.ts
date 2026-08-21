import {defineConfig,devices} from '@playwright/test';
const baseURL=process.env.BOTROOST_E2E_BASE_URL??'http://127.0.0.1:4173';
export default defineConfig({testDir:'./e2e',timeout:60_000,use:{baseURL,trace:'retain-on-failure'},...(process.env.LIVE_E2E==='1'?{}:{webServer:{command:'bun run dev --host 127.0.0.1 --port 4173',url:'http://127.0.0.1:4173',reuseExistingServer:true}}),projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}]});
