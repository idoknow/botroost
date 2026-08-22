import {Check,Globe} from 'lucide-react';
import {useState} from 'react';
import {localeLabels,locales,useI18n} from './i18n';

export function LocaleControl(){
  const{locale,setLocale,t}=useI18n();
  const[open,setOpen]=useState(false);
  return <div className="theme-menu"><button className="icon-button" aria-label={t('common.language')} onClick={()=>setOpen(!open)}><Globe/></button>{open&&<div className="popover">{locales.map(item=><button key={item} onClick={()=>{setLocale(item);setOpen(false)}}><span className="locale-label">{localeLabels[item]}</span>{locale===item&&<Check/>}</button>)}</div>}</div>;
}
