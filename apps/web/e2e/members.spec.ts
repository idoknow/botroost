import{test,expect,type Page}from'@playwright/test';

type Role='owner'|'admin'|'operator'|'viewer';
type Member={id:string;email:string;role:Role;created_at:string};

async function mockWorkspace(page:Page,role:Role='owner'){
 const members:Member[]=[{id:'owner-id',email:'owner@example.com',role:'owner',created_at:'2026-01-01T00:00:00.000Z'}];
 const mutations:{method:string;path:string;body:unknown}[]=[];
 await page.route('**/api/v1/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1',''),method=request.method();
  const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(path==='/auth/session')return json({user:{id:role==='owner'?'owner-id':'viewer-id',email:`${role}@example.com`,name:`${role}@example.com`},workspace:{id:'workspace-id',name:'Primary'},role,permissions:role==='owner'?['workspace:read','member:read','member:manage','credential:read','credential:manage','settings:read','settings:manage']:['workspace:read'],capabilities:{operations:[],providers:{},configurationSchemas:{}}});
  if(path==='/auth/csrf')return json({csrfToken:'csrf'});
  if(path==='/endpoints')return json({items:[],page:1,pageSize:25,total:0});
  if(path==='/workspaces/current/members'&&method==='GET')return json({items:members,page:1,pageSize:25,total:members.length});
  if(path==='/workspaces/current/members'&&method==='POST'){const body=request.postDataJSON() as{email:string;role:Role};mutations.push({method,path,body});members.push({id:'member-id',email:body.email,role:body.role,created_at:'2026-08-22T00:00:00.000Z'});return json(members.at(-1),201)}
  const memberMatch=/^\/workspaces\/current\/members\/([^/]+)$/.exec(path);
  if(memberMatch&&method==='PATCH'){const body=request.postDataJSON() as Partial<Member>;mutations.push({method,path,body});const member=members.find(value=>value.id===memberMatch[1])!;Object.assign(member,body);return json(member)}
  if(memberMatch&&method==='DELETE'){mutations.push({method,path,body:undefined});members.splice(members.findIndex(value=>value.id===memberMatch[1]),1);return route.fulfill({status:204})}
  if(path==='/auth/password'&&method==='PUT'){mutations.push({method,path,body:request.postDataJSON()});return route.fulfill({status:204})}
  return json({items:[],page:1,pageSize:25,total:0});
 });
 return{members,mutations};
}

test('owner completes the workspace member lifecycle',async({page},testInfo)=>{
 const{mutations}=await mockWorkspace(page);
 await page.goto('/workspace');
 await expect(page.getByRole('link',{name:'Members'})).toHaveAttribute('data-state','active');
 await page.getByRole('button',{name:'Add member'}).click();
 await page.getByLabel('Email').fill('new@example.com');
 await page.getByLabel('Initial password').fill('initial member password');
 await page.getByLabel('Role').selectOption('operator');
 await page.getByRole('button',{name:'Add member',exact:true}).last().click();
 await expect(page.getByRole('row',{name:/new@example.com operator/})).toBeVisible();
 expect(mutations[0]).toMatchObject({method:'POST',path:'/workspaces/current/members',body:{email:'new@example.com',password:'initial member password',role:'operator'}});

 const row=page.getByRole('row',{name:/new@example.com operator/});
 await row.getByRole('button',{name:'Edit'}).click();
 await page.getByLabel('Email').fill('renamed@example.com');
 await page.getByLabel('Role').selectOption('admin');
 await page.getByRole('button',{name:'Save changes'}).click();
 await expect(page.getByRole('row',{name:/renamed@example.com admin/})).toBeVisible();
 expect(mutations[1]).toMatchObject({method:'PATCH',body:{email:'renamed@example.com',role:'admin'}});

 await page.getByRole('row',{name:/renamed@example.com admin/}).getByRole('button',{name:'Delete'}).click();
 await expect(page.getByRole('dialog',{name:'Delete member'})).toContainText('renamed@example.com');
 await page.getByRole('button',{name:'Delete member',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Delete member'})).toBeHidden();
 await expect(page.getByText('renamed@example.com')).toHaveCount(0);
 expect(mutations[2]).toMatchObject({method:'DELETE',path:'/workspaces/current/members/member-id'});
 await page.screenshot({path:testInfo.outputPath('workspace-members.png'),fullPage:true});
});

test('a viewer can change only their own password on mobile',async({page},testInfo)=>{
 const{mutations}=await mockWorkspace(page,'viewer');
 await page.setViewportSize({width:320,height:760});
 await page.goto('/account');
 await expect(page.getByRole('heading',{name:'Account'})).toBeVisible();
 await page.getByLabel('Current password').fill('current viewer password');
 await page.getByLabel(/^New password/).fill('new viewer password');
 await page.getByLabel('Confirm new password').fill('different viewer password');
 await page.getByRole('button',{name:'Change password'}).click();
 const alert=page.getByRole('alert');
 await expect(alert).toContainText('New passwords do not match');
 await expect(alert).toBeFocused();
 await expect(page.getByLabel(/^New password/)).toHaveAttribute('aria-describedby','password-form-error');
 await expect(page.getByLabel(/^New password/)).toHaveAttribute('aria-invalid','true');
 await page.getByLabel('Confirm new password').fill('new viewer password');
 await page.getByRole('button',{name:'Change password'}).click();
 await expect(page.getByRole('status')).toHaveText('Password updated. Other sessions were signed out.');
 expect(mutations).toContainEqual({method:'PUT',path:'/auth/password',body:{currentPassword:'current viewer password',newPassword:'new viewer password'}});
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);
 expect(overflow).toBeLessThanOrEqual(0);
 await page.screenshot({path:testInfo.outputPath('account-password-320.png'),fullPage:true});
});
