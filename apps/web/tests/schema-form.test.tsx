import {describe,expect,it,vi} from 'vitest';
import {render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {MantineProvider} from '@mantine/core';
import {SchemaForm} from '../src/schema-form';

describe('SchemaForm',()=>{
  it('renders supported capability schema fields and submits typed values',async()=>{
    const submit=vi.fn();
    render(<MantineProvider env="test"><SchemaForm fields={[
      {key:'name',label:'Name',type:'string',required:true},
      {key:'retries',type:'number',value:2},
      {key:'enabled',type:'boolean',value:true},
      {key:'mode',type:'enum',options:['safe','fast'],value:'safe'},
      {key:'credential',type:'secretRef'},
    ]} submitLabel="Save" onSubmit={submit}/></MantineProvider>);
    await userEvent.type(screen.getByLabelText(/Name/),'edge');
    await userEvent.clear(screen.getByLabelText('retries'));
    await userEvent.type(screen.getByLabelText('retries'),'3');
    await userEvent.click(screen.getByRole('textbox',{name:'mode'}));
    await userEvent.click(screen.getByRole('option',{name:'fast'}));
    await userEvent.type(screen.getByLabelText('credential'),'vault://napcat');
    await userEvent.click(screen.getByRole('button',{name:'Save'}));
    expect(submit).toHaveBeenCalledWith({name:'edge',retries:3,enabled:true,mode:'fast',credential:'vault://napcat'});
  });
});
