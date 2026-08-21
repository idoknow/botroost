import {expect,test} from '@playwright/test';

const live=process.env.LIVE_E2E==='1';
const email=process.env.BOTROOST_E2E_EMAIL;
const password=process.env.BOTROOST_E2E_PASSWORD;
const baseURL=process.env.BOTROOST_E2E_BASE_URL;
if(live&&(!email||!password||!baseURL))throw new Error('LIVE_E2E=1 requires BOTROOST_E2E_EMAIL, BOTROOST_E2E_PASSWORD, and BOTROOST_E2E_BASE_URL');

test.describe('live operator journey',()=>{
  test.skip(!live,'Set LIVE_E2E=1 to run live E2E');
  test('login, inspect a real endpoint, audit, persistence, logout',async({page})=>{
    const apiErrors:string[]=[];
    let collectApiErrors=true;
    page.on('response',response=>{if(collectApiErrors&&response.url().includes('/api/')&&response.status()>=400&&!(response.status()===404&&response.url().endsWith('/api/v1/disabled')))apiErrors.push(`${response.status()} ${response.url()}`)});
    await page.goto('/login');
    await page.getByLabel('Email').fill(email!);
    await page.getByLabel('Password').fill(password!);
    const loginResponse=page.waitForResponse(response=>response.url().includes('/api/v1/auth/login'));
    await page.getByRole('button',{name:'Sign in'}).click();
    expect((await loginResponse).ok()).toBe(true);
    await expect(page.getByRole('heading',{name:'Cluster'})).toBeVisible();
    await page.getByRole('link',{name:'Manage endpoints'}).click();
    const firstEndpoint=page.getByRole('table').getByRole('link').first();
    await expect(firstEndpoint).toBeVisible();
    const endpointName=(await firstEndpoint.textContent())?.trim();
    expect(endpointName).toBeTruthy();
    await firstEndpoint.click();
    await expect(page.getByRole('heading',{name:endpointName!})).toBeVisible();
    await page.getByRole('link',{name:'Audit'}).click();
    await expect(page.getByRole('heading',{name:'Audit events'})).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading',{name:'Audit events'})).toBeVisible();
    expect(apiErrors).toEqual([]);
    collectApiErrors=false;
    await page.getByRole('button',{name:'Log out'}).click();
    await expect(page.getByRole('heading',{name:'Sign in'})).toBeVisible();
  });
});
