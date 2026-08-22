import {expect,test,type Page} from '@playwright/test';

const live=process.env.LIVE_E2E==='1';
const email=process.env.BOTROOST_E2E_EMAIL;
const password=process.env.BOTROOST_E2E_PASSWORD;
const baseURL=process.env.BOTROOST_E2E_BASE_URL;
const fixtureScope=(process.env.BOTROOST_E2E_FIXTURE_SCOPE??process.env.GITHUB_REF_NAME??'local').replace(/[^a-zA-Z0-9-]+/g,'-').slice(0,64);
const fixtureName=`ci-e2e-${fixtureScope}`;
if(live&&(!email||!password||!baseURL))throw new Error('LIVE_E2E=1 requires BOTROOST_E2E_EMAIL, BOTROOST_E2E_PASSWORD, and BOTROOST_E2E_BASE_URL');

async function createFixture(page:Page,name:string){
  return page.evaluate(async fixtureName=>{
    const encoded=document.cookie.split('; ').find(value=>value.startsWith('botroost_csrf='))?.split('=').slice(1).join('=');
    if(!encoded)throw new Error('missing CSRF cookie');
    const csrf=decodeURIComponent(encoded);
    const response=await fetch('/api/v1/endpoints',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':csrf},body:JSON.stringify({name:fixtureName,providerId:'fake'})});
    if(response.status!==201)throw new Error(`fixture creation failed: ${response.status}`);
    return response.json() as Promise<{id:string;name:string}>;
  },name);
}

async function staleFixtureIds(page:Page,prefix:string){
  return page.evaluate(async fixturePrefix=>{
    const response=await fetch('/api/v1/endpoints');
    if(!response.ok)throw new Error(`fixture lookup failed: ${response.status}`);
    return (await response.json() as {items:Array<{id:string;name:string}>}).items
      .filter(item=>item.name.startsWith(`${fixturePrefix}-`))
      .map(item=>item.id);
  },prefix);
}

async function deleteFixture(page:Page,endpointId:string){
  await page.evaluate(async id=>{
    const encoded=document.cookie.split('; ').find(value=>value.startsWith('botroost_csrf='))?.split('=').slice(1).join('=');
    if(!encoded)throw new Error('missing CSRF cookie');
    const csrf=decodeURIComponent(encoded);
    const wait=async(operationId:string)=>{
      for(let attempt=0;attempt<30;attempt++){
        const response=await fetch(`/api/v1/operations/${operationId}`);
        if(!response.ok)throw new Error(`fixture operation lookup failed: ${response.status}`);
        const operation=await response.json() as {status:string};
        if(!['queued','running'].includes(operation.status)){
          if(operation.status!=='succeeded')throw new Error(`fixture operation ended ${operation.status}`);
          return;
        }
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      throw new Error('fixture cleanup operation timed out');
    };
    const endpointResponse=await fetch(`/api/v1/endpoints/${id}`);
    if(endpointResponse.status===404)return;
    if(!endpointResponse.ok)throw new Error(`fixture lookup failed: ${endpointResponse.status}`);
    let endpoint=await endpointResponse.json() as {generation:number;activeOperationId:string|null};
    if(endpoint.activeOperationId){
      await wait(endpoint.activeOperationId);
      const refreshed=await fetch(`/api/v1/endpoints/${id}`);
      if(refreshed.status===404)return;
      if(!refreshed.ok)throw new Error(`fixture refresh failed: ${refreshed.status}`);
      endpoint=await refreshed.json();
    }
    const response=await fetch(`/api/v1/endpoints/${id}`,{method:'DELETE',headers:{'content-type':'application/json','idempotency-key':`e2e-delete-${Date.now()}`,'x-csrf-token':csrf},body:JSON.stringify({expectedGeneration:endpoint.generation})});
    if(response.status===404)return;
    if(response.status!==202)throw new Error(`fixture delete failed: ${response.status}`);
    await wait((await response.json() as {id:string}).id);
    const deleted=await fetch(`/api/v1/endpoints/${id}`);
    if(deleted.status!==404)throw new Error(`fixture remained visible after delete: ${deleted.status}`);
  },endpointId);
}

test.describe('live operator journey',()=>{
  test.skip(!live,'Set LIVE_E2E=1 to run live E2E');
  let cleanupEndpointId:string|undefined;
  test.afterEach(async({page},testInfo)=>{
    testInfo.setTimeout(70_000);
    if(cleanupEndpointId)await deleteFixture(page,cleanupEndpointId);
    cleanupEndpointId=undefined;
  });
  test('mutates, starts, persists, audits, and deletes an isolated endpoint',async({page})=>{
    test.setTimeout(120_000);
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

    for(const staleId of await staleFixtureIds(page,fixtureName))await deleteFixture(page,staleId);

    const runFixtureName=`${fixtureName}-${Date.now()}`;
    const mutatedName=`${fixtureName}-active-${Date.now()}`;
    const fixture=await createFixture(page,runFixtureName);
    const endpointId=fixture.id;
    cleanupEndpointId=endpointId;
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

      await page.getByRole('link',{name:/^(Activity|Audit)$/}).click();
      const auditTab=page.getByRole('tab',{name:/Audit log/});
      if(await auditTab.count())await auditTab.click();
      await expect(page.getByRole('heading',{name:'Audit events'})).toBeVisible();
      const queuedAudit=await page.evaluate(async operationId=>{
        const response=await fetch('/api/v1/audit');
        if(!response.ok)throw new Error(`audit lookup failed: ${response.status}`);
        const events=(await response.json() as {items:Array<{action:string;resource_id:string}>}).items;
        return events.find(event=>event.action==='operation.queued'&&event.resource_id===operationId)??null;
      },operation.id);
      expect(queuedAudit).not.toBeNull();
      expect(apiErrors).toEqual([]);
    collectApiErrors=false;
    await page.getByRole('button',{name:'Log out'}).click();
    await expect(page.getByRole('heading',{name:'Sign in'})).toBeVisible();
  });
});
