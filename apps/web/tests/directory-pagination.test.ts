import {describe,expect,it} from 'bun:test';
import {directoryPage,paginationRange} from '../src/directory-pagination';

describe('directoryPage',()=>{
  const rows=Array.from({length:2_384},(_,index)=>({id:index+1}));

  it('renders only one bounded page for directories with thousands of rows',()=>{
    const result=directoryPage(rows,48,50);
    expect(result.items).toEqual(rows.slice(2350,2384));
    expect(result.page).toBe(48);
    expect(result.totalPages).toBe(48);
    expect(result.from).toBe(2351);
    expect(result.to).toBe(2384);
  });

  it('clamps a stale page after changing directory or page size',()=>{
    const result=directoryPage(rows.slice(0,12),99,25);
    expect(result.page).toBe(1);
    expect(result.totalPages).toBe(1);
    expect(result.items).toHaveLength(12);
  });
});

describe('paginationRange',()=>{
  it('keeps page controls compact for hundreds of pages',()=>{
    expect(paginationRange(50,200)).toEqual([1,'ellipsis',48,49,50,51,52,'ellipsis',200]);
  });

  it('shows every page when the directory is small',()=>{
    expect(paginationRange(2,4)).toEqual([1,2,3,4]);
  });
});
