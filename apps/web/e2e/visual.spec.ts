import {test,expect,type Page} from '@playwright/test';
import fs from 'node:fs';

const endpoint={id:'fixture-endpoint',name:'Campux production',providerId:'napcat',node:{id:'fixture-node',name:'jp09-napcat-reenroll'},generation:4,desired:{state:'running'},status:{node:'online',runtime:'ready',provider:'available',protocol:'connected',convergence:'converged'},activeOperationId:null};
const session={user:{id:'fixture-user',email:'ops@example.test',name:'Rock'},workspace:{id:'fixture-workspace',name:'Production'},role:'owner',permissions:['workspace:read','endpoint:read','endpoint:create','endpoint:start','endpoint:stop','endpoint:restart','node:read','node:create','provider:read','operation:read','audit:read','member:read','credential:read','settings:read'],capabilities:{operations:['create','start','stop','restart'],providers:{napcat:{enabled:true}}}};

async function mockProduct(page:Page){
  await page.route('**/api/v1/**',async route=>{const path=new URL(route.request().url()).pathname;let body:unknown={};
    if(path.endsWith('/auth/session'))body=session;
    else if(path.endsWith('/workspaces/current/summary'))body={endpoints:2,operations:14};
    else if(path.endsWith('/endpoints/fixture-endpoint/napcat/status'))body={qq:{uin:'960164003',nickname:'不懂问我',online:true},onebot:{status:{online:true},loginInfo:{user_id:960164003,nickname:'不懂问我'},friends:[{user_id:10001,nickname:'Alice',remark:'Platform'}],friendCount:1,groups:[{group_id:20001,group_name:'Botroost users',member_count:128}],groupCount:1,version:{app_name:'NapCat.OneBot',app_version:'4.18.19'},config:{websocketClients:[{name:'Campux bridge',enable:true,url:'wss://app.campux.top/onebot/v11/ws?key=fixture',messagePostFormat:'array',reportSelfMessage:false,debug:false,heartInterval:30000,reconnectInterval:5000,tokenConfigured:true}],websocketServers:[]}}};
    else if(path.endsWith('/endpoints/fixture-endpoint'))body=endpoint;
    else if(path.endsWith('/endpoints'))body={items:[endpoint],page:1,pageSize:25,total:1};
    else if(path.endsWith('/nodes'))body={items:[endpoint.node],page:1,pageSize:25,total:1};
    else if(path.endsWith('/providers'))body={items:[{id:'napcat',capabilities:['runtime','onebot'],availability:{enabled:true}}],page:1,pageSize:25,total:1};
    else body={items:[],page:1,pageSize:25,total:0};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
}

for(const colorScheme of ['light','dark'] as const){
  for(const viewport of [{name:'desktop',width:1440,height:1000},{name:'mobile',width:390,height:844}]){
    test(`visual fixture ${colorScheme} ${viewport.name}`,async({page})=>{
      await page.addInitScript(scheme=>localStorage.setItem('botroost-theme',scheme),colorScheme);await page.setViewportSize({width:viewport.width,height:viewport.height});await mockProduct(page);await page.goto('/endpoints/fixture-endpoint');await expect(page.getByRole('heading',{name:'Campux production'})).toBeVisible();await expect(page.locator('html')).toHaveAttribute('data-theme',colorScheme);
      await expect(page.getByText('NapCat OneBot implementation')).toBeVisible();await expect(page.getByText('API available')).toHaveCount(0);await expect(page.getByText('OneBot connecting')).toHaveCount(0);
      await expect(page.locator('input[value="wss://app.campux.top/onebot/v11/ws?key=fixture"]')).toBeVisible();
      expect(await page.evaluate(()=>({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth}))).toEqual({scrollWidth:viewport.width,clientWidth:viewport.width});
      fs.mkdirSync('/tmp/botroost-ui-evidence',{recursive:true});
      await page.screenshot({path:`/tmp/botroost-ui-evidence/endpoint-${colorScheme}-${viewport.name}.png`,fullPage:true});
    });
  }
}
