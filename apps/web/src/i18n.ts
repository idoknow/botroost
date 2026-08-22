import {createContext,createElement,useCallback,useContext,useEffect,useMemo,useState,type ReactNode} from 'react';
import {ja,zhCN,zhTW,en,type MessageKey,type Messages} from './locales';
export type {MessageKey};

export const locales=['en','zh-CN','zh-TW','ja'] as const;
export type Locale=typeof locales[number];
export const defaultLocale:Locale='en';
export const localeStorageKey='botroost-locale';
export const localeLabels:Record<Locale,string>={en:'English','zh-CN':'简体中文','zh-TW':'繁體中文',ja:'日本語'};

const catalogs:Record<Locale,Messages>={en,'zh-CN':zhCN,'zh-TW':zhTW,ja};

export function isLocale(value:string):value is Locale{
  return (locales as readonly string[]).includes(value);
}

export function resolveLocale(value:string|null|undefined):Locale{
  return value&&isLocale(value)?value:defaultLocale;
}

export function interpolate(template:string,vars?:Record<string,string|number>){
  if(!vars)return template;
  return template.replace(/\{(\w+)\}/g,(_,key:string)=>vars[key]===undefined?`{${key}}`:String(vars[key]));
}

export function translate(locale:Locale,key:MessageKey,vars?:Record<string,string|number>){
  return interpolate(catalogs[locale][key]||en[key],vars);
}

type I18nValue={
  locale:Locale;
  setLocale:(locale:Locale)=>void;
  t:(key:MessageKey,vars?:Record<string,string|number>)=>string;
};

const I18nContext=createContext<I18nValue|null>(null);

function readStoredLocale(){
  try{return resolveLocale(localStorage.getItem(localeStorageKey))}catch{return defaultLocale}
}

function applyLocale(locale:Locale){
  document.documentElement.lang=locale;
}

export function LocaleProvider({children}:{children:ReactNode}){
  const[locale,setLocaleState]=useState<Locale>(readStoredLocale);
  useEffect(()=>{applyLocale(locale);try{localStorage.setItem(localeStorageKey,locale)}catch{/* private mode */}},[locale]);
  const setLocale=useCallback((next:Locale)=>{setLocaleState(next)},[]);
  const t=useCallback((key:MessageKey,vars?:Record<string,string|number>)=>translate(locale,key,vars),[locale]);
  const value=useMemo<I18nValue>(()=>({locale,setLocale,t}),[locale,setLocale,t]);
  return createElement(I18nContext.Provider,{value},children);
}

export function useI18n(){
  const value=useContext(I18nContext);
  if(!value)throw new Error('useI18n must be used within LocaleProvider');
  return value;
}
