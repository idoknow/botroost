import {test,expect,type Page} from '@playwright/test';
const permissions=['workspace:read','endpoint:read','node:read','node:create','provider:read','operation:read'];
async function fixture(page:Page,allowed=permissions,resources=false){
 const calls:string[]=[];let failed=false,tokenCount=0;
 await page.route('**/api/v1/**',async route=>{
  const url=new URL(route.request().url()),path=url.pathname.replace('/api/v1','');calls.push(path+url.search);
  const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(path==='/auth/session')return json({user:{id:'u',name:'Operator',email:'ops@example.test'},workspace:{id:'w',name:'Primary'},role:'viewer',permissions:allowed,capabilities:{operations:[]}});
  if(path==='/auth/csrf')return json({csrfToken:'csrf'});
  if(path==='/nodes/enrollment-tokens'){tokenCount++;return json({token:`one-time-secret-${tokenCount}`});}
  if(failed)return json({error:{message:'Status service failed'}},503);
  if(path==='/workspaces/current/summary')return json({endpoints:3,operations:8});
  const n=Number(url.searchParams.get('page')??1),now=new Date().toISOString();
  if(path==='/nodes')return json({items:[{id:`n${n}`,name:`Agent ${n}`,provider:'napcat',configured:n===1,lastHeartbeatAt:n===1?now:null,lastSeenAt:now,connectionEpoch:4}],page:n,pageSize:1,total:2});
  if(path==='/providers')return json({items:[{id:'napcat',capabilities:['runtime','onebot'],availability:{enabled:true}},{id:'fake',capabilities:['runtime'],availability:{enabled:false,reason:'Disabled by policy'}}],page:1,pageSize:25,total:2});
  if(path==='/endpoints')return json({items:[{id:`e${n}`,name:`Endpoint ${n}`,providerId:'napcat',node:{id:'n1',name:'Agent 1'},desired:{state:'running'},status:{node:'online',runtime:'ready',provider:'available',protocol:'connected',convergence:'converged'},activeOperation:null,metadata:resources?{resourceUsage:{source:'docker.stats',status:'ok',observedAt:n===2?new Date(Date.now()-60000).toISOString():now,cpuPercent:n===1?0:125.5,memoryBytes:n===1?0:134217728,cpuLimitMillis:1000,memoryLimitBytes:1073741824}}:{}}],page:n,pageSize:1,total:3});
  return json({error:{message:'Unexpected request'}},404);
 });
 return{calls,fail:()=>{failed=true},recover:()=>{failed=false},tokens:()=>tokenCount};
}
test('one status destination with all endpoint pages and no detail fanout',async({page})=>{
 const f=await fixture(page);await page.goto('/system-status');
 await expect(page.getByRole('heading',{name:'System status',exact:true})).toBeVisible();
 const nav=page.locator('[data-sidebar-section="operations"]');
 await expect(nav.getByRole('link',{name:'System status',exact:true})).toHaveCount(1);
 await expect(nav.getByRole('link',{name:/^(Cluster|Agent nodes|Runtime drivers)$/})).toHaveCount(0);
 await expect(page.locator('main tbody tr')).toHaveCount(3);
 await expect(page.locator('main').getByRole('link',{name:'Endpoint 3'})).toHaveAttribute('href','/endpoints/e3');
 await expect(page.locator('main').getByText('No sample',{exact:true})).toHaveCount(3);
 await page.getByRole('tab',{name:'Agent nodes'}).click();await expect(page.locator('main tbody tr')).toHaveCount(2);
 await page.getByText('Agent 1',{exact:true}).click();await expect(page.locator('details[open]').getByText('Connection epoch')).toBeVisible();
 await page.getByRole('tab',{name:'Runtime integrations'}).click();await expect(page.getByText('Disabled by policy')).toBeVisible();await expect(page.getByText('runtime, onebot')).toBeVisible();
 expect(f.calls.some(p=>/^\/endpoints\//.test(p))).toBe(false);
});
for(const [from,to] of [['/','/system-status'],['/nodes','/system-status?section=nodes'],['/nodes/n2','/system-status?section=nodes&node=n2'],['/providers','/system-status?section=integrations']])test(`legacy ${from} replaces history with status section`,async({page})=>{
 await fixture(page);await page.goto('/account');await expect(page.getByRole('heading').first()).toBeVisible();
 await page.evaluate(path=>{history.pushState({},'',path);dispatchEvent(new PopStateEvent('popstate'))},from!);
 await expect.poll(()=>new URL(page.url()).pathname+new URL(page.url()).search).toBe(to);
 if(from==='/nodes/n2')await expect(page.locator('details[open]')).toContainText('n2');
 await page.goBack();await expect(page).toHaveURL(/\/account$/);
});
test('enrollment is permission-gated and the one-time secret clears on close',async({page})=>{
 const f=await fixture(page);await page.goto('/system-status?section=nodes');await page.getByRole('button',{name:'Generate enrollment token'}).click();
 const dialog=page.getByRole('dialog');await expect(dialog).toContainText('one-time-secret-1');await page.keyboard.press('Escape');await expect(page.getByText('one-time-secret-1')).toHaveCount(0);
 await page.getByRole('button',{name:'Generate enrollment token'}).click();await expect(dialog).toContainText('one-time-secret-2');expect(f.tokens()).toBe(2);
 await dialog.getByRole('button',{name:'Done'}).click();await expect(page.locator('.enrollment-token')).toHaveCount(0);
});
test('read-only sections and fetches honor each permission',async({page})=>{
 const f=await fixture(page,['node:read']);await page.goto('/system-status?section=nodes');await expect(page.getByText('Agent 2',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Generate enrollment token'})).toHaveCount(0);await expect(page.getByRole('tab',{name:'Endpoint resources'})).toHaveCount(0);await expect(page.getByRole('tab',{name:'Runtime integrations'})).toHaveCount(0);
 expect(f.calls.filter(p=>/endpoints|providers|summary/.test(p))).toEqual([]);
});
test('refresh errors retain rows but revoke healthy badges and polling recovers',async({page})=>{
 const f=await fixture(page);await page.goto('/system-status');await expect(page.locator('main tbody tr')).toHaveCount(3);f.fail();await page.getByRole('button',{name:'Refresh system status'}).click();
 await expect(page.locator('main').getByText('Status service failed').first()).toBeVisible();await expect(page.locator('main tbody tr')).toHaveCount(3);await expect(page.locator('main .status-good')).toHaveCount(0);
 f.recover();await expect(page.locator('main').getByText('Status service failed')).toHaveCount(0,{timeout:12000});
});
test('true resource usage and stale timestamps are visible separately from limits',async({page})=>{
 await fixture(page,permissions,true);await page.goto('/system-status');
 const first=page.locator('main tbody tr').filter({hasText:'Endpoint 1'});
 await expect(first).toContainText('0.00%');await expect(first).toContainText('0.0 MiB');await expect(first).toContainText('1.00 GiB');await expect(first).toContainText('Live');
 const stale=page.locator('main tbody tr').filter({hasText:'Endpoint 2'});
 await expect(stale).toContainText('125.50%');await expect(stale).toContainText('128.0 MiB');await expect(stale).toContainText('Stale');
});
for(const theme of ['light','dark'])for(const width of [1440,390])test(`status visual ${theme} ${width}`,async({page},info)=>{
 await page.addInitScript(value=>localStorage.setItem('botroost-theme',value),theme);await page.setViewportSize({width,height:900});await fixture(page,permissions,true);await page.goto('/system-status');
 await expect(page.locator('main tbody tr')).toHaveCount(3);await expect(page.locator('html')).toHaveAttribute('data-theme',theme);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath('status.png'),fullPage:true});
});
for(const width of [320,390])test(`status tabs and tables do not overflow at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:800});await fixture(page);await page.goto('/system-status');
 for(const name of ['Endpoint resources','Agent nodes','Runtime integrations']){await page.getByRole('tab',{name}).click();await expect(page.locator('main tbody tr').first()).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
});
