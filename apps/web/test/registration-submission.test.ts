import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {Login} from '../src/login';
import {LocaleProvider} from '../src/i18n';

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;


const {registrationStatus,register,acceptInvitation,navigate}=vi.hoisted(()=>({registrationStatus:vi.fn(),register:vi.fn(),acceptInvitation:vi.fn(),navigate:vi.fn()}));
vi.mock('../src/api',()=>({api:{registrationStatus,register,acceptInvitation,login:vi.fn()}}));
vi.mock('../src/ui',()=>({
  navigate,
  BrandMark:()=>createElement('div'),
  Button:({children,busy,...props}:React.ComponentProps<'button'>&{busy?:boolean})=>createElement('button',{...props,disabled:busy||props.disabled},children),
  Input:({label,...props}:React.InputHTMLAttributes<HTMLInputElement>&{label:string})=>createElement('label',null,label,createElement('input',{...props,onChange:(event:React.ChangeEvent<HTMLInputElement>)=>props.onChange?.(event)})),
}));

describe('registration submission feedback',()=>{
  let container:HTMLDivElement;
  let root:Root;
  beforeEach(()=>{
    container=document.createElement('div');document.body.append(container);root=createRoot(container);
    window.history.replaceState({},'','/login');
    registrationStatus.mockResolvedValue({registrationOpen:true});
  });
  afterEach(()=>{act(()=>root.unmount());container.remove();registrationStatus.mockReset();register.mockReset();acceptInvitation.mockReset();navigate.mockReset()});
  async function renderLogin(){await act(async()=>{root.render(createElement(LocaleProvider,null,createElement(Login)))});}
  async function enterRegistration(){
    await renderLogin();
    const toggle=[...container.querySelectorAll('button')].find(button=>button.textContent?.includes('Create account'));
    expect(toggle).toBeDefined();
    await act(async()=>{toggle!.click()});
  }
  function fields(){
    const inputs=container.querySelectorAll('input');
    return {email:inputs[1] as HTMLInputElement,password:inputs[2] as HTMLInputElement};
  }
  async function fillAndSubmit(){
    const {email,password}=fields();
    await act(async()=>{
      const setNativeValue=(element:HTMLInputElement,value:string)=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!;setter.call(element,value)};
      setNativeValue(email,'person@example.test');email.dispatchEvent(new Event('input',{bubbles:true}));
      setNativeValue(password,'long-password-123');password.dispatchEvent(new Event('input',{bubbles:true}));
    });
    await act(async()=>{container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))});
  }

  it('shows the registration error returned by the API and does not navigate',async()=>{
    register.mockRejectedValue(new Error('Email is already registered'));
    await enterRegistration();await fillAndSubmit();
    expect(container.textContent).toContain('Email is already registered');
    expect(register).toHaveBeenCalledWith({email:'person@example.test',password:'long-password-123',name:'My Workspace'});
    expect(navigate).not.toHaveBeenCalled();
  });

  it('submits invitation credentials and navigates after acceptance succeeds',async()=>{
    window.history.replaceState({},'','/login?invite=invite-token&returnTo=%2Fworkspace');
    acceptInvitation.mockResolvedValue({ok:true});
    await renderLogin();await fillAndSubmit();
    expect(acceptInvitation).toHaveBeenCalledWith({token:'invite-token',email:'person@example.test',password:'long-password-123'});
    expect(navigate).toHaveBeenCalledWith('/workspace',true);
    expect(container.textContent).not.toContain('Unable to create account');
  });
});
