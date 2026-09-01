import {expect,test} from '@playwright/test';

const endpoint={
  id:'endpoint-fast-status',name:'Fast status endpoint',providerId:'napcat',
  node:{id:'node-1',name:'jp09-agent'},generation:1,desired:{state:'running'},
  status:{node:'online',runtime:'ready',provider:'available',protocol:'connected',convergence:'converged'},
  activeOperationId:null,metadata:{qq:{uin:'10001',online:true}},
};
const session={
  user:{id:'owner',email:'owner@example.test',name:'Owner'},workspace:{id:'workspace',name:'Production'},role:'owner',
  permissions:['workspace:read','endpoint:read','endpoint:create','endpoint:start','node:read','operation:read'],
  capabilities:{operations:['create','start'],providers:{napcat:{enabled:true}}},
};

const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

test('endpoint status bootstraps concurrently and manual refresh keeps the current status visible',async({page})=>{
  let sessionFinished=false;
  let endpointRequests=0;
  let endpointStartedBeforeSessionFinished=false;
  let failNextEndpointRequest=false;

  await page.route('**/api/v1/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(path.endsWith('/auth/session')){
      await wait(500);
      sessionFinished=true;
      return json(session);
    }
    if(path.endsWith('/endpoints')){
      endpointRequests+=1;
      if(!sessionFinished)endpointStartedBeforeSessionFinished=true;
      if(endpointRequests>1)await wait(500);
      if(failNextEndpointRequest){failNextEndpointRequest=false;return json({error:{message:'temporary probe failure'}},500)}
      return json({items:[endpoint],page:1,pageSize:25,total:1});
    }
    if(path.endsWith('/nodes'))return json({items:[endpoint.node],page:1,pageSize:25,total:1});
    if(path.endsWith('/workspaces/current/summary'))return json({endpoints:1,operations:0});
    return json({items:[],page:1,pageSize:25,total:0});
  });

  await page.goto('/endpoints');
  const sidebarEndpoint=page.locator('.endpoint-entry').filter({hasText:'Fast status endpoint'});
  const tableEndpoint=page.locator('tbody').getByText('Fast status endpoint');
  await expect(sidebarEndpoint).toBeVisible();
  await expect(tableEndpoint).toBeVisible();
  expect(endpointStartedBeforeSessionFinished).toBe(true);
  expect(endpointRequests).toBe(2);

  const refresh=page.getByRole('button',{name:'Refresh endpoint status'});
  await expect(refresh).toBeVisible();
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(sidebarEndpoint).toBeVisible();
  await expect.poll(()=>endpointRequests).toBeGreaterThan(1);
  await expect(refresh).toBeEnabled();

  failNextEndpointRequest=true;
  await refresh.click();
  await expect(refresh).toBeDisabled();
  await expect(refresh).toBeEnabled();
  await expect(tableEndpoint).toBeVisible();
  await expect(page.getByText('temporary probe failure')).toHaveCount(0);

  await page.setViewportSize({width:320,height:760});
  await expect(refresh).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
});
