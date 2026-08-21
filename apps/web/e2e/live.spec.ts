import {expect,test,type Page} from '@playwright/test';

const live=process.env.LIVE_E2E==='1';
const email=process.env.BOTROOST_E2E_EMAIL;
const password=process.env.BOTROOST_E2E_PASSWORD;
const baseURL=process.env.BOTROOST_E2E_BASE_URL;
const fixtureName='ci-e2e-fixture';
if(live&&(!email||!password||!baseURL))throw new Error('LIVE_E2E=1 requires BOTROOST_E2E_EMAIL, BOTROOST_E2E_PASSWORD, and BOTROOST_E2E_BASE_URL');

async function ensureFixture(page:Page){
  return page.evaluate(async name=>{
    const encoded=document.cookie.split('; ').find(value=>value.startsWith('botroost_csrf='))?.split('=').slice(1).join('=');
    if(!encoded)throw new Error('missing CSRF cookie');
    const csrf=decodeURIComponent(encoded);
    const list=await fetch('/api/v1/endpoints');
    if(!list.ok)throw new Error(`fixture lookup failed: ${list.status}`);
    const existing=(await list.json() as {items:Array<{id:string;name:string}>}).items.find(item=>item.name===name);
    if(existing)return existing;
    const response=await fetch('/api/v1/endpoints',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({name,providerId:'fake'})});
    if(response.status!==201)throw new Error(`fixture creation failed: ${response.status}`);
    return response.json() as Promise<{id:string;name:string}>;
  },fixtureName);
}

async function restoreFixture(page:Page,endpointId:string){
  await page.evaluate(async({id,name})=>{
    const encoded=document.cookie.split('; ').find(value=>value.startsWith('botroost_csrf='))?.split('=').slice(1).join('=');
    if(!encoded)throw new Error('missing CSRF cookie');
    const csrf=decodeURIComponent(encoded);
    const wait=async(operationId:string)=>{
      for(let attempt=0;attempt<30;attempt++){
        const response=await fetch(`/api/v1/operations/${operationId}`);
        if(!response.ok)throw new Error(`fixture operation lookup failed: ${response.status}`);
        const operation=await response.json() as {status:string};
        if(!['queued','running'].includes(operation.status))return;
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      throw new Error('fixture cleanup operation timed out');
    };
    let endpoint=await (await fetch(`/api/v1/endpoints/${id}`)).json() as {generation:number;desired:{state:string};activeOperationId:string|null};
    if(endpoint.activeOperationId){await wait(endpoint.activeOperationId);endpoint=await (await fetch(`/api/v1/endpoints/${id}`)).json()}
    if(endpoint.desired.state!=='stopped'){
      const response=await fetch(`/api/v1/endpoints/${id}/operations`,{method:'POST',headers:{'content-type':'application/json','idempotency-key':`e2e-cleanup-${Date.now()}`,'x-csrf-token':csrf},body:JSON.stringify({action:'stop',expectedGeneration:endpoint.generation})});
      if(response.status!==202)throw new Error(`fixture stop failed: ${response.status}`);
      await wait((await response.json() as {id:string}).id);
    }
    const rename=await fetch(`/api/v1/endpoints/${id}`,{method:'PATCH',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({name})});
    if(!rename.ok)throw new Error(`fixture rename cleanup failed: ${rename.status}`);
  },{id:endpointId,name:fixtureName});
}

test.describe('live operator journey',()=>{
  test.skip(!live,'Set LIVE_E2E=1 to run live E2E');
  test('mutates, starts, persists, audits, and restores an isolated endpoint',async({page})=>{
    const apiErrors:string[]=[];
    let collectApiErrors=true;
    let endpointId:string|undefined;
    page.on('response',response=>{if(collectApiErrors&&response.url().includes('/api/')&&response.status()>=400&&!(response.status()===404&&response.url().endsWith('/api/v1/disabled')))apiErrors.push(`${response.status()} ${response.url()}`)});
    await page.goto('/login');
    await page.getByLabel('Email').fill(email!);
    await page.getByLabel('Password').fill(password!);
    const loginResponse=page.waitForResponse(response=>response.url().includes('/api/v1/auth/login'));
    await page.getByRole('button',{name:'Sign in'}).click();
    expect((await loginResponse).ok()).toBe(true);
    await expect(page.getByRole('heading',{name:'Cluster'})).toBeVisible();

    const mutatedName=`ci-e2e-active-${Date.now()}`;
    try{
      const fixture=await ensureFixture(page);
      endpointId=fixture.id;
      await restoreFixture(page,endpointId);
      await page.goto(`/endpoints/${endpointId}`);
      await page.getByLabel('Name').fill(mutatedName);
      const renameResponse=page.waitForResponse(response=>response.url().endsWith(`/api/v1/endpoints/${endpointId}`)&&response.request().method()==='PATCH');
      await page.getByRole('button',{name:'Rename'}).click();
      expect((await renameResponse).ok()).toBe(true);
      await page.reload();
      await expect(page.getByRole('heading',{name:mutatedName})).toBeVisible();

      const operationResponse=page.waitForResponse(response=>response.url().endsWith(`/api/v1/endpoints/${endpointId}/operations`)&&response.request().method()==='POST');
      await page.locator('.endpoint-heading').getByRole('button',{name:'Start',exact:true}).click();
      const started=await operationResponse;
      expect(started.status()).toBe(202);
      const operation=await started.json() as {id:string};
      await expect(page.getByRole('heading',{name:'Operation detail'})).toBeVisible();
      await expect(page.getByText('succeeded',{exact:true})).toBeVisible({timeout:30_000});
      const operationUrl=page.url();
      await page.reload();
      await expect(page).toHaveURL(operationUrl);
      await expect(page.getByText('succeeded',{exact:true})).toBeVisible();

      await page.getByRole('link',{name:'Audit'}).click();
      await expect(page.getByRole('heading',{name:'Audit events'})).toBeVisible();
      const queuedAudit=await page.evaluate(async operationId=>{
        const response=await fetch('/api/v1/audit');
        if(!response.ok)throw new Error(`audit lookup failed: ${response.status}`);
        const events=(await response.json() as {items:Array<{action:string;resource_id:string}>}).items;
        return events.find(event=>event.action==='operation.queued'&&event.resource_id===operationId)??null;
      },operation.id);
      expect(queuedAudit).not.toBeNull();
      expect(apiErrors).toEqual([]);
    }finally{
      if(endpointId)await restoreFixture(page,endpointId);
    }

    collectApiErrors=false;
    await page.getByRole('button',{name:'Log out'}).click();
    await expect(page.getByRole('heading',{name:'Sign in'})).toBeVisible();
  });
});
