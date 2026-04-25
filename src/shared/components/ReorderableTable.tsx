import * as React from "react";
import { cn } from "@/shared/lib/utils";
import { DataTable, DataTableHeader, DataTableBody, DataTableRow, DataTableCell } from "./DataTable";

export { DataTableHeader as ReorderableTableHeader, DataTableCell as ReorderableTableCell };

export const ReorderableTableBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    return (
      <DataTableBody
        ref={ref}
        className={cn("min-h-0 flex-1 overflow-y-auto", className)}
        {...props}
      />
    );
  },
);

ReorderableTableBody.displayName = "ReorderableTableBody";

export function ReorderableTable({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <DataTable className={cn("relative flex flex-col min-h-0", className)} {...props} />;
}

interface ReorderableRowProps extends React.HTMLAttributes<HTMLDivElement> {
  selected?: boolean;
  dragging?: boolean;
  dropTarget?: boolean;
}

export const ReorderableRow = React.memo(function ReorderableRow({
  className,
  selected,
  dragging,
  dropTarget,
  ...props
}: ReorderableRowProps) {
  return (
    <DataTableRow
      className={cn(
        "select-none",
        selected && "is-selected",
        dragging && "is-dragging",
        dropTarget && "reorder-drop-indicator",
        className,
      )}
      {...props}
    />
  );
});

export function ReorderHandle({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("reorder-handle", className)} {...props} />;
}
