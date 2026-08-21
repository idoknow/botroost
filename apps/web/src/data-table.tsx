import {ScrollArea,Table} from '@mantine/core';
import {flexRender,getCoreRowModel,useReactTable,type ColumnDef} from '@tanstack/react-table';

export function DataTable<T>({data,columns}:{data:T[];columns:ColumnDef<T>[]}){
  const table=useReactTable({data,columns,getCoreRowModel:getCoreRowModel()});

  return <ScrollArea type="auto" className="data-table-scroll">
    <Table highlightOnHover horizontalSpacing="sm" verticalSpacing="xs" className="data-table">
      <Table.Thead>
        {table.getHeaderGroups().map(group=><Table.Tr key={group.id}>
          {group.headers.map(header=><Table.Th key={header.id}>
            {header.isPlaceholder?null:flexRender(header.column.columnDef.header,header.getContext())}
          </Table.Th>)}
        </Table.Tr>)}
      </Table.Thead>
      <Table.Tbody>
        {table.getRowModel().rows.map(row=><Table.Tr key={row.id}>
          {row.getVisibleCells().map(cell=><Table.Td key={cell.id}>
            {flexRender(cell.column.columnDef.cell,cell.getContext())}
          </Table.Td>)}
        </Table.Tr>)}
      </Table.Tbody>
    </Table>
  </ScrollArea>;
}
