import {Button,Checkbox,Group,NumberInput,Select,SimpleGrid,Stack,TextInput} from '@mantine/core';
import {useState} from 'react';
import type {SchemaField} from './types';

const initialValue=(field:SchemaField)=>field.value??(field.type==='boolean'?false:field.type==='number'?0:'');

export function SchemaForm({fields,submitLabel,onSubmit,busy=false}:{fields:SchemaField[];submitLabel:string;onSubmit:(values:Record<string,unknown>)=>void;busy?:boolean}){
  const [values,setValues]=useState<Record<string,unknown>>(()=>Object.fromEntries(fields.map(field=>[field.key,initialValue(field)])));
  const update=(key:string,value:unknown)=>setValues(current=>({...current,[key]:value}));

  return <form className="schema-form" onSubmit={event=>{event.preventDefault();onSubmit(values)}}>
    <Stack gap="md">
      <SimpleGrid cols={{base:1,sm:2}} spacing="md" verticalSpacing="sm">
        {fields.map(field=>{
          const label=field.label??field.key;
          if(field.type==='boolean')return <Checkbox className="schema-form-boolean" key={field.key} label={label} checked={Boolean(values[field.key])} onChange={event=>update(field.key,event.currentTarget.checked)}/>;
          if(field.type==='number')return <NumberInput key={field.key} label={label} required={Boolean(field.required)} value={Number(values[field.key])} onChange={value=>update(field.key,Number(value))}/>;
          if(field.type==='enum')return <Select key={field.key} label={label} required={Boolean(field.required)} data={field.options??[]} value={String(values[field.key]??'')} onChange={value=>update(field.key,value??'')}/>;
          return <TextInput key={field.key} label={label} required={Boolean(field.required)} type={field.type==='secretRef'?'password':'text'} value={String(values[field.key]??'')} onChange={event=>update(field.key,event.currentTarget.value)}/>;
        })}
      </SimpleGrid>
      <Group justify="flex-end" className="schema-form-actions">
        <Button type="submit" loading={busy}>{submitLabel}</Button>
      </Group>
    </Stack>
  </form>;
}
