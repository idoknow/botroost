export type PaginationToken=number|'ellipsis';

export function directoryPage<T>(items:readonly T[],requestedPage:number,pageSize:number){
  const safePageSize=Math.max(1,Math.floor(pageSize));
  const totalPages=Math.max(1,Math.ceil(items.length/safePageSize));
  const page=Math.min(totalPages,Math.max(1,Math.floor(requestedPage)));
  const start=(page-1)*safePageSize;
  const pageItems=items.slice(start,start+safePageSize);
  return{items:pageItems,page,totalPages,from:items.length?start+1:0,to:start+pageItems.length};
}

export function paginationRange(page:number,totalPages:number):PaginationToken[]{
  if(totalPages<=7)return Array.from({length:totalPages},(_,index)=>index+1);
  const visible=new Set([1,totalPages,page-2,page-1,page,page+1,page+2].filter(value=>value>=1&&value<=totalPages));
  const pages=[...visible].sort((a,b)=>a-b);
  const result:PaginationToken[]=[];
  pages.forEach((value,index)=>{
    if(index>0&&value-pages[index-1]!>1)result.push('ellipsis');
    result.push(value);
  });
  return result;
}
