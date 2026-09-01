import {mkdir} from 'node:fs/promises';
import {test,expect,type Page} from '@playwright/test';

const endpoint={id:'fixture-endpoint',name:'Campux production',providerId:'napcat',node:{id:'fixture-node',name:'jp09-napcat-reenroll',provider:'napcat'},generation:4,desired:{state:'running'},status:{node:'online',runtime:'ready',provider:'available',protocol:'connected',convergence:'converged'},activeOperationId:null,activeOperation:null,metadata:{qq:{uin:'960164003',online:true}}};
const session={user:{id:'fixture-user',email:'ops@example.test',name:'Rock'},workspace:{id:'fixture-workspace',name:'Production'},role:'owner',permissions:['workspace:read','endpoint:read','endpoint:create','endpoint:delete','endpoint:start','endpoint:stop','endpoint:restart','node:read','node:create','provider:read','operation:read','audit:read','member:read','settings:read'],capabilities:{operations:['create','delete','start','stop','restart'],providers:{napcat:{enabled:true}}}};

async function mockProduct(page:Page,{failSave=false,failDelete=false,loggedIn=true,directorySize=1,startupProgress=false}:{failSave?:boolean;failDelete?:boolean;loggedIn?:boolean;directorySize?:number;startupProgress?:boolean}={}){
  const friends=Array.from({length:directorySize},(_,index)=>({user_id:index+7,nickname:directorySize===1?'Friend':`Friend ${index+1}`}));
  let statusRequests=0;
  let endpointRequests=0;
  let deleteRequests=0;
  let deletePayload:unknown;
  let endpointDeleted=false;
  let startupStartedAt:number|undefined;
  let failStatus=false;
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;let body:unknown={},status=200;
    if(path.endsWith('/auth/session'))body=session;
    else if(path.endsWith('/auth/csrf'))body={csrfToken:'fixture-csrf'};
    else if(route.request().method()==='DELETE'&&path.endsWith('/endpoints/fixture-endpoint')){deleteRequests+=1;deletePayload=route.request().postDataJSON();if(failDelete){status=500;body={error:{message:'Fixture delete failed'}};}else{status=202;body={id:'delete-operation',endpointId:endpoint.id,action:'delete',status:'queued',generation:5};}}
    else if(path.endsWith('/operations/delete-operation')){endpointDeleted=true;body={id:'delete-operation',endpointId:endpoint.id,action:'delete',status:'succeeded',generation:5};}
    else if(failSave&&route.request().method()==='PUT'&&path.endsWith('/napcat/onebot/websockets')){status=500;body={error:{message:'Fixture save failed'}};}
    else if(path.endsWith('/endpoints/fixture-endpoint/napcat/status')){
      statusRequests+=1;
      if(failStatus){status=500;body={error:{message:'Fixture status failed'}};}
      else{const sampledAt=new Date().toISOString();body={qq:loggedIn?{uin:'960164003',online:true}:null,onebot:{...(loggedIn?{loginInfo:{user_id:960164003},status:{online:true},version:{app_name:'NapCat.OneBot11',app_version:'4.18.19'},probes:{get_status:{ok:true,durationMs:5,error:null},get_login_info:{ok:true,durationMs:6,error:null},get_version_info:{ok:true,durationMs:7,error:null},get_friend_list:{ok:true,durationMs:841,error:null},get_group_list:{ok:true,durationMs:18,error:null}},directory:{observedAt:'2026-08-21T09:00:00.000Z',friends:{count:directorySize,truncated:false,observedAt:'2026-08-21T09:00:00.000Z',items:friends,probe:{ok:true,durationMs:841,error:null}},groups:{count:1,truncated:false,observedAt:'2026-08-21T09:00:00.000Z',items:[{group_id:8,group_name:'Group'}],probe:{ok:true,durationMs:18,error:null}}}}:{}),config:{websocketClients:[{name:'Campux bridge',enable:true,url:'wss://app.campux.top/onebot/v11/ws',messagePostFormat:'array',reportSelfMessage:false,debug:false,heartInterval:30000,reconnectInterval:5000,tokenConfigured:true}],websocketServers:[]}},traffic:{status:'ok',source:'napcat.container_logs',privacy:'aggregate_only',observedAt:sampledAt,sampleIntervalSeconds:5,oneMinute:{inbound:1,outbound:1,total:2,bytes:196},fiveMinutes:{inbound:4,outbound:2,total:6,bytes:588},buckets:[{startedAt:'2026-08-21T08:59:10.000Z',inbound:0,outbound:0,total:0},{startedAt:'2026-08-21T08:59:20.000Z',inbound:1,outbound:0,total:1},{startedAt:'2026-08-21T08:59:30.000Z',inbound:0,outbound:1,total:1},{startedAt:'2026-08-21T08:59:40.000Z',inbound:2,outbound:0,total:2},{startedAt:'2026-08-21T08:59:50.000Z',inbound:0,outbound:0,total:0},{startedAt:'2026-08-21T09:00:00.000Z',inbound:1,outbound:1,total:2}],recent:[{at:'2026-08-21T09:00:04.000Z',direction:'inbound',scope:'group',bytes:120},{at:'2026-08-21T09:00:01.000Z',direction:'outbound',scope:'private',bytes:76}],recentConnections:[{at:'2026-08-21T09:00:03.000Z',transport:'websocket-client',status:'reconnecting'}]},freshness:{fresh:true,observationAt:sampledAt,nodeHeartbeatAt:sampledAt,checkedAt:sampledAt,staleAfterSeconds:15}};}
    }
    else if(path.endsWith('/endpoints/fixture-endpoint/napcat/login-qrcode'))body={qrcode:'https://example.test/qq-login'};
    else if(path.endsWith('/endpoints/fixture-endpoint')){if(endpointDeleted){status=404;body={error:{message:'Unavailable'}}}else if(startupProgress){startupStartedAt??=Date.now();const stageIndex=Math.floor((Date.now()-startupStartedAt)/1500),stages=[{phase:'inspecting-runtime',percent:25,message:'Inspecting existing runtime'},{phase:'creating-container',percent:55,message:'Creating NapCat container'},{phase:'probing-provider',percent:85,message:'Waiting for NapCat runtime readiness'}];if(stageIndex<stages.length){const progress={...stages[stageIndex]!,sequence:stageIndex+1,updatedAt:new Date().toISOString()};body={...endpoint,activeOperationId:'start-operation',activeOperation:{id:'start-operation',action:'start',status:'running',progress,createdAt:new Date(startupStartedAt).toISOString(),updatedAt:new Date().toISOString()}}}else body=endpoint;}else body=endpoint;}
    else if(path.endsWith('/nodes/enrollment-tokens')&&route.request().method()==='POST')body={token:'fixture-enrollment-token'};
    else if(path.endsWith('/workspaces/current/settings/alerts'))body={graceSeconds:180,targets:[],defaults:{offlineTargetIds:[],recoveryTargetIds:[]},endpoints:[{id:endpoint.id,name:endpoint.name,providerId:endpoint.providerId,offlineTargetIds:[],recoveryTargetIds:[]}]};
    else if(path.endsWith('/nodes'))body={items:[endpoint.node],page:1,pageSize:25,total:1};
    else if(path.endsWith('/endpoints')){endpointRequests+=1;const items=endpointDeleted?[]:[endpoint,{...endpoint,id:'fixture-needs-login',name:'Needs QQ login',metadata:{qq:{online:false},login:{qrcode:'https://example.test/qq-login'}}},{...endpoint,id:'fixture-unreachable',name:'Unreachable endpoint',status:{...endpoint.status,node:'offline'},metadata:{qq:{uin:'10000',online:true}}},{...endpoint,id:'fixture-unknown',name:'Unknown QQ status',metadata:{qq:{uin:'22222'}}}];body={items,page:1,pageSize:25,total:items.length};}
    else body={items:[],page:1,pageSize:25,total:0};
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  return {statusRequests:()=>statusRequests,endpointRequests:()=>endpointRequests,deleteRequests:()=>deleteRequests,deletePayload:()=>deletePayload,failStatus:()=>{failStatus=true}};
}

test.beforeEach(async()=>{await mkdir('test-results/ui-evidence',{recursive:true})});


test('endpoint detail manually refreshes both endpoint and NapCat status',async({page})=>{
  const fixture=await mockProduct(page);
  await page.goto('/endpoints/fixture-endpoint');
  const refresh=page.getByRole('button',{name:'Refresh this endpoint status'});
  await expect(refresh).toBeVisible();
  const endpointBefore=fixture.endpointRequests();
  const statusBefore=fixture.statusRequests();
  await refresh.click();
  await expect.poll(()=>fixture.endpointRequests()).toBeGreaterThan(endpointBefore);
  await expect.poll(()=>fixture.statusRequests()).toBeGreaterThan(statusBefore);
});

test('inbound server draft survives background status polling',async({page})=>{
  const {statusRequests}=await mockProduct(page);
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
  await page.screenshot({path:'test-results/ui-evidence/websocket-server-draft-desktop.png',fullPage:true});
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
  await page.screenshot({path:'test-results/ui-evidence/websocket-server-draft-mobile.png',fullPage:true});
});

test('failed save keeps the local server draft open',async({page})=>{
  await mockProduct(page,{failSave:true});
  await page.goto('/endpoints/fixture-endpoint');
  await page.getByRole('tab',{name:'Connections'}).click();
  await page.getByRole('tab',{name:/Inbound servers/}).click();
  await page.getByRole('button',{name:'Add server'}).click();
  await page.getByLabel('Server name').fill('Keep this draft');
  await page.getByRole('button',{name:'Save changes'}).click();
  await expect(page.getByText('Fixture save failed')).toBeVisible();
  await expect(page.getByLabel('Server name')).toHaveValue('Keep this draft');
});

test('endpoint lifecycle actions live in the title row instead of Settings',async({page})=>{
  await mockProduct(page);
  await page.goto('/endpoints/fixture-endpoint');
  const heading=page.locator('.endpoint-heading');
  await expect(heading.getByRole('button',{name:'Start',exact:true})).toBeVisible();
  await expect(heading.getByRole('button',{name:'Stop',exact:true})).toBeVisible();
  await expect(heading.getByRole('button',{name:'Restart',exact:true})).toBeVisible();
  expect(await heading.evaluate(element=>getComputedStyle(element).flexDirection)).toBe('row');
  await page.getByRole('tab',{name:'Settings'}).click();
  const settings=page.locator('[role="tabpanel"][data-state="active"]');
  await expect(settings.getByRole('button',{name:'Start'})).toHaveCount(0);
  await expect(settings.getByRole('button',{name:'Stop'})).toHaveCount(0);
  await expect(settings.getByRole('button',{name:'Restart'})).toHaveCount(0);
});

test('shows live endpoint startup phases and clears the activity after completion',async({page},testInfo)=>{
  await page.setViewportSize({width:320,height:844});
  await mockProduct(page,{startupProgress:true});
  await page.goto('/endpoints/fixture-endpoint');
  const activity=page.getByRole('status',{name:'Starting endpoint'});
  await expect(activity.getByText('Inspecting existing runtime')).toBeVisible();
  await expect(activity.getByRole('progressbar',{name:'Operation progress'})).toHaveJSProperty('value',25);
  await expect(activity.getByText('Creating NapCat container')).toBeVisible({timeout:2500});
  await expect(activity.getByRole('progressbar',{name:'Operation progress'})).toHaveJSProperty('value',55);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth===document.documentElement.clientWidth)).toBe(true);
  const detailLinkBox=await activity.getByRole('link',{name:'View operation details'}).boundingBox(),tabbarBox=await page.locator('.mobile-tabbar').boundingBox();
  expect(detailLinkBox).not.toBeNull();expect(tabbarBox).not.toBeNull();expect(detailLinkBox!.y+detailLinkBox!.height).toBeLessThanOrEqual(tabbarBox!.y);
  await page.screenshot({path:testInfo.outputPath('endpoint-startup-progress-320.png'),fullPage:true});
  await expect(activity).toBeHidden({timeout:5000});
});

test('create endpoint draft survives sidebar status polling',async({page},testInfo)=>{
  await page.setViewportSize({width:320,height:760});
  const fixture=await mockProduct(page);
  await page.goto('/endpoints');
  await page.getByRole('button',{name:'Create endpoint'}).click();
  const chooser=page.getByRole('dialog',{name:'Create endpoint'});
  await expect(chooser.getByText('Choose the runtime integration that will host this OneBot endpoint.')).toBeVisible();
  await expect(chooser.locator('[data-slot="dialog-header"]')).toBeVisible();
  await expect(chooser.locator('[data-slot="dialog-footer"]')).toBeVisible();
  await chooser.getByRole('button',{name:'NapCat'}).click();
  const dialog=page.getByRole('dialog',{name:'Configure endpoint'});
  await dialog.getByLabel('Node').selectOption('fixture-node');
  await dialog.getByLabel('Name').fill('Persistent endpoint draft');
  const requestsBefore=fixture.endpointRequests();
  await expect.poll(fixture.endpointRequests,{timeout:5000}).toBeGreaterThan(requestsBefore);
  await expect(dialog.getByLabel('Name')).toHaveValue('Persistent endpoint draft');
  await expect(dialog.getByLabel('Node')).toHaveValue('fixture-node');
  await expect(dialog.locator('.modal-body')).toBeVisible();
  const geometry=await dialog.evaluate(element=>{const rect=element.getBoundingClientRect(),body=element.querySelector('.modal-body')!;return{left:rect.left,right:rect.right,viewport:innerWidth,bodyPadding:getComputedStyle(body).paddingLeft,scrollWidth:document.documentElement.scrollWidth}});
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.bodyPadding).toBe('20px');
  expect(geometry.scrollWidth).toBe(geometry.viewport);
  await page.screenshot({path:testInfo.outputPath('create-endpoint-dialog-320.png'),fullPage:true});
});

test('agent enrollment token uses the shared Campux dialog structure',async({page})=>{
  await mockProduct(page);
  await page.goto('/nodes');
  await page.getByRole('button',{name:'Generate enrollment token'}).click();
  const dialog=page.getByRole('dialog',{name:'One-time enrollment token'});
  await expect(dialog.getByText('Copy this token now. It will not be shown again.')).toBeVisible();
  await expect(dialog.locator('.enrollment-token')).toHaveText('fixture-enrollment-token');
  await expect(dialog.locator('[data-slot="dialog-header"]')).toBeVisible();
  await expect(dialog.locator('.modal-body')).toBeVisible();
  await expect(dialog.locator('[data-slot="dialog-footer"]')).toBeVisible();
  await dialog.getByRole('button',{name:'Done'}).click();
  await expect(dialog).toBeHidden();
});

test('deletes an endpoint only after explicit destructive confirmation and convergence',async({page})=>{
  const fixture=await mockProduct(page);
  await page.goto('/endpoints/fixture-endpoint');
  await page.getByRole('tab',{name:'Settings'}).click();
  await page.getByRole('button',{name:'Delete endpoint'}).click();
  const dialog=page.getByRole('dialog',{name:'Delete endpoint'});
  await expect(dialog.getByText('Campux production')).toBeVisible();
  await expect(dialog.getByText(/container and stored endpoint data/i)).toBeVisible();
  await expect(dialog.getByText('Remove the managed runtime and its persisted endpoint data.')).toBeVisible();
  await expect(dialog.locator('[data-slot="dialog-footer"]')).toBeVisible();
  const confirmation=dialog.getByLabel('Type endpoint name to confirm');
  const remove=dialog.getByRole('button',{name:'Delete endpoint'});
  await expect(remove).toHaveAttribute('data-variant','destructive');
  await expect(remove).toBeDisabled();
  await confirmation.fill('wrong endpoint');
  await expect(remove).toBeDisabled();
  await confirmation.fill('Campux production');
  await expect(remove).toBeEnabled();
  await remove.click();
  await expect(page).toHaveURL(/\/endpoints$/);
  expect(fixture.deleteRequests()).toBe(1);
  expect(fixture.deletePayload()).toEqual({expectedGeneration:4});
  await expect(page.getByRole('link',{name:'Campux production'})).toHaveCount(0);
});

test('keeps endpoint deletion failures inside the recoverable accessible confirmation dialog',async({page})=>{
  await mockProduct(page,{failDelete:true});
  await page.goto('/endpoints/fixture-endpoint');
  await page.getByRole('tab',{name:'Settings'}).click();
  await page.getByRole('button',{name:'Delete endpoint'}).click();
  const dialog=page.getByRole('dialog',{name:'Delete endpoint'});
  await dialog.getByLabel('Type endpoint name to confirm').fill('Campux production');
  await dialog.getByRole('button',{name:'Delete endpoint'}).click();
  const alert=dialog.getByRole('alert');
  await expect(alert).toContainText('Endpoint deletion failed');
  await expect(alert).toContainText('Fixture delete failed');
  await expect(alert).toBeFocused();
  await expect(dialog.getByRole('button',{name:'Delete endpoint'})).toBeEnabled();
  await dialog.getByRole('button',{name:'Cancel'}).click();
  await expect(dialog).toBeHidden();
});

for(const width of [390,320]){
  test(`endpoint title actions fit a ${width}px viewport`,async({page})=>{
    await page.setViewportSize({width,height:844});
    await mockProduct(page);
    await page.goto('/endpoints/fixture-endpoint');
    const metrics=await page.locator('.endpoint-heading').evaluate(element=>{
      const heading=element.getBoundingClientRect();
      const actions=element.querySelector('.endpoint-lifecycle-actions')!.getBoundingClientRect();
      return {headingLeft:heading.left,headingRight:heading.right,actionsLeft:actions.left,actionsRight:actions.right,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth};
    });
    expect(metrics.actionsLeft).toBeGreaterThanOrEqual(metrics.headingLeft-.5);
    expect(metrics.actionsRight).toBeLessThanOrEqual(metrics.headingRight+.5);
    expect(metrics.scrollWidth).toBe(metrics.clientWidth);
  });
}

test('QQ login card keeps a scannable QR and its action in one layout',async({page})=>{
  await mockProduct(page,{loggedIn:false});
  await page.goto('/endpoints/fixture-endpoint');
  const qr=page.getByRole('img',{name:'NapCat QR code'});
  const card=qr.locator('xpath=ancestor::*[contains(@class,"card")]');
  await expect(card.getByRole('button',{name:'Refresh QR code'})).toBeVisible();
  const box=await qr.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(160);
  expect(box!.height).toBeGreaterThanOrEqual(160);
  await expect(card.getByText('Scan with the QQ mobile app')).toBeVisible();
  await expect(page.getByRole('tab',{name:'OneBot'})).toBeDisabled();
});

test('endpoint tabs and selected sidebar entry use Campux product styling',async({page})=>{
  await mockProduct(page);
  await page.goto('/endpoints/fixture-endpoint');
  const endpointTabs=page.locator('.endpoint-tabs-list');
  await expect(endpointTabs).toHaveClass(/product-tabs-list/);
  await expect(endpointTabs.getByRole('tab',{name:'Overview'})).toHaveClass(/product-tabs-trigger/);
  const activeLink=page.locator('.sidebar a.active').first();
  await expect(activeLink).toHaveAttribute('aria-current','page');
  const activeStyle=await activeLink.evaluate(element=>{const style=getComputedStyle(element),box=element.getBoundingClientRect();return {borderRadius:parseFloat(style.borderRadius),height:box.height,fontWeight:Number(style.fontWeight),background:style.backgroundColor,color:style.color,paddingLeft:style.paddingLeft}});
  expect(activeStyle.borderRadius).toBeGreaterThanOrEqual(activeStyle.height/2-1);
  expect(activeStyle.fontWeight).toBeGreaterThanOrEqual(700);
  expect(activeStyle.background).toBe('rgb(239, 246, 255)');
  expect(activeStyle.color).toBe('rgb(29, 78, 216)');
  expect(activeStyle.paddingLeft).toBe('12px');
  await endpointTabs.getByRole('tab',{name:'Connections'}).click();
  const connectionTabs=page.locator('.ws-tabs [data-slot="tabs-list"]');
  await expect(connectionTabs).toHaveClass(/product-tabs-list/);
  await expect(connectionTabs.getByRole('tab',{name:/Outbound clients/})).toHaveClass(/product-tabs-trigger/);
});

test('separates QQ account data from OneBot protocol operations',async({page})=>{
  await mockProduct(page);
  await page.goto('/endpoints/fixture-endpoint');
  await expect(page.getByRole('tab',{name:'QQ data'})).toBeVisible();
  await expect(page.getByRole('tab',{name:'OneBot'})).toBeVisible();
  await page.getByRole('tab',{name:'QQ data'}).click();
  await expect(page.getByRole('tab',{name:'Friends (1)'})).toBeVisible();
  await expect(page.getByRole('cell',{name:'Friend',exact:true})).toBeVisible();
  await expect(page.getByText('get_status')).toHaveCount(0);
  await page.getByRole('tab',{name:'OneBot'}).click();
  await expect(page.getByText('Protocol action support')).toBeVisible();
  await expect(page.getByText('get_status')).toBeVisible();
  await expect(page.getByRole('cell',{name:'Friend',exact:true})).toBeHidden();
});

test('paginates large QQ directories with compact Campux controls',async({page})=>{
  await mockProduct(page,{directorySize:105});
  await page.goto('/endpoints/fixture-endpoint');
  await page.getByRole('tab',{name:'QQ data'}).click();
  await expect(page.getByText('1–25 of 105',{exact:true})).toBeVisible();
  await expect(page.getByRole('cell',{name:'Friend 1',exact:true})).toBeVisible();
  await expect(page.getByRole('cell',{name:'Friend 26',exact:true})).toHaveCount(0);
  await page.screenshot({path:'test-results/ui-evidence/qq-directory-pagination-desktop.png',fullPage:true});
  await page.setViewportSize({width:320,height:844});
  await page.getByRole('button',{name:'Next page'}).click();
  await expect(page.getByText('26–50 of 105',{exact:true})).toBeVisible();
  await expect(page.getByRole('cell',{name:'Friend 1',exact:true})).toHaveCount(0);
  await expect(page.getByRole('cell',{name:'Friend 26',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({path:'test-results/ui-evidence/qq-directory-pagination-320.png',fullPage:true});
});

test('shows lightweight aggregate traffic separately from connections and protocol actions',async({page})=>{
  await mockProduct(page);
  await page.goto('/endpoints/fixture-endpoint');
  const trafficTab=page.getByRole('tab',{name:'Traffic'});
  await expect(trafficTab).toBeVisible();
  await trafficTab.click();
  await expect(page.getByText('Real-time message traffic')).toBeVisible();
  await expect(page.getByText('2 messages / min')).toBeVisible();
  await expect(page.getByText('6 messages / 5 min')).toBeVisible();
  await expect(page.getByLabel('Message traffic in the last minute')).toBeVisible();
  await expect(page.getByRole('cell',{name:'In',exact:true})).toBeVisible();
  await expect(page.getByRole('cell',{name:'Group'})).toBeVisible();
  await expect(page.getByRole('cell',{name:'Out',exact:true})).toBeVisible();
  await expect(page.getByRole('cell',{name:'Private'})).toBeVisible();
  await expect(page.getByRole('cell',{name:'Retrying'})).toBeVisible();
  await expect(page.getByText('Message content and account identifiers are not stored')).toBeVisible();
  await expect(page.getByText('Protocol action support')).toHaveCount(0);
  await expect(page.getByText('Outbound clients')).toHaveCount(0);
});

test('marks retained traffic unavailable when background polling fails',async({page})=>{
  const controls=await mockProduct(page);
  await page.goto('/endpoints/fixture-endpoint');
  await page.getByRole('tab',{name:'Traffic'}).click();
  await expect(page.getByText('Live',{exact:true})).toBeVisible();
  controls.failStatus();
  await expect(page.getByText('Traffic status polling failed. Displayed metrics are not live.')).toBeVisible({timeout:5000});
  await expect(page.getByText('Unavailable',{exact:true})).toBeVisible();
});

test('sidebar refreshes every endpoint and exposes QQ login state',async({page})=>{
  const {endpointRequests}=await mockProduct(page);
  await page.goto('/endpoints/fixture-endpoint');
  const sidebar=page.locator('[data-sidebar-section="endpoints"]');
  await expect(sidebar.getByText('QQ 960164003 online')).toBeVisible();
  await expect(sidebar.getByText('QQ login required')).toBeVisible();
  await expect(sidebar.getByText('Endpoint unreachable')).toBeVisible();
  await expect(sidebar.getByText('QQ status unknown')).toBeVisible();
  const before=endpointRequests();
  await page.waitForTimeout(3300);
  expect(endpointRequests()).toBeGreaterThan(before);
});

test('workspace navigation uses the shared Campux pill tab styling',async({page})=>{
  await mockProduct(page);
  await page.goto('/workspace');
  const tabs=page.getByRole('navigation',{name:'Workspace sections'});
  await expect(tabs).toHaveClass(/product-tabs-list/);
  const members=tabs.getByRole('link',{name:'Members'});
  await expect(members).toHaveClass(/product-tabs-trigger/);
  await expect(members).toHaveAttribute('data-state','active');
  await expect(members).toHaveAttribute('aria-current','page');
  const activeStyle=await members.evaluate(element=>{const style=getComputedStyle(element),box=element.getBoundingClientRect();return{height:box.height,borderRadius:parseFloat(style.borderRadius),background:style.backgroundColor,color:style.color}});
  expect(activeStyle.height).toBe(28);
  expect(activeStyle.borderRadius).toBeGreaterThanOrEqual(activeStyle.height/2-1);
  expect(activeStyle.background).toBe('rgb(219, 234, 254)');
  expect(activeStyle.color).toBe('rgb(29, 78, 216)');
  await tabs.getByRole('link',{name:'Alerts'}).click();
  await expect(page).toHaveURL(/\/workspace\/settings$/);
  await expect(tabs.getByRole('link',{name:'Alerts'})).toHaveAttribute('data-state','active');
  await expect(tabs.getByRole('link',{name:'Members'})).toHaveAttribute('data-state','inactive');
});

test('workspace pill tabs do not overflow a 320px viewport',async({page})=>{
  await page.setViewportSize({width:320,height:720});
  await mockProduct(page);
  await page.goto('/workspace/settings');
  const tabs=page.getByRole('navigation',{name:'Workspace sections'});
  await expect(tabs.getByRole('link',{name:'Alerts'})).toHaveAttribute('aria-current','page');
  const geometry=await tabs.evaluate(element=>{const box=element.getBoundingClientRect();return{left:box.left,right:box.right,viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}});
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.scrollWidth).toBe(geometry.clientWidth);
  await page.screenshot({path:'test-results/ui-evidence/workspace-tabs-320.png',fullPage:true});
});
