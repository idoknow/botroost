import {expect,test,type Page,type Route} from '@playwright/test';

const endpointId='stuck-endpoint';
const operation={id:'forced-operation',endpointId,action:'force-restart',status:'running',generation:8,progress:{phase:'restarting',percent:10,message:'Restart requested',sequence:1,updatedAt:'2026-09-14T00:00:00Z'}};

async function fixture(page:Page,{viewer=false,deleting=false,capability=true,submit}:{viewer?:boolean;deleting?:boolean;capability?:boolean;submit?:(route:Route)=>Promise<void>}={}){
  const endpoint={id:endpointId,name:'Stuck endpoint',providerId:'fake',node:{id:'node',name:'Fixture agent'},generation:7,desired:{state:'running'},status:{node:'online',runtime:'unknown',provider:'unknown',protocol:'unknown',convergence:'pending'},activeOperationId:'stuck-operation',activeOperation:{...operation,id:'stuck-operation',action:deleting?'delete':'restart'}};
  const requests:{body:unknown;headers:Record<string,string>}[]=[];
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1','');
    const json=(body:unknown)=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/auth/session')return json({user:{id:'user',name:'Fixture user',email:'fixture@example.test'},workspace:{id:'workspace',name:'Fixture'},role:viewer?'viewer':'operator',permissions:['workspace:read','endpoint:read','operation:read',...(viewer?[]:['endpoint:start','endpoint:stop','endpoint:restart'])],capabilities:{operations:['start','stop','restart',...(capability?['force-restart']:[])],providers:{fake:{enabled:true}}}});
    if(path==='/auth/csrf')return json({csrfToken:'fixture-csrf'});
    if(path===`/endpoints/${endpointId}/operations`&&request.method()==='POST'){
      requests.push({body:request.postDataJSON(),headers:request.headers()});
      return submit?submit(route):json(operation);
    }
    if(path===`/endpoints/${endpointId}`)return json(endpoint);
    if(path==='/endpoints')return json({items:[endpoint],page:1,pageSize:25,total:1});
    if(path===`/operations/${operation.id}`)return json(operation);
    return json({items:[],page:1,pageSize:25,total:0});
  });
  await page.goto(`/endpoints/${endpointId}`);
  await expect(page.getByRole('heading',{name:'Stuck endpoint',exact:true})).toBeVisible();
  return requests;
}

async function confirmDialog(page:Page){
  await page.getByRole('button',{name:'Force restart',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Force restart',exact:true});
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription('Interrupts the current operation and force stops and restarts the runtime. Configuration and login data are kept. QQ login may be required again.');
  await expect(dialog.locator('[data-slot="dialog-footer"]')).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Force restart',exact:true})).toHaveAttribute('data-variant','destructive');
  await expect(dialog.getByRole('button',{name:'Close',exact:true})).toBeVisible();
  return dialog;
}

test('force restart interrupts an active operation only after confirmation and navigates to its operation',async({page})=>{
  let release!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve});
  const requests=await fixture(page,{submit:async route=>{await pending;await route.fulfill({contentType:'application/json',body:JSON.stringify(operation)})}});
  await expect(page.getByRole('button',{name:'Restart',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Force restart',exact:true})).toBeEnabled();
  const dialog=await confirmDialog(page);
  expect(requests).toHaveLength(0);
  const confirm=dialog.getByRole('button',{name:'Force restart',exact:true});
  await confirm.evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click()});
  await expect.poll(()=>requests.length).toBe(1);
  await expect(dialog.getByRole('button',{name:'Working…'})).toBeDisabled();
  await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await expect(dialog).toBeVisible();
  expect(requests[0]!.body).toEqual({action:'force-restart',expectedGeneration:7});
  expect(requests[0]!.headers['x-csrf-token']).toBe('fixture-csrf');
  expect(requests[0]!.headers['idempotency-key']).toMatch(/^[\da-f-]{36}$/);
  expect(requests).toHaveLength(1);
  release();
  await expect(page).toHaveURL(`/operations/${operation.id}`);
  await expect(page.getByRole('status',{name:'Force restarting endpoint',exact:true})).toBeVisible();
});

test('cancel closes force restart without submitting',async({page})=>{
  const requests=await fixture(page);
  const dialog=await confirmDialog(page);
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(dialog).toBeHidden();
  expect(requests).toHaveLength(0);
  await expect(page).toHaveURL(`/endpoints/${endpointId}`);
});

test('failed force restart stays focused in the dialog and can retry or cancel',async({page})=>{
  let attempts=0;
  const requests=await fixture(page,{submit:async route=>{attempts++;await route.fulfill({status:attempts<=2?409:200,contentType:'application/json',body:JSON.stringify(attempts<=2?{error:{message:'Generation changed. Try again.'}}:operation)})}});
  let dialog=await confirmDialog(page);
  await dialog.getByRole('button',{name:'Force restart',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('Generation changed. Try again.');
  await expect(dialog.getByRole('alert')).toBeFocused();
  await expect(dialog.getByRole('button',{name:'Force restart',exact:true})).toBeEnabled();
  await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeEnabled();
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(dialog).toBeHidden();
  dialog=await confirmDialog(page);
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByRole('button',{name:'Force restart',exact:true}).click();
  await expect(dialog.getByRole('alert')).toBeFocused();
  await dialog.getByRole('button',{name:'Force restart',exact:true}).click();
  await expect(page).toHaveURL(`/operations/${operation.id}`);
  expect(requests).toHaveLength(3);
});

test('viewer cannot see force restart even when capability is advertised',async({page})=>{
  const requests=await fixture(page,{viewer:true});
  await expect(page.getByRole('button',{name:'Force restart',exact:true})).toHaveCount(0);
  expect(requests).toHaveLength(0);
});

test('force restart is hidden without the server capability',async({page})=>{
  await fixture(page,{capability:false});
  await expect(page.getByRole('button',{name:'Force restart',exact:true})).toHaveCount(0);
});

test('force restart cannot interrupt endpoint deletion',async({page})=>{
  const requests=await fixture(page,{deleting:true});
  await expect(page.getByRole('button',{name:'Force restart',exact:true})).toBeDisabled();
  expect(requests).toHaveLength(0);
});

for(const [locale,label,description,cancel] of [
  ['en','Force restart','Interrupts the current operation and force stops and restarts the runtime. Configuration and login data are kept. QQ login may be required again.','Cancel'],
  ['zh-CN','强制重启','中断当前操作，强制停止并重启运行环境。保留配置和登录数据，可能需要重新登录 QQ。','取消'],
  ['zh-TW','強制重啟','中斷目前操作，強制停止並重啟執行環境。保留設定和登入資料，可能需要重新登入 QQ。','取消'],
  ['ja','強制再起動','現在の操作を中断し、ランタイムを強制停止して再起動します。設定とログインデータは保持されます。QQ への再ログインが必要になる場合があります。','キャンセル'],
] as const){
  for(const theme of ['light','dark'])test(`force restart confirmation fits 320px in ${locale} ${theme}`,async({page})=>{
    await page.setViewportSize({width:320,height:760});
    await page.addInitScript(({locale,theme})=>{localStorage.setItem('botroost-locale',locale);localStorage.setItem('botroost-theme',theme)},{locale,theme});
    const requests=await fixture(page);
    await expect(page.getByRole('button',{name:label,exact:true})).toBeEnabled();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    await page.getByRole('button',{name:label,exact:true}).click();
    const dialog=page.getByRole('dialog',{name:label,exact:true});
    await expect(dialog).toHaveAccessibleDescription(description);
    await dialog.evaluate(element=>Promise.all(element.getAnimations().map(animation=>animation.finished)));
    const box=await dialog.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x+box!.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    await dialog.getByRole('button',{name:cancel,exact:true}).click();
    expect(requests).toHaveLength(0);
  });
}
