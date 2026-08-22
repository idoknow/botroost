import type {AnchorHTMLAttributes,InputHTMLAttributes,ReactNode,SelectHTMLAttributes} from 'react';
import {useI18n} from './i18n';
import {cn} from './lib/utils';
import {Button as PrimitiveButton} from './components/button';
import {Input as PrimitiveInput} from './components/input';
import {Badge as PrimitiveBadge} from './components/badge';
import {Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle} from './components/dialog';
export function BrandMark({compact=false}:{compact?:boolean}){const{t}=useI18n();return <div className="brand-lockup"><div className="brand-mark" aria-hidden><span/><span/><span/></div>{!compact&&<div><strong>{t('brand.name')}</strong><small>{t('brand.tagline')}</small></div>}</div>}
export const PageContainer=({children}:{children:ReactNode})=><div className="page-container">{children}</div>;
export const Stack=({children,className}:{children:ReactNode;className?:string})=><div className={cn('stack',className)}>{children}</div>;
export const Card=({children,className}:{children:ReactNode;className?:string})=><section className={cn('card',className)}>{children}</section>;
export function Button({className,busy,...props}:React.ComponentProps<typeof PrimitiveButton>&{busy?:boolean}){const{t}=useI18n();return <PrimitiveButton className={className} disabled={busy||props.disabled} {...props}>{busy?t('common.working'):props.children}</PrimitiveButton>}
export function Input({label,description,...props}:InputHTMLAttributes<HTMLInputElement>&{label:string;description?:string}){return <label className="field"><span>{label}</span><PrimitiveInput {...props}/>{description&&<small>{description}</small>}</label>}
export function Select({label,children,...props}:SelectHTMLAttributes<HTMLSelectElement>&{label:string;children:ReactNode}){return <label className="field"><span>{label}</span><select {...props}>{children}</select></label>}
export const Badge=({children,good=false}:{children:ReactNode;good?:boolean})=><PrimitiveBadge variant="secondary" className={good?'status-good':undefined}>{children}</PrimitiveBadge>;
export const Table=({headers,rows}:{headers:string[];rows:ReactNode[][]})=><div className="table-scroll"><table><thead><tr>{headers.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={i}>{r.map((c,j)=><td key={j}>{c}</td>)}</tr>)}</tbody></table></div>;
export function Modal({open,title,description,onClose,children,footer,className}:{open:boolean;title:string;description?:ReactNode;onClose:()=>void;children:ReactNode;footer?:ReactNode;className?:string}){return <Dialog open={open} onOpenChange={value=>!value&&onClose()}><DialogContent className={cn('modal',className)}><DialogHeader><DialogTitle>{title}</DialogTitle>{description?<DialogDescription>{description}</DialogDescription>:null}</DialogHeader><div className="modal-body">{children}</div>{footer?<DialogFooter>{footer}</DialogFooter>:null}</DialogContent></Dialog>}
export const PageHeading=({kicker,title,description,action,className}:{kicker?:string;title:string;description?:string;action?:ReactNode;className?:string})=><header className={`page-header${className?` ${className}`:''}`}><div className="page-heading-copy">{kicker&&<p className="kicker">{kicker}</p>}<h1>{title}</h1>{description&&<p className="muted">{description}</p>}</div>{action}</header>;
export function navigate(to:string,replace=false){history[replace?'replaceState':'pushState']({},'',to);dispatchEvent(new PopStateEvent('popstate'))}
export const Link=({to,children,onClick,...props}:Omit<AnchorHTMLAttributes<HTMLAnchorElement>,'href'>&{to:string})=><a {...props} href={to} onClick={e=>{onClick?.(e);if(!e.defaultPrevented&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&e.button===0){e.preventDefault();navigate(to)}}}>{children}</a>;
