import{test,expect,type Page}from'@playwright/test';

type Invitation={id:string;email:string;role:string;expiresAt:string;createdAt:string|null;acceptedAt:string|null;revokedAt:string|null};
type NodeRow={id:string;workspaceId:string;name:string;provider:string;labels:Record<string,string>;enabled:boolean;grantedWorkspaceIds:string[]};

const day=86_400_000;
const ownerPermissions=['workspace:read','member:read','member:manage','settings:read','settings:manage','node:read','endpoint:read','provider:read','operation:read','audit:read'];

/** Serves the platform administration API the pages consume and records every mutation. */
async function mockPlatform(page:Page,{platformOwner=true}:{platformOwner?:boolean}={}){
 const invitations:Invitation[]=[
  {id:'invite-pending',email:'pending@example.com',role:'viewer',expiresAt:new Date(Date.now()+day).toISOString(),createdAt:new Date().toISOString(),acceptedAt:null,revokedAt:null},
  {id:'invite-accepted',email:'accepted@example.com',role:'admin',expiresAt:new Date(Date.now()+day).toISOString(),createdAt:new Date().toISOString(),acceptedAt:new Date().toISOString(),revokedAt:null},
 ];
 const workspaces=[{id:'workspace-id',name:'Primary',members:1,endpoints:0,createdAt:new Date().toISOString()},{id:'workspace-two',name:'Second',members:2,endpoints:3,createdAt:new Date().toISOString()}];
 const nodes:NodeRow[]=[{id:'node-id',workspaceId:'workspace-id',name:'node-a',provider:'fake',labels:{region:'eu'},enabled:false,grantedWorkspaceIds:[]}];
 const shared:{id:string;name:string;provider:string;labels:Record<string,string>}[]=[{id:'shared-id',name:'shared-node',provider:'fake',labels:{region:'us'}}];
 let registrationOpen=false;
 const mutations:{method:string;path:string;body:unknown}[]=[];
 await page.route('**/api/v1/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1',''),method=request.method();
  const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  const collection=<T,>(items:T[])=>({items,page:1,pageSize:25,total:items.length});
  if(path==='/auth/session')return json({user:{id:'owner-id',email:'owner@example.com',name:'owner@example.com'},workspace:{id:'workspace-id',name:'Primary'},role:'admin',platformOwner,permissions:platformOwner?ownerPermissions:['workspace:read','node:read'],capabilities:{operations:[],providers:{},configurationSchemas:{}}});
  if(path==='/auth/csrf')return json({csrfToken:'csrf'});
  if(path==='/auth/workspaces')return json({currentWorkspaceId:'workspace-id',workspaces:workspaces.map(workspace=>({id:workspace.id,name:workspace.name,role:'admin'}))});
  if(path==='/endpoints')return json(collection([]));
  if(path==='/platform/registration'&&method==='GET')return json({registrationOpen});
  if(path==='/platform/registration'&&method==='POST'){const body=request.postDataJSON() as{open:boolean};mutations.push({method,path,body});registrationOpen=body.open;return json({registrationOpen})}
  if(path==='/platform/workspaces'&&method==='GET')return json({workspaces});
  if(path==='/workspaces'&&method==='POST'){const body=request.postDataJSON() as{name:string};mutations.push({method,path,body});const created={id:'workspace-new',name:body.name,members:1,endpoints:0,createdAt:new Date().toISOString()};workspaces.push(created);return json(created,201)}
  const workspaceMatch=/^\/platform\/workspaces\/([^/]+)$/.exec(path);
  if(workspaceMatch&&method==='PATCH'){const body=request.postDataJSON() as{name:string};mutations.push({method,path,body});const workspace=workspaces.find(value=>value.id===workspaceMatch[1])!;workspace.name=body.name;return json(workspace)}
  if(workspaceMatch&&method==='DELETE'){mutations.push({method,path,body:undefined});workspaces.splice(workspaces.findIndex(value=>value.id===workspaceMatch[1]),1);return route.fulfill({status:204})}
  if(path==='/platform/nodes'&&method==='GET')return json({nodes});
  const sharedMatch=/^\/platform\/nodes\/([^/]+)\/shared$/.exec(path);
  if(sharedMatch&&method==='PUT'){const body=request.postDataJSON() as{enabled:boolean;labels:Record<string,string>};mutations.push({method,path,body});const node=nodes.find(value=>value.id===sharedMatch[1])!;node.enabled=body.enabled;node.labels=body.labels;return json({nodeId:node.id,enabled:node.enabled,labels:node.labels})}
  const grantMatch=/^\/platform\/workspaces\/([^/]+)\/nodes\/([^/]+)$/.exec(path);
  if(grantMatch&&method==='PUT'){mutations.push({method,path,body:undefined});const node=nodes.find(value=>value.id===grantMatch[2])!;if(!node.grantedWorkspaceIds.includes(grantMatch[1]!))node.grantedWorkspaceIds.push(grantMatch[1]!);return route.fulfill({status:204})}
  if(grantMatch&&method==='DELETE'){mutations.push({method,path,body:undefined});const node=nodes.find(value=>value.id===grantMatch[2])!;node.grantedWorkspaceIds=node.grantedWorkspaceIds.filter(id=>id!==grantMatch[1]);return route.fulfill({status:204})}
  if(path==='/workspaces/current/invitations'&&method==='GET')return json(collection(invitations));
  if(path==='/workspaces/current/invitations'&&method==='POST'){const body=request.postDataJSON() as{email:string;role:string};mutations.push({method,path,body});const created:Invitation={id:'invite-new',email:body.email,role:body.role,expiresAt:new Date(Date.now()+day).toISOString(),createdAt:new Date().toISOString(),acceptedAt:null,revokedAt:null};invitations.unshift(created);return json({...created,acceptUrl:'https://app.test/login?invite=raw-invitation-token'},201)}
  const revokeMatch=/^\/workspaces\/current\/invitations\/([^/]+)$/.exec(path);
  if(revokeMatch&&method==='DELETE'){mutations.push({method,path,body:undefined});const invitation=invitations.find(value=>value.id===revokeMatch[1])!;invitation.revokedAt=new Date().toISOString();return route.fulfill({status:204})}
  if(path==='/workspaces/current/nodes/shared')return json({nodes:shared});
  return json(collection([]));
 });
 return{invitations,workspaces,nodes,mutations,isRegistrationOpen:()=>registrationOpen};
}

test('platform owner manages the registration switch, workspaces, and the shared node pool',async({page},testInfo)=>{
 const state=await mockPlatform(page);
 await page.setViewportSize({width:320,height:760});
 await page.goto('/platform');
 await expect(page.getByRole('heading',{name:'Platform administration'})).toBeVisible();
 await expect(page.getByText('Closed',{exact:true})).toBeVisible();

 const toggle=page.getByRole('checkbox',{name:'Public registration'});
 await toggle.check();
 await page.getByRole('button',{name:'Save changes'}).click();
 await expect(page.getByRole('status')).toHaveText('Registration policy updated.');
 expect(state.mutations[0]).toMatchObject({method:'POST',path:'/platform/registration',body:{open:true}});

 await page.getByRole('tab',{name:/Workspaces/}).click();
 await expect(page.getByRole('row',{name:/^Primary Active/})).toBeVisible();
 await expect(page.getByRole('row',{name:/^Second 2 3/})).toBeVisible();
 await expect(page.getByText('Active')).toBeVisible();
 await expect(page.getByRole('row',{name:/^Primary/}).getByRole('button',{name:'Delete'})).toHaveCount(0);

 await page.getByRole('button',{name:'Create workspace'}).first().click();
 const createDialog=page.getByRole('dialog',{name:'Create workspace'});
 await expect(createDialog).toBeVisible();
 await page.getByLabel('Workspace name').fill('Third');
 await createDialog.getByRole('button',{name:'Create workspace',exact:true}).click();
 await expect(page.getByRole('row',{name:/Third/})).toBeVisible();
 expect(state.mutations[1]).toMatchObject({method:'POST',path:'/workspaces',body:{name:'Third'}});

 await page.getByRole('row',{name:/Second/}).getByRole('button',{name:'Delete'}).click();
 const deleteDialog=page.getByRole('dialog',{name:'Delete workspace'});
 await expect(deleteDialog).toContainText('Second');
 await deleteDialog.getByRole('button',{name:'Delete',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Delete workspace'})).toBeHidden();
 expect(state.mutations[2]).toMatchObject({method:'DELETE',path:'/platform/workspaces/workspace-two'});

 await page.getByRole('tab',{name:/Shared node pool/}).click();
 await expect(page.getByRole('cell',{name:'node-a'})).toBeVisible();
 await expect(page.getByRole('row',{name:/node-a/})).toContainText('Private');
 await page.getByRole('button',{name:'Enable sharing'}).click();
 await expect(page.getByRole('row',{name:/node-a/})).toContainText('Shared');
 expect(state.mutations[3]).toMatchObject({method:'PUT',path:'/platform/nodes/node-id/shared',body:{enabled:true,labels:{region:'eu'}}});

 await page.getByLabel('Select workspace').selectOption('workspace-new');
 await expect(page.getByRole('button',{name:'Third ✕'})).toBeVisible();
 expect(state.mutations[4]).toMatchObject({method:'PUT',path:'/platform/workspaces/workspace-new/nodes/node-id'});
 await page.getByRole('button',{name:'Third ✕'}).click();
 await expect(page.getByRole('button',{name:'Third ✕'})).toBeHidden();
 expect(state.mutations[5]).toMatchObject({method:'DELETE',path:'/platform/workspaces/workspace-new/nodes/node-id'});

 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
 expect(overflow).toBeLessThanOrEqual(0);
 await page.screenshot({path:testInfo.outputPath('platform-administration-320.png'),fullPage:true});
});

test('workspace manager completes the invitation lifecycle and never sees the stored token',async({page},testInfo)=>{
 const state=await mockPlatform(page);
 await page.setViewportSize({width:1280,height:900});
 await page.goto('/workspace/invitations');
 await expect(page.getByRole('heading',{name:'Workspace invitations'})).toBeVisible();
 await expect(page.getByRole('link',{name:'Invitations'})).toHaveAttribute('data-state','active');
 await expect(page.getByRole('row',{name:/pending@example.com viewer Pending/})).toBeVisible();
 await expect(page.getByRole('row',{name:/accepted@example.com admin Accepted/})).toContainText('—');

 await page.getByRole('button',{name:'Create invitation'}).click();
 const createDialog=page.getByRole('dialog',{name:'Create invitation'});
 await expect(createDialog).toBeVisible();
 await page.getByLabel('Email').fill('invitee@example.com');
 await page.getByLabel('Role').selectOption('operator');
 await createDialog.getByRole('button',{name:'Create invitation',exact:true}).click();
 const createdDialog=page.getByRole('dialog',{name:'Invitation created'});
 await expect(createdDialog).toContainText('https://app.test/login?invite=raw-invitation-token');
 await expect(createdDialog).toContainText('It is shown only once.');
 expect(state.mutations[0]).toMatchObject({method:'POST',path:'/workspaces/current/invitations',body:{email:'invitee@example.com',role:'operator'}});
 await createdDialog.getByRole('button',{name:'Close'}).first().click();

 await page.getByRole('row',{name:/pending@example.com/}).getByRole('button',{name:'Revoke'}).click();
 const revokeDialog=page.getByRole('dialog',{name:'Revoke invitation'});
 await expect(revokeDialog).toContainText('pending@example.com');
 await expect(revokeDialog.getByRole('button',{name:'Revoke',exact:true})).toHaveAttribute('data-variant','destructive');
 await revokeDialog.getByRole('button',{name:'Revoke',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Revoke invitation'})).toBeHidden();
 await expect(page.getByRole('row',{name:/pending@example.com/})).toContainText('Revoked');
 expect(state.mutations[1]).toMatchObject({method:'DELETE',path:'/workspaces/current/invitations/invite-pending'});
 await page.screenshot({path:testInfo.outputPath('workspace-invitations.png'),fullPage:true});
});

test('a member without platform ownership sees only the shared nodes page',async({page})=>{
 await mockPlatform(page,{platformOwner:false});
 await page.goto('/platform');
 await expect(page.getByRole('heading',{name:'Platform administration'})).toBeHidden();
 await page.goto('/shared-nodes');
 await expect(page.getByRole('heading',{name:'Shared nodes'})).toBeVisible();
 await expect(page.getByRole('cell',{name:'shared-node'})).toBeVisible();
});
