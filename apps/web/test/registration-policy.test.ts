import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Login} from '../src/login';
import {LocaleProvider} from '../src/i18n';

const {registrationStatus}=vi.hoisted(()=>({registrationStatus:vi.fn()}));
vi.mock('../src/api',()=>({api:{registrationStatus}}));

describe('Login registration policy',()=>{
  let container:HTMLDivElement;
  let root:Root;
  beforeEach(()=>{
    container=document.createElement('div');
    document.body.append(container);
    root=createRoot(container);
    window.history.replaceState({},'','/login');
  });
  afterEach(()=>{
    act(()=>root.unmount());
    container.remove();
    registrationStatus.mockReset();
  });
  async function renderLogin(){
    await act(async()=>{root.render(createElement(LocaleProvider,null,createElement(Login)))});
  }
  function submitButton(){
    const button=container.querySelector('button[type="submit"]');
    expect(button).not.toBeNull();
    return button as HTMLButtonElement;
  }
  async function switchToSignup(){
    const toggle=[...container.querySelectorAll('button')].find(button=>button.textContent?.includes('Create account'));
    expect(toggle).toBeDefined();
    await act(async()=>{toggle!.click()});
    expect(container.querySelector('h1')?.textContent).toContain('Create account');
  }

  it('shows login while status is pending, then prevents signup when the request fails',async()=>{
    let reject!: (reason:Error)=>void;
    registrationStatus.mockReturnValue(new Promise((_,fail)=>{reject=fail}));
    await renderLogin();
    expect(container.querySelector('h1')?.textContent).toContain('Sign in');
    await switchToSignup();
    expect(submitButton().disabled).toBe(true);
    await act(async()=>reject(new Error('network unavailable')));
    expect(container.textContent).toContain('Public registration is unavailable.');
    expect(container.querySelector('button.button-link')).toBeNull();
  });

  it('does not expose public signup controls when fetching registration status fails',async()=>{
    registrationStatus.mockRejectedValue(new Error('network unavailable'));
    await renderLogin();
    expect(container.querySelector('h1')?.textContent).toContain('Sign in');
    expect(submitButton().disabled).toBe(false); // Login itself remains available.
    expect(container.textContent).toContain('Public registration is unavailable.');
    expect(container.querySelector('button.button-link')).not.toBeNull();
    expect(container.querySelector('button.button-link')?.textContent).toContain('Create account');
  });

  it('ignores a resolved registration status after the login view unmounts',async()=>{
    let resolve!: (value:{registrationOpen:boolean})=>void;
    registrationStatus.mockReturnValue(new Promise(done=>{resolve=done}));
    await renderLogin();
    await act(async()=>root.unmount());
    await act(async()=>resolve({registrationOpen:false}));
    expect(container.textContent).toBe('');
    expect(container.querySelector('button.button-link')).toBeNull();
  });

  it('disables the signup submit control while status is pending and enables it once registration is open',async()=>{
    let resolve!: (value:{registrationOpen:boolean})=>void;
    registrationStatus.mockReturnValue(new Promise(done=>{resolve=done}));
    await renderLogin();
    expect(container.querySelector('h1')?.textContent).toContain('Sign in');
    expect(submitButton().disabled).toBe(false); // Login itself remains available.
    await switchToSignup();
    expect(submitButton().disabled).toBe(true);
    await act(async()=>resolve({registrationOpen:true}));
    expect(submitButton().disabled).toBe(false);
    expect(container.textContent).not.toContain('Public registration is unavailable.');
  });

  it('does not expose public signup while registration is closed',async()=>{
    registrationStatus.mockResolvedValue({registrationOpen:false});
    await renderLogin();
    expect(container.querySelector('h1')?.textContent).toContain('Sign in');
    expect(submitButton().disabled).toBe(false);
    expect(container.textContent).toContain('Public registration is unavailable.');
    expect(container.querySelector('button.button-link')).not.toBeNull();
    expect(container.querySelector('button.button-link')?.textContent).toContain('Create account');
    await switchToSignup();
    expect(submitButton().disabled).toBe(true);
    expect(container.textContent).toContain('Public registration is unavailable.');
  });

  it('opens signup controls directly on an invitation route despite closed public registration',async()=>{
    window.history.replaceState({},'','/login?invite=invite-token');
    registrationStatus.mockResolvedValue({registrationOpen:false});
    await renderLogin();
    expect(registrationStatus).not.toHaveBeenCalled();
    expect(container.querySelector('h1')?.textContent).toContain('Create account');
    expect(container.querySelector('input[autocomplete="organization"]')).not.toBeNull();
    expect(submitButton().disabled).toBe(false);
    expect(container.textContent).not.toContain('Public registration is unavailable.');
  });
});
