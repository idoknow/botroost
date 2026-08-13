import {defineConfig,devices} from '@playwright/test';
const baseURL=process.env.BOTROOST_E2E_BASE_URL;
export default defineConfig({testDir:'./e2e',timeout:60_000,use:{baseURL,trace:'retain-on-failure'},projects:[{name:'chromium',use:{...devices['Desktop Chrome']}}]});
