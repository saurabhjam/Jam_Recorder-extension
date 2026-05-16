import React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight, Circle } from 'lucide-react';
import { cn } from '@utils/index';

export const Dropdown = DropdownMenu.Root;
export const DropdownTrigger = DropdownMenu.Trigger;
export const DropdownPortal = DropdownMenu.Portal;
export const DropdownSub = DropdownMenu.Sub;
export const DropdownSubTrigger = DropdownMenu.SubTrigger;
export const DropdownSubContent = DropdownMenu.SubContent;
export const DropdownGroup = DropdownMenu.Group;
export const DropdownRadioGroup = DropdownMenu.RadioGroup;
export const DropdownLabel = DropdownMenu.Label;

interface DropdownContentProps extends React.ComponentPropsWithoutRef<typeof DropdownMenu.Content> {
  className?: string;
}

export const DropdownContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenu.Content>,
  DropdownContentProps
>(({ className, sideOffset = 6, ...rest }, ref) => (
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 min-w-[160px] overflow-hidden rounded-xl',
        'bg-gray-900 border border-white/[0.08]',
        'shadow-[0_8px_32px_rgba(0,0,0,0.6)]',
        'animate-in fade-in-0 zoom-in-95',
        'data-[side=bottom]:slide-in-from-top-2',
        'data-[side=top]:slide-in-from-bottom-2',
        'p-1',
        className,
      )}
      {...rest}
    />
  </DropdownMenu.Portal>
));
DropdownContent.displayName = 'DropdownContent';

interface DropdownItemProps extends React.ComponentPropsWithoutRef<typeof DropdownMenu.Item> {
  className?: string;
  inset?: boolean;
  destructive?: boolean;
  icon?: React.ReactNode;
  shortcut?: string;
}

export const DropdownItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenu.Item>,
  DropdownItemProps
>(({ className, inset, destructive, icon, shortcut, children, ...rest }, ref) => (
  <DropdownMenu.Item
    ref={ref}
    className={cn(
      'relative flex cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 py-2',
      'text-sm outline-none transition-colors',
      destructive
        ? 'text-red-400 hover:bg-red-500/10 focus:bg-red-500/10'
        : 'text-gray-300 hover:bg-white/[0.06] focus:bg-white/[0.06] hover:text-gray-100 focus:text-gray-100',
      'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
      inset && 'pl-8',
      className,
    )}
    {...rest}
  >
    {icon && <span className="flex-shrink-0 text-gray-500">{icon}</span>}
    <span className="flex-1">{children}</span>
    {shortcut && <span className="ml-auto text-xs tracking-widest text-gray-600">{shortcut}</span>}
  </DropdownMenu.Item>
));
DropdownItem.displayName = 'DropdownItem';

export const DropdownSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenu.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenu.Separator>
>(({ className, ...rest }, ref) => (
  <DropdownMenu.Separator
    ref={ref}
    className={cn('my-1 h-px bg-white/[0.06]', className)}
    {...rest}
  />
));
DropdownSeparator.displayName = 'DropdownSeparator';
