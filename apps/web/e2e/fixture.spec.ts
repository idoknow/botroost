import {test,expect} from '@playwright/test';

test('local fixture operator journey runs without production secrets',async({page})=>{
  let authenticated=false;
  const endpoint={id:'fixture-endpoint',name:'Fixture fake',providerId:'fake',node:{id:'fixture-node',name:'fixture-agent'},generation:0,desired:{state:'stopped'},status:{node:'online',runtime:'ready',provider:'available',protocol:'connected',convergence:'converged'},activeOperationId:null};
  await page.route('**/api/v1/**',async route=>{const url=new URL(route.request().url()),path=url.pathname;let status=200,body:unknown={};if(path.endsWith('/auth/csrf'))body={csrfToken:'fixture-csrf'};else if(path.endsWith('/auth/login')){authenticated=true;body={ok:true}}else if(path.endsWith('/auth/session')){if(!authenticated){status=401;body={error:{code:'unauthorized'}}}else body={user:{id:'fixture-user',email:'fixture@example.test'},workspace:{id:'fixture-workspace',name:'Fixture'},role:'owner',permissions:['workspace:read','endpoint:read','endpoint:create','endpoint:start','node:read','node:create','operation:read','audit:read'],capabilities:{operations:['create','start'],providers:{fake:{enabled:true}}}}}else if(path.endsWith('/nodes'))body={items:[{id:'fixture-node',name:'fixture-agent',provider:'fake',lastHeartbeatAt:new Date().toISOString()}],page:1,pageSize:25,total:1};else if(path.endsWith('/endpoints'))body={items:[endpoint],page:1,pageSize:25,total:1};else if(path.endsWith('/workspaces/current/summary'))body={endpoints:1,operations:0};else if(path.endsWith('/auth/logout')){authenticated=false;status=204;body=''}else body={items:[],page:1,pageSize:25,total:0};await route.fulfill({status,contentType:status===204?undefined:'application/json',body:typeof body==='string'?body:JSON.stringify(body)})});
  await page.goto('/login');
  await page.getByLabel('Email').fill('fixture@example.test');
  await page.getByLabel('Password').fill('fixture-password');
  await page.getByRole('button',{name:'Sign in'}).click();
  await expect(page.getByText('Operational overview')).toBeVisible();
  await page.getByRole('link',{name:'Endpoints'}).click();
  await expect(page.getByText('Fixture fake')).toBeVisible();
  const headers=await page.locator('thead th').allTextContents();
  expect(headers.filter(header=>header==='Node')).toHaveLength(1);
  expect(headers).toContain('Node status');
  await page.getByRole('button',{name:'Log out'}).click();
  await expect(page.getByRole('heading',{name:'Sign in'})).toBeVisible();
});
