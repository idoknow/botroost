import {test,expect,type Page} from '@playwright/test';
import fs from 'node:fs';

const endpoint={id:'fixture-endpoint',name:'Campux production',providerId:'napcat',node:{id:'fixture-node',name:'jp09-napcat-reenroll'},generation:4,desired:{state:'running'},status:{node:'online',runtime:'ready',provider:'available',protocol:'connected',convergence:'converged'},activeOperationId:null,metadata:{qq:{uin:'960164003',online:true}}};
const session={user:{id:'fixture-user',email:'ops@example.test',name:'Rock'},workspace:{id:'fixture-workspace',name:'Production'},role:'owner',permissions:['workspace:read','endpoint:read','endpoint:create','endpoint:start','endpoint:stop','endpoint:restart','node:read','node:create','provider:read','operation:read','audit:read','member:read','credential:read','settings:read'],capabilities:{operations:['create','start','stop','restart'],providers:{napcat:{enabled:true}}}};
const traffic={status:'ok',source:'napcat.container_logs',privacy:'aggregate_only',observedAt:'2026-08-21T09:00:05.000Z',sampleIntervalSeconds:5,oneMinute:{inbound:5,outbound:2,total:7,bytes:860},fiveMinutes:{inbound:18,outbound:6,total:24,bytes:3360},buckets:[{startedAt:'2026-08-21T08:59:10.000Z',inbound:1,outbound:0,total:1},{startedAt:'2026-08-21T08:59:20.000Z',inbound:2,outbound:1,total:3},{startedAt:'2026-08-21T08:59:30.000Z',inbound:0,outbound:1,total:1},{startedAt:'2026-08-21T08:59:40.000Z',inbound:3,outbound:0,total:3},{startedAt:'2026-08-21T08:59:50.000Z',inbound:1,outbound:0,total:1},{startedAt:'2026-08-21T09:00:00.000Z',inbound:5,outbound:2,total:7}],recent:[{at:'2026-08-21T09:00:04.000Z',direction:'inbound',scope:'group',bytes:120},{at:'2026-08-21T09:00:01.000Z',direction:'outbound',scope:'private',bytes:76}],recentConnections:[{at:'2026-08-21T09:00:03.000Z',transport:'websocket-client',status:'reconnecting'}]};
const containerLogs=Array.from({length:120},(_,index)=>`2026-08-21T09:00:${String(index%60).padStart(2,'0')}Z fixture container log ${index+1}`).join('\n');

async function mockProduct(page:Page,{loggedIn=true}:{loggedIn?:boolean}={}){
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname,sampledAt=new Date().toISOString();let body:unknown={};
    if(path.endsWith('/auth/csrf'))body={csrfToken:'fixture-csrf'};
    else if(path.endsWith('/auth/session'))body=session;
    else if(path.endsWith('/workspaces/current/summary'))body={endpoints:2,operations:14};
    else if(path.endsWith('/endpoints/fixture-endpoint/napcat/status'))body={qq:loggedIn?{uin:'960164003',nickname:'不懂问我',online:true}:null,onebot:{...(loggedIn?{status:{online:true},loginInfo:{user_id:960164003,nickname:'不懂问我'},probes:{get_status:{ok:true,durationMs:5,error:null},get_login_info:{ok:true,durationMs:6,error:null},get_version_info:{ok:true,durationMs:7,error:null},get_friend_list:{ok:true,durationMs:841,error:null},get_group_list:{ok:true,durationMs:18,error:null}},directory:{observedAt:'2026-08-21T09:00:00.000Z',friends:{count:1,truncated:false,observedAt:'2026-08-21T09:00:00.000Z',items:[{user_id:10001,nickname:'Alice',remark:'Platform'}],probe:{ok:true,durationMs:841,error:null}},groups:{count:1,truncated:false,observedAt:'2026-08-21T09:00:00.000Z',items:[{group_id:20001,group_name:'Botroost users',member_count:128}],probe:{ok:true,durationMs:18,error:null}}}}:{}),version:{app_name:'NapCat.OneBot',app_version:'4.18.19'},config:{websocketClients:[{name:'Campux bridge',enable:true,url:'wss://app.campux.top/onebot/v11/ws?key=fixture',messagePostFormat:'array',reportSelfMessage:false,debug:false,heartInterval:30000,reconnectInterval:5000,tokenConfigured:true}],websocketServers:[]}},traffic,freshness:{fresh:true,observationAt:sampledAt,nodeHeartbeatAt:sampledAt,checkedAt:sampledAt,staleAfterSeconds:15}};
    else if(path.endsWith('/endpoints/fixture-endpoint/napcat/login-qrcode'))body={qrcode:'https://example.test/qq-login'};
    else if(path.endsWith('/endpoints/fixture-endpoint/napcat/container-logs'))body={id:'fixture-log-operation',status:'queued'};
    else if(path.endsWith('/operations/fixture-log-operation'))body={id:'fixture-log-operation',status:'succeeded',result:{metadata:{logs:{text:containerLogs}}}};
    else if(path.endsWith('/endpoints/fixture-endpoint'))body=endpoint;
    else if(path.endsWith('/endpoints'))body={items:[{...endpoint,metadata:{qq:loggedIn?{uin:'960164003',online:true}:null}}],page:1,pageSize:25,total:1};
    else if(path.endsWith('/nodes'))body={items:[endpoint.node],page:1,pageSize:25,total:1};
    else if(path.endsWith('/providers'))body={items:[{id:'napcat',capabilities:['runtime','onebot'],availability:{enabled:true}}],page:1,pageSize:25,total:1};
    else body={items:[],page:1,pageSize:25,total:0};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
}

test('endpoint tab content scrolls without moving the page chrome',async({page})=>{
  await page.setViewportSize({width:1440,height:800});
  await mockProduct(page);
  await page.goto('/endpoints/fixture-endpoint');
  await page.getByRole('tab',{name:'Logs'}).click();
  await page.getByRole('button',{name:'Load container logs'}).click();
  await expect(page.getByText('fixture container log 120')).toBeAttached();

  const panel=page.locator('.endpoint-tab-panel[data-state="active"]');
  const before=await page.evaluate(()=>({
    pageScrollY:window.scrollY,
    pageScrollHeight:document.documentElement.scrollHeight,
    pageClientHeight:document.documentElement.clientHeight,
    headingTop:document.querySelector('.endpoint-heading')!.getBoundingClientRect().top,
    tabsTop:document.querySelector('.endpoint-tabs-list')!.getBoundingClientRect().top,
  }));
  expect(before.pageScrollY).toBe(0);
  expect(before.pageScrollHeight).toBe(before.pageClientHeight);
  await expect(panel).toHaveJSProperty('scrollTop',0);
  expect(await panel.evaluate(element=>element.scrollHeight>element.clientHeight)).toBe(true);

  await panel.evaluate(element=>element.scrollTop=element.scrollHeight);
  await expect.poll(()=>panel.evaluate(element=>element.scrollTop)).toBeGreaterThan(0);
  const after=await page.evaluate(()=>({
    pageScrollY:window.scrollY,
    headingTop:document.querySelector('.endpoint-heading')!.getBoundingClientRect().top,
    tabsTop:document.querySelector('.endpoint-tabs-list')!.getBoundingClientRect().top,
  }));
  expect(after).toEqual({pageScrollY:0,headingTop:before.headingTop,tabsTop:before.tabsTop});
});

const viewports=[{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844},{name:'narrow',width:320,height:780}] as const;
for(const colorScheme of ['light','dark'] as const){
  for(const viewport of viewports){
    test(`visual fixture ${colorScheme} ${viewport.name}`,async({page})=>{
      await page.addInitScript(scheme=>localStorage.setItem('botroost-theme',scheme),colorScheme);await page.setViewportSize({width:viewport.width,height:viewport.height});await mockProduct(page);await page.goto('/endpoints/fixture-endpoint');await expect(page.getByRole('heading',{name:'Campux production'})).toBeVisible();await expect(page.locator('html')).toHaveAttribute('data-theme',colorScheme);
      await expect(page.getByText('Identity and login state')).toBeVisible();await expect(page.getByText('Protocol action support')).toHaveCount(0);
      fs.mkdirSync('test-results/ui-evidence',{recursive:true});
      await page.screenshot({path:`test-results/ui-evidence/endpoint-overview-${colorScheme}-${viewport.name}.png`,fullPage:true});
      await page.getByRole('tab',{name:'Traffic'}).click();await expect(page.getByText('Real-time message traffic')).toBeVisible();expect(await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}))).toEqual({scrollWidth:viewport.width,clientWidth:viewport.width});await page.screenshot({path:`test-results/ui-evidence/endpoint-traffic-${colorScheme}-${viewport.name}.png`,fullPage:true});
      await page.getByRole('tab',{name:'QQ data'}).click();await expect(page.getByRole('tab',{name:'Friends (1)'})).toBeVisible();await page.screenshot({path:`test-results/ui-evidence/endpoint-qq-data-${colorScheme}-${viewport.name}.png`,fullPage:true});
      await page.getByRole('tab',{name:'OneBot'}).click();await expect(page.getByText('Protocol action support')).toBeVisible();await expect(page.getByText('NapCat OneBot implementation')).toHaveCount(0);await expect(page.getByText('API available')).toHaveCount(0);await expect(page.getByText('OneBot connecting')).toHaveCount(0);await page.screenshot({path:`test-results/ui-evidence/endpoint-onebot-${colorScheme}-${viewport.name}.png`,fullPage:true});
      await page.getByRole('tab',{name:'Connections'}).click();
      await expect(page.locator('input[value="wss://app.campux.top/onebot/v11/ws?key=fixture"]')).toBeVisible();
      expect(await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}))).toEqual({scrollWidth:viewport.width,clientWidth:viewport.width});
      await page.screenshot({path:`test-results/ui-evidence/endpoint-${colorScheme}-${viewport.name}.png`,fullPage:true});
    });
  }
}

for(const viewport of viewports){
  test(`QR login layout ${viewport.name}`,async({page})=>{
    await page.setViewportSize({width:viewport.width,height:viewport.height});await mockProduct(page,{loggedIn:false});await page.goto('/endpoints/fixture-endpoint');
    const qr=page.getByRole('img',{name:'NapCat QR code'});await expect(qr).toBeVisible();expect((await qr.boundingBox())!.width).toBeGreaterThanOrEqual(160);
    expect(await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}))).toEqual({scrollWidth:viewport.width,clientWidth:viewport.width});
    fs.mkdirSync('test-results/ui-evidence',{recursive:true});await page.screenshot({path:`test-results/ui-evidence/endpoint-qr-${viewport.name}.png`,fullPage:true});
  });
}
