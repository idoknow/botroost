import {ChevronLeft,ChevronRight} from 'lucide-react';
import {useEffect,useState,type ReactNode} from 'react';
import {directoryPage,paginationRange} from './directory-pagination';
import {Button,Table} from './ui';

type Props<T>={
  headers:string[];
  items:T[];
  total:number;
  truncated:boolean;
  row:(item:T)=>ReactNode[];
};

const PAGE_SIZES=[25,50,100] as const;

export function DirectoryTable<T>({headers,items,total,truncated,row}:Props<T>){
  const[page,setPage]=useState(1);
  const[pageSize,setPageSize]=useState<number>(25);
  const model=directoryPage(items,page,pageSize);
  useEffect(()=>{if(page!==model.page)setPage(model.page)},[page,model.page]);
  const tokens=paginationRange(model.page,model.totalPages);
  const totalLabel=truncated?`${items.length.toLocaleString()} loaded · ${total.toLocaleString()} total`:total.toLocaleString();
  return <div className="directory-table">
    <Table headers={headers} rows={model.items.map(row)}/>
    <nav className="directory-pagination" aria-label="Directory pagination">
      <span className="directory-pagination-summary" aria-live="polite">{model.from.toLocaleString()}–{model.to.toLocaleString()} of {totalLabel}</span>
      <label className="directory-page-size"><span>Rows</span><select aria-label="Rows per page" value={pageSize} onChange={event=>{setPageSize(Number(event.currentTarget.value));setPage(1)}}>{PAGE_SIZES.map(size=><option key={size} value={size}>{size}</option>)}</select></label>
      <div className="directory-page-buttons">
        <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={model.page===1} onClick={()=>setPage(value=>Math.max(1,value-1))}><ChevronLeft/></Button>
        <div className="directory-page-numbers">{tokens.map((token,index)=>token==='ellipsis'?<span className="directory-page-ellipsis" aria-hidden key={`ellipsis-${index}`}>…</span>:<Button key={token} variant={token===model.page?'default':'outline'} size="icon-sm" aria-label={`Page ${token}`} aria-current={token===model.page?'page':undefined} onClick={()=>setPage(token)}>{token}</Button>)}</div>
        <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={model.page===model.totalPages} onClick={()=>setPage(value=>Math.min(model.totalPages,value+1))}><ChevronRight/></Button>
      </div>
    </nav>
  </div>;
}
