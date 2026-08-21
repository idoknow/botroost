import {expect,test,type Page} from '@playwright/test';

const endpoint={id:'fixture-endpoint',name:'Campux production',providerId:'napcat',node:{id:'fixture-node',name:'jp09-napcat-reenroll'},generation:4,desired:{state:'running'},status:{node:'online',runtime:'ready',provider:'available',protocol:'connected',convergence:'converged'},activeOperationId:null};
const session={user:{id:'fixture-user',email:'ops@example.test',name:'Rock'},workspace:{id:'fixture-workspace',name:'Production'},role:'owner',permissions:['workspace:read','endpoint:read','endpoint:create','endpoint:start','endpoint:stop','endpoint:restart','node:read','node:create','provider:read','operation:read','audit:read','member:read','credential:read','settings:read'],capabilities:{operations:['create','start','stop','restart'],providers:{napcat:{enabled:true}}}};

async function mockProduct(page:Page,{failSave=false}:{failSave?:boolean}={}){
  let statusRequests=0;
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;let body:unknown={},status=200;
    if(path.endsWith('/auth/session'))body=session;
    else if(path.endsWith('/auth/csrf'))body={csrfToken:'fixture-csrf'};
    else if(failSave&&route.request().method()==='PUT'&&path.endsWith('/napcat/onebot/websockets')){status=500;body={error:{message:'Fixture save failed'}};}
    else if(path.endsWith('/endpoints/fixture-endpoint/napcat/status')){
      statusRequests+=1;
      body={qq:{uin:'960164003',online:true},onebot:{loginInfo:{user_id:960164003},config:{websocketClients:[{name:'Campux bridge',enable:true,url:'wss://app.campux.top/onebot/v11/ws',messagePostFormat:'array',reportSelfMessage:false,debug:false,heartInterval:30000,reconnectInterval:5000,tokenConfigured:true}],websocketServers:[]}}};
    }
    else if(path.endsWith('/endpoints/fixture-endpoint'))body=endpoint;
    else if(path.endsWith('/endpoints'))body={items:[endpoint],page:1,pageSize:25,total:1};
    else body={items:[],page:1,pageSize:25,total:0};
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  return ()=>statusRequests;
}

test('inbound server draft survives background status polling',async({page})=>{
  const statusRequests=await mockProduct(page);
  await page.goto('/endpoints/fixture-endpoint');
  await page.getByRole('tab',{name:'Connections'}).click();
  await expect(page.getByLabel('Client URL')).toHaveValue('wss://app.campux.top/onebot/v11/ws');
  const switchMetrics=await page.locator('[data-slot="switch"]').first().evaluate(element=>{const root=element.getBoundingClientRect(),thumb=element.querySelector('[data-slot="switch-thumb"]')?.getBoundingClientRect(),style=getComputedStyle(element);return {width:root.width,height:root.height,thumbWidth:thumb?.width??0,backgroundColor:style.backgroundColor}});
  expect(switchMetrics.width).toBeGreaterThanOrEqual(24);
  expect(switchMetrics.height).toBeGreaterThanOrEqual(14);
  expect(switchMetrics.thumbWidth).toBeGreaterThanOrEqual(12);
  expect(switchMetrics.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  await expect(page.getByRole('tab',{name:/Outbound clients/})).toHaveAttribute('data-state','active');
  await page.getByRole('tab',{name:/Inbound servers/}).click();
  await expect(page.getByLabel('Client URL')).toHaveCount(0);
  await page.getByRole('button',{name:'Add server'}).click();
  await expect(page.getByLabel('Server host')).toBeVisible({timeout:1000});
  await page.getByLabel('Server host').fill('127.0.0.1');
  await page.getByLabel('Server name').fill('Persistent inbound server');
  const requestsAfterDraft=statusRequests();
  await page.waitForTimeout(3300);
  expect(statusRequests()).toBeGreaterThan(requestsAfterDraft);
  await expect(page.getByLabel('Server host')).toHaveValue('127.0.0.1');
  await expect(page.getByLabel('Server name')).toHaveValue('Persistent inbound server');
  const boxes=await Promise.all(['Server name','Server host','Server port'].map(async label=>page.getByLabel(label).boundingBox()));
  expect(new Set(boxes.map(box=>Math.round(box!.y))).size).toBe(1);
  expect(Math.max(...boxes.map(box=>box!.width))-Math.min(...boxes.map(box=>box!.width))).toBeLessThan(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({path:'/tmp/botroost-ui-evidence/websocket-server-draft-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Discard changes'}).click();
  await expect(page.getByLabel('Server host')).toHaveCount(0);
});

test('inbound server editor stays within a 390px viewport',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await mockProduct(page);
  await page.goto('/endpoints/fixture-endpoint');
  await page.getByRole('tab',{name:'Connections'}).click();
  await expect(page.getByLabel('Client URL')).toBeVisible();
  await page.getByRole('tab',{name:/Inbound servers/}).click();
  await page.getByRole('button',{name:'Add server'}).click();
  await expect(page.getByLabel('Server port')).toBeVisible();
  expect(await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}))).toEqual({scrollWidth:390,clientWidth:390});
  await page.screenshot({path:'/tmp/botroost-ui-evidence/websocket-server-draft-mobile.png',fullPage:true});
});

test('failed save keeps the local server draft open',async({page})=>{
  await mockProduct(page,{failSave:true});
  await page.goto('/endpoints/fixture-endpoint');
  await page.getByRole('tab',{name:'Connections'}).click();
  await page.getByRole('tab',{name:/Inbound servers/}).click();
  await page.getByRole('button',{name:'Add server'}).click();
  await page.getByLabel('Server name').fill('Keep this draft');
  await page.getByRole('button',{name:'Save changes'}).click();
  await expect(page.getByText('Request failed (500)')).toBeVisible();
  await expect(page.getByLabel('Server name')).toHaveValue('Keep this draft');
});
