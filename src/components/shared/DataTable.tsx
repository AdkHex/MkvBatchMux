import * as React from "react";
import { cn } from "@/lib/utils";

export function DataTable({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("data-table", className)} {...props} />;
}

export function DataTableHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("data-table__header", className)} {...props} />;
}

interface DataTableRowProps extends React.HTMLAttributes<HTMLDivElement> {
  selected?: boolean;
}

export const DataTableRow = React.memo(function DataTableRow({ className, selected, ...props }: DataTableRowProps) {
  return <div className={cn("data-table__row", selected && "is-selected", className)} {...props} />;
});

export function DataTableCell({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("data-table__cell", className)} {...props} />;
}

export function DataTableBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("overflow-y-auto scrollbar-thin", className)} {...props} />;
}
